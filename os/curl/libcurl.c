/*
 * libcurl.c — gucOS libcurl veneer (todos/0173): the easy interface over the
 * kernel HTTP transport (todos/0172; fd-shaped since todos/0417).
 *
 * curl_easy_perform maps 1:1 onto the primitive:
 *   __http_open -> an ordinary fd. Wait on it with __wait, consume the
 *   status with __http_status (feeds HEADERFUNCTION from the flattened
 *   header blob), then read() until EAGAIN / wait again (feeds
 *   WRITEFUNCTION), then close(fd).
 *
 * Timeouts (todos/0417):
 *   - CONNECTTIMEOUT[_MS] -> the kernel HEADERS deadline (__http_open's
 *     headers_ms): the response headers must arrive within it. Expiry
 *     surfaces as errno ETIMEDOUT on __http_status.
 *   - TIMEOUT[_MS] is a WHOLE-OPERATION cap, which neither kernel deadline
 *     expresses — the veneer enforces it on its own wall clock through
 *     __wait's timeout: wait with the remaining ms and treat a timeout
 *     wake (why = 0) as CURLE_OPERATION_TIMEDOUT.
 *   The kernel's default deadlines stay underneath, so a caller that sets
 *   no option is still bounded. The old SIGALRM/ITIMER_REAL apparatus is
 *   gone — nothing here parks uninterruptibly anymore.
 *
 * Documented divergences (also in curl.h):
 *   - redirects: transport follows silently; FOLLOWLOCATION/MAXREDIRS are
 *     accepted no-ops. EFFECTIVE_URL is truthful (#359): the transport
 *     surfaces the post-redirect final URL as a synthetic
 *     "x-guc-final-url" line in the header blob, which the veneer strips
 *     (never delivered to HEADERFUNCTION) and answers getinfo with.
 *     Intermediate hops stay unknowable — fetch follows opaquely.
 *   - header lines: synthesized "HTTP/1.1 NNN \r\n" status line, then the
 *     transport's flattened "name: value" lines (fetch order/casing) as
 *     "name: value\r\n", then "\r\n".
 *   - READFUNCTION is buffered: the whole request body is pulled from the
 *     callback up front, then staged (no upload streaming — descoped).
 *   - SSL_VERIFYPEER/VERIFYHOST/ACCEPT_ENCODING accepted, ignored (platform
 *     TLS, fetch decompression). NOSIGNAL accepted no-op.
 *   - XFERINFOFUNCTION/XFERINFODATA supported, gated on NOPROGRESS 0 (the
 *     curl contract): the callback runs at every transfer wait boundary —
 *     including an EINTR wake, which is how a signal handler's flag becomes
 *     visible mid-transfer — and a non-zero return aborts the transfer with
 *     CURLE_ABORTED_BY_CALLBACK (Ctrl+C on an in-flight response, #306).
 *   - descoped: multi interface, cookies, proxies, non-HTTP protocols,
 *     PROGRESSFUNCTION (the old double-based form; use XFERINFOFUNCTION).
 * Unknown options fail loud: CURLE_UNKNOWN_OPTION (+ a stderr line under
 * VERBOSE) — the kernel32 stub precedent.
 */
#include <curl/curl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <strings.h>
#include <errno.h>
#include <unistd.h>
#include <sys/time.h>

/* The kernel HTTP primitive (todos/0172, fd-shaped todos/0417), surfaced by
   host.js as env imports. Declared here like every consumer — there is NO
   prelude for these (#392 finding): the twin decls in compiler.js live
   inside the __SDL.c stdlib SOURCE (a separate TU that never calls them —
   dead text, tree-shaken, kept as the canonical contract comment), so no
   program sees them without its own declaration. Identical redeclaration
   is fine. Body drain is plain read(2), teardown is plain close(2). */
__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);
/* The error-TEXT peek (#392): the transfer's recorded failure text (the
   transport's own diagnostic — a CORS denial, a dead bridge, the fetch cause
   chain), NUL-terminated into buf. 0 while healthy; non-consuming; must run
   BEFORE close(fd) (close aborts and frees the transfer, text included).
   -1/ENOSYS on an embedder predating the op — degrade to errno-only text. */
__import int __http_error(int fd, char *buf, int cap);
/* The unified multi-source wait (todos/0178; wm.c precedent). why: 0 =
   timeout, 1 = an fd is readable, 2 = input ring, -1 = EINTR (the handler
   already ran), -2 = no kernel WAIT in this flavor. */
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

#define HDR_BLOB_CAP  (64 * 1024)   /* matches the kernel's flatten cap */
#define READ_CHUNK    49152         /* under the kernel page payload cap */

/* Big buffers are static — the wasm stack is the low 64KB. Single-threaded
   process model: perform() never runs concurrently. */
static char g_hdrblob[HDR_BLOB_CAP + 1];
static char g_rdbuf[READ_CHUNK];

typedef struct easy {
  /* options */
  char *url, *customrequest, *useragent;      /* owned copies */
  struct curl_slist *headers;                 /* caller-owned */
  const char *postfields;                     /* caller-owned (curl contract) */
  long postfieldsize;                         /* -1 = strlen(postfields) */
  int post, nobody, verbose;
  long timeout_ms, connecttimeout_ms;
  curl_write_callback write_cb, header_cb;
  void *write_data, *header_data;
  curl_read_callback read_cb;
  void *read_data;
  curl_xferinfo_callback xferinfo_cb;
  void *xferinfo_data;
  int noprogress;                             /* curl default 1: callback off */
  char *errorbuffer;                          /* caller-owned, CURL_ERROR_SIZE */
  /* results of the last perform */
  long response_code;
  char *effective_url;                        /* owned; post-redirect (#359) */
  char *content_type;                         /* owned */
  curl_off_t content_length;                  /* -1 unknown */
  curl_off_t size_download;
} easy;

static void easy_defaults(easy *h) {
  memset(h, 0, sizeof *h);
  h->postfieldsize = -1;
  h->content_length = -1;
  h->noprogress = 1;
}

static void easy_free_owned(easy *h) {
  free(h->url); free(h->customrequest); free(h->useragent);
  free(h->content_type); free(h->effective_url);
  h->url = h->customrequest = h->useragent = h->content_type = NULL;
  h->effective_url = NULL;
}

CURLcode curl_global_init(long flags) { (void)flags; return CURLE_OK; }
void curl_global_cleanup(void) {}

CURL *curl_easy_init(void) {
  easy *h = malloc(sizeof *h);
  if (!h) return NULL;
  easy_defaults(h);
  return h;
}

void curl_easy_reset(CURL *handle) {
  easy *h = handle;
  if (!h) return;
  easy_free_owned(h);
  easy_defaults(h);
}

void curl_easy_cleanup(CURL *handle) {
  easy *h = handle;
  if (!h) return;
  easy_free_owned(h);
  free(h);
}

static int set_owned(char **slot, const char *v) {
  free(*slot);
  *slot = v ? strdup(v) : NULL;
  return (v && !*slot) ? -1 : 0;
}

CURLcode curl_easy_setopt(CURL *handle, CURLoption option, ...) {
  easy *h = handle;
  if (!h) return CURLE_FAILED_INIT;
  va_list ap;
  va_start(ap, option);
  CURLcode rc = CURLE_OK;
  if (option >= 20000 && option < 30000) {          /* function pointers */
    void *fp = va_arg(ap, void *);
    switch (option) {
      case CURLOPT_WRITEFUNCTION:  h->write_cb = (curl_write_callback)fp; break;
      case CURLOPT_READFUNCTION:   h->read_cb = (curl_read_callback)fp; break;
      case CURLOPT_HEADERFUNCTION: h->header_cb = (curl_write_callback)fp; break;
      case CURLOPT_XFERINFOFUNCTION: h->xferinfo_cb = (curl_xferinfo_callback)fp; break;
      default: rc = CURLE_UNKNOWN_OPTION; break;
    }
  } else if (option >= 10000) {                     /* object pointers */
    void *p = va_arg(ap, void *);
    switch (option) {
      case CURLOPT_URL:           if (set_owned(&h->url, p)) rc = CURLE_OUT_OF_MEMORY; break;
      case CURLOPT_CUSTOMREQUEST: if (set_owned(&h->customrequest, p)) rc = CURLE_OUT_OF_MEMORY; break;
      case CURLOPT_USERAGENT:     if (set_owned(&h->useragent, p)) rc = CURLE_OUT_OF_MEMORY; break;
      case CURLOPT_HTTPHEADER:    h->headers = p; break;
      case CURLOPT_POSTFIELDS:    h->postfields = p; if (p) h->post = 1; break;
      case CURLOPT_WRITEDATA:     h->write_data = p; break;
      case CURLOPT_HEADERDATA:    h->header_data = p; break;
      case CURLOPT_READDATA:      h->read_data = p; break;
      case CURLOPT_PROGRESSDATA:  h->xferinfo_data = p; break;  /* = XFERINFODATA */
      case CURLOPT_ERRORBUFFER:   h->errorbuffer = p; break;
      case CURLOPT_ACCEPT_ENCODING: break;          /* fetch decompresses */
      default: rc = CURLE_UNKNOWN_OPTION; break;
    }
  } else {                                          /* longs */
    long v = va_arg(ap, long);
    switch (option) {
      case CURLOPT_POST:          h->post = (v != 0); break;
      case CURLOPT_HTTPGET:       if (v) { h->post = 0; h->nobody = 0; h->postfields = NULL; } break;
      case CURLOPT_NOBODY:        h->nobody = (v != 0); break;
      case CURLOPT_POSTFIELDSIZE: h->postfieldsize = v; break;
      case CURLOPT_VERBOSE:       h->verbose = (v != 0); break;
      case CURLOPT_TIMEOUT:       h->timeout_ms = v * 1000; break;
      case CURLOPT_TIMEOUT_MS:    h->timeout_ms = v; break;
      case CURLOPT_CONNECTTIMEOUT:    h->connecttimeout_ms = v * 1000; break;
      case CURLOPT_CONNECTTIMEOUT_MS: h->connecttimeout_ms = v; break;
      case CURLOPT_NOPROGRESS:    h->noprogress = (v != 0); break;
      case CURLOPT_FOLLOWLOCATION:    /* transport follows silently */
      case CURLOPT_MAXREDIRS:
      case CURLOPT_NOSIGNAL:
      case CURLOPT_SSL_VERIFYPEER:    /* platform TLS — not configurable */
      case CURLOPT_SSL_VERIFYHOST:
        break;
      default: rc = CURLE_UNKNOWN_OPTION; break;
    }
  }
  va_end(ap);
  if (rc == CURLE_UNKNOWN_OPTION && h->verbose)
    fprintf(stderr, "* gucOS libcurl: unknown/unsupported option %d\n", (int)option);
  return rc;
}

/* ---- timeout plumbing: the veneer's wall clock ------------------------- */
static long long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, 0);
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

/* One WAIT-first step against the whole-operation deadline: park on the fd
   until it is readable, the deadline passes, or a signal lands (EINTR —
   the handler ran; re-check the clock and re-park). Returns 0 to retry the
   consume, -1 when the total deadline has passed, -2 when no kernel WAIT
   exists in this flavor (fail loud — never a poll loop). */
static int wait_step(int fd, long long total_deadline) {
  int timeout_ms = -1;
  if (total_deadline > 0) {
    long long remain = total_deadline - now_ms();
    if (remain <= 0) return -1;
    timeout_ms = (int)remain;
  }
  int why = __wait(&fd, 1, 0, timeout_ms);
  if (why == 0) return -1;                    /* the total deadline passed */
  if (why == -2) return -2;                   /* no unified WAIT here */
  return 0;                                   /* readable or EINTR: retry */
}

/* Progress gate (NOPROGRESS 0 + a registered XFERINFOFUNCTION): real curl
   drives the callback from its transfer loop; this veneer's loop parks in
   wait_step, so every wait boundary — including an EINTR wake, which is how
   a signal handler's flag (gcode's g_interrupted) becomes visible mid-
   transfer — asks the callback whether to continue. Non-zero return means
   abort (#306). */
static int check_progress(easy *h) {
  if (h->noprogress || !h->xferinfo_cb) return 0;
  curl_off_t dltotal = h->content_length > 0 ? h->content_length : 0;
  return h->xferinfo_cb(h->xferinfo_data, dltotal, h->size_download, 0, 0) != 0;
}

/* ---- error helper ------------------------------------------------------- */
static CURLcode fail(easy *h, CURLcode code, const char *msg) {
  if (h->errorbuffer) {
    strncpy(h->errorbuffer, msg ? msg : curl_easy_strerror(code), CURL_ERROR_SIZE - 1);
    h->errorbuffer[CURL_ERROR_SIZE - 1] = 0;
  }
  if (h->verbose) fprintf(stderr, "* gucOS libcurl: %s\n", msg ? msg : curl_easy_strerror(code));
  return code;
}

/* Transport failure on a LIVE fd (#392). Before this, everything but
   ETIMEDOUT collapsed to CURLE_COULDNT_CONNECT / "connection failed", so a
   CORS denial, a bridge policy refusal and a dead bridge all read "Couldn't
   connect to server". Two fixes in one place: the errno picks a DISTINCT
   code, and the transport's own error text (via __http_error — fetched
   FIRST: the caller closes the fd right after, which frees the transfer)
   becomes the message. reading_body selects the post-headers vocabulary.
   The caller still owns close(fd). */
static CURLcode fail_transport(easy *h, int fd, int serrno, int reading_body) {
  static char text[CURL_ERROR_SIZE];   /* single-threaded, the g_hdrblob rule */
  text[0] = 0;
  int tn = __http_error(fd, text, (int)sizeof text);
  CURLcode code;
  const char *what;
  switch (serrno) {
    case ETIMEDOUT:
      code = CURLE_OPERATION_TIMEDOUT;
      what = reading_body ? "timed out reading body" : "timed out waiting for response";
      break;
    case ENETUNREACH:                  /* bridge configured but unreachable (#349) */
      code = CURLE_COULDNT_CONNECT;
      what = "network unreachable";
      break;
    case EACCES:                       /* bridge policy refusal (NETWORK.md Tier 2.5) */
      code = CURLE_REMOTE_ACCESS_DENIED;
      what = "access denied";
      break;
    case EINVAL:                       /* wrapper rejected the target URL itself */
      code = CURLE_URL_MALFORMAT;
      what = "bad URL";
      break;
    default:
      code = reading_body ? CURLE_RECV_ERROR : CURLE_COULDNT_CONNECT;
      what = reading_body ? "body read failed" : "connection failed";
      break;
  }
  char msg[CURL_ERROR_SIZE];
  if (tn > 0 && text[0])
    snprintf(msg, sizeof msg, "%s: %s", what, text);
  else
    snprintf(msg, sizeof msg, "%s (%s)", what, strerror(serrno));
  return fail(h, code, msg);
}

/* Feed one synthesized header line to the header sink. No HEADERFUNCTION
   but a HEADERDATA -> fwrite to it as a FILE* (real curl's default). */
static int emit_header(easy *h, const char *line, size_t len) {
  if (h->header_cb) {
    if (h->header_cb((char *)line, 1, len, h->header_data) != len) return -1;
  } else if (h->header_data) {
    if (fwrite(line, 1, len, (FILE *)h->header_data) != len) return -1;
  }
  return 0;
}

static int emit_body(easy *h, const char *buf, size_t len) {
  if (h->write_cb) {
    if (h->write_cb((char *)buf, 1, len, h->write_data) != len) return -1;
  } else {
    FILE *f = h->write_data ? (FILE *)h->write_data : stdout;
    if (fwrite(buf, 1, len, f) != len) return -1;
  }
  return 0;
}

CURLcode curl_easy_perform(CURL *handle) {
  easy *h = handle;
  if (!h) return CURLE_FAILED_INIT;
  if (!h->url || !*h->url) return fail(h, CURLE_URL_MALFORMAT, "no URL set");
  if (h->errorbuffer) h->errorbuffer[0] = 0;
  h->response_code = 0;
  free(h->effective_url); h->effective_url = NULL;
  free(h->content_type); h->content_type = NULL;
  h->content_length = -1;
  h->size_download = 0;

  /* method */
  const char *method = h->customrequest ? h->customrequest
                     : h->nobody       ? "HEAD"
                     : (h->post || h->postfields || h->read_cb) ? "POST"
                     : "GET";

  /* request headers: slist lines joined by \n (the transport contract),
     plus a best-effort User-Agent when none was given explicitly */
  size_t hlen = 0;
  struct curl_slist *sl;
  for (sl = h->headers; sl; sl = sl->next) hlen += strlen(sl->data) + 1;
  int have_ua = 0;
  for (sl = h->headers; sl; sl = sl->next)
    if (!strncasecmp(sl->data, "user-agent:", 11)) { have_ua = 1; break; }
  if (h->useragent && !have_ua) hlen += 12 + strlen(h->useragent) + 1;
  char *hdrs = malloc(hlen + 1);
  if (!hdrs) return fail(h, CURLE_OUT_OF_MEMORY, "header alloc failed");
  hdrs[0] = 0;
  {
    char *w = hdrs;
    for (sl = h->headers; sl; sl = sl->next) {
      size_t n = strlen(sl->data);
      memcpy(w, sl->data, n); w += n; *w++ = '\n';
    }
    if (h->useragent && !have_ua)
      w += sprintf(w, "User-Agent: %s\n", h->useragent);
    *w = 0;
  }

  /* request body: POSTFIELDS wins; else pull the whole thing from
     READFUNCTION (buffered — no upload streaming, documented) */
  const char *body = NULL;
  char *rbody = NULL;
  long blen = 0;
  if (h->postfields && !h->nobody) {
    body = h->postfields;
    blen = h->postfieldsize >= 0 ? h->postfieldsize : (long)strlen(h->postfields);
  } else if (h->read_cb && h->post && !h->nobody) {
    long cap = h->postfieldsize >= 0 ? h->postfieldsize : -1;
    size_t rcap = 4096, rlen = 0;
    rbody = malloc(rcap);
    if (!rbody) { free(hdrs); return fail(h, CURLE_OUT_OF_MEMORY, "body alloc failed"); }
    for (;;) {
      if (cap >= 0 && (long)rlen >= cap) break;
      if (rlen + 4096 > rcap) {
        rcap *= 2;
        char *nr = realloc(rbody, rcap);
        if (!nr) { free(rbody); free(hdrs); return fail(h, CURLE_OUT_OF_MEMORY, "body alloc failed"); }
        rbody = nr;
      }
      size_t want = 4096;
      if (cap >= 0 && (size_t)(cap - (long)rlen) < want) want = (size_t)(cap - (long)rlen);
      size_t n = h->read_cb(rbody + rlen, 1, want, h->read_data);
      if (n == 0) break;
      if (n > want) { free(rbody); free(hdrs); return fail(h, CURLE_READ_ERROR, "read callback overran"); }
      rlen += n;
    }
    body = rbody; blen = (long)rlen;
  }

  if (h->verbose)
    fprintf(stderr, "* gucOS libcurl: %s %s (%ld body bytes)\n", method, h->url, blen);

  /* timeouts (todos/0417): CONNECTTIMEOUT rides the kernel headers
     deadline; TIMEOUT is the whole-operation cap on the veneer's own wall
     clock, enforced through __wait's timeout at every park. */
  long long t0 = now_ms();
  long long total_deadline = h->timeout_ms > 0 ? t0 + h->timeout_ms : 0;
  int headers_ms = h->connecttimeout_ms > 0 ? (int)h->connecttimeout_ms : 0;

  int fd = __http_open(method, h->url, hdrs, body, (int)blen, headers_ms, 0);
  free(hdrs); free(rbody);
  if (fd < 0) {
    if (errno == ENOSYS) return fail(h, CURLE_UNSUPPORTED_PROTOCOL, "no network transport (fetch disabled)");
    /* No fd, so no __http_error channel — these are local staging errors;
       the errno text is the whole story (#392). */
    char omsg[CURL_ERROR_SIZE];
    snprintf(omsg, sizeof omsg, "could not open transfer (%s)", strerror(errno));
    return fail(h, CURLE_COULDNT_CONNECT, omsg);
  }

  /* status + headers: WAIT on the fd, consume the status when it lands */
  int status = 0, hl;
  for (;;) {
    hl = __http_status(fd, &status, g_hdrblob, HDR_BLOB_CAP);
    if (hl >= 0) break;
    if (errno == EAGAIN || errno == EINTR) {
      if (check_progress(h)) { close(fd);
        return fail(h, CURLE_ABORTED_BY_CALLBACK, "aborted by progress callback"); }
      int ws = wait_step(fd, total_deadline);
      if (ws == 0) continue;
      close(fd);
      if (ws == -1) return fail(h, CURLE_OPERATION_TIMEDOUT, "timed out waiting for response");
      return fail(h, CURLE_COULDNT_CONNECT, "no kernel wait (__wait unsupported in this flavor)");
    }
    int serrno = errno;
    CURLcode fc = fail_transport(h, fd, serrno, 0);   /* reads the text; close frees it */
    close(fd);
    return fc;
  }
  int copied = hl < HDR_BLOB_CAP ? hl : HDR_BLOB_CAP;
  g_hdrblob[copied] = 0;
  h->response_code = status;

  /* synthesize curl-shaped header lines: status line, then each blob line
     as "name: value\r\n", then the blank terminator */
  {
    char sline[64];
    int sn = snprintf(sline, sizeof sline, "HTTP/1.1 %d \r\n", status);
    if (emit_header(h, sline, (size_t)sn)) { close(fd);
      return fail(h, CURLE_WRITE_ERROR, "header callback aborted"); }
    char *p = g_hdrblob;
    while (*p) {
      char *nl = strchr(p, '\n');
      size_t ll = nl ? (size_t)(nl - p) : strlen(p);
      /* The transport's synthetic final-URL line (#359): capture for
         CURLINFO_EFFECTIVE_URL and STRIP — a consumer must never observe
         a header no server sent. */
      if (ll > 16 && !strncasecmp(p, "x-guc-final-url:", 16)) {
        const char *v = p + 16;
        size_t vl = ll - 16;
        while (vl && (*v == ' ' || *v == '\t')) { v++; vl--; }
        free(h->effective_url);
        h->effective_url = malloc(vl + 1);
        if (h->effective_url) { memcpy(h->effective_url, v, vl); h->effective_url[vl] = 0; }
        if (!nl) break;
        p = nl + 1;
        continue;
      }
      /* getinfo capture */
      if (ll > 13 && !strncasecmp(p, "content-type:", 13)) {
        const char *v = p + 13;
        size_t vl = ll - 13;
        while (vl && (*v == ' ' || *v == '\t')) { v++; vl--; }
        free(h->content_type);
        h->content_type = malloc(vl + 1);
        if (h->content_type) { memcpy(h->content_type, v, vl); h->content_type[vl] = 0; }
      } else if (ll > 15 && !strncasecmp(p, "content-length:", 15)) {
        h->content_length = atoll(p + 15);
      }
      /* emit with CRLF */
      char line[1024];
      size_t el = ll < sizeof line - 3 ? ll : sizeof line - 3;
      memcpy(line, p, el); line[el] = '\r'; line[el + 1] = '\n';
      if (emit_header(h, line, el + 2)) { close(fd);
        return fail(h, CURLE_WRITE_ERROR, "header callback aborted"); }
      if (!nl) break;
      p = nl + 1;
    }
    if (emit_header(h, "\r\n", 2)) { close(fd);
      return fail(h, CURLE_WRITE_ERROR, "header callback aborted"); }
  }

  /* body: WAIT-first drain through WRITEFUNCTION until clean EOF */
  CURLcode rc = CURLE_OK;
  for (;;) {
    int n = (int)read(fd, g_rdbuf, READ_CHUNK);
    if (n > 0) {
      if (emit_body(h, g_rdbuf, (size_t)n)) { rc = fail(h, CURLE_WRITE_ERROR, "write callback aborted"); break; }
      h->size_download += n;
      continue;
    }
    if (n == 0) break;                             /* clean EOF */
    if (errno == EAGAIN || errno == EINTR) {
      if (check_progress(h)) { rc = fail(h, CURLE_ABORTED_BY_CALLBACK, "aborted by progress callback"); break; }
      int ws = wait_step(fd, total_deadline);
      if (ws == 0) continue;
      rc = ws == -1 ? fail(h, CURLE_OPERATION_TIMEDOUT, "timed out reading body")
                    : fail(h, CURLE_RECV_ERROR, "no kernel wait (__wait unsupported in this flavor)");
      break;
    }
    rc = fail_transport(h, fd, errno, 1);   /* the loop exit's close(fd) frees it */
    break;
  }
  close(fd);
  if (rc == CURLE_OK && h->verbose)
    fprintf(stderr, "* gucOS libcurl: %d, %ld body bytes\n", status, (long)h->size_download);
  return rc;
}

CURLcode curl_easy_getinfo(CURL *handle, CURLINFO info, ...) {
  easy *h = handle;
  if (!h) return CURLE_FAILED_INIT;
  va_list ap;
  va_start(ap, info);
  CURLcode rc = CURLE_OK;
  switch (info) {
    case CURLINFO_RESPONSE_CODE:
      *va_arg(ap, long *) = h->response_code; break;
    case CURLINFO_CONTENT_TYPE:
      *va_arg(ap, char **) = h->content_type; break;
    case CURLINFO_EFFECTIVE_URL:                    /* post-redirect (#359) */
      *va_arg(ap, char **) = h->effective_url ? h->effective_url
                           : (h->url ? h->url : ""); break;
    case CURLINFO_SIZE_DOWNLOAD_T:
      *va_arg(ap, curl_off_t *) = h->size_download; break;
    case CURLINFO_CONTENT_LENGTH_DOWNLOAD_T:
      *va_arg(ap, curl_off_t *) = h->content_length; break;
    default:
      rc = CURLE_UNKNOWN_OPTION;
      if (h->verbose) fprintf(stderr, "* gucOS libcurl: unknown getinfo %d\n", (int)info);
      break;
  }
  va_end(ap);
  return rc;
}

const char *curl_easy_strerror(CURLcode code) {
  switch (code) {
    case CURLE_OK:                   return "No error";
    case CURLE_UNSUPPORTED_PROTOCOL: return "Unsupported protocol";
    case CURLE_FAILED_INIT:          return "Failed initialization";
    case CURLE_URL_MALFORMAT:        return "URL using bad/illegal format or missing URL";
    case CURLE_COULDNT_RESOLVE_HOST: return "Couldn't resolve host name";
    case CURLE_COULDNT_CONNECT:      return "Couldn't connect to server";
    case CURLE_REMOTE_ACCESS_DENIED: return "Access denied to remote resource";
    case CURLE_HTTP_RETURNED_ERROR:  return "HTTP response code said error";
    case CURLE_ABORTED_BY_CALLBACK:  return "Operation was aborted by an application callback";
    case CURLE_WRITE_ERROR:          return "Failed writing received data to disk/application";
    case CURLE_READ_ERROR:           return "Failed to open/read local data from file/application";
    case CURLE_OUT_OF_MEMORY:        return "Out of memory";
    case CURLE_OPERATION_TIMEDOUT:   return "Timeout was reached";
    case CURLE_UNKNOWN_OPTION:       return "An unknown option was passed in to libcurl";
    case CURLE_RECV_ERROR:           return "Failure when receiving data from the peer";
    default:                         return "Unknown error";
  }
}

/* ---- curl_slist --------------------------------------------------------- */
struct curl_slist *curl_slist_append(struct curl_slist *list, const char *data) {
  struct curl_slist *node = malloc(sizeof *node);
  if (!node) return NULL;
  node->data = strdup(data ? data : "");
  node->next = NULL;
  if (!node->data) { free(node); return NULL; }
  if (!list) return node;
  struct curl_slist *t = list;
  while (t->next) t = t->next;
  t->next = node;
  return list;
}

void curl_slist_free_all(struct curl_slist *list) {
  while (list) {
    struct curl_slist *n = list->next;
    free(list->data);
    free(list);
    list = n;
  }
}

/* ---- escape / unescape --------------------------------------------------- */
static int is_unreserved(unsigned char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
}

char *curl_easy_escape(CURL *handle, const char *string, int length) {
  (void)handle;
  if (!string) return NULL;
  size_t n = length > 0 ? (size_t)length : strlen(string);
  char *out = malloc(n * 3 + 1);
  if (!out) return NULL;
  char *w = out;
  static const char hexd[] = "0123456789ABCDEF";
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)string[i];
    if (is_unreserved(c)) *w++ = (char)c;
    else { *w++ = '%'; *w++ = hexd[c >> 4]; *w++ = hexd[c & 15]; }
  }
  *w = 0;
  return out;
}

static int hexval(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

char *curl_easy_unescape(CURL *handle, const char *input, int length, int *outlength) {
  (void)handle;
  if (!input) return NULL;
  size_t n = length > 0 ? (size_t)length : strlen(input);
  char *out = malloc(n + 1);
  if (!out) return NULL;
  char *w = out;
  for (size_t i = 0; i < n; i++) {
    if (input[i] == '%' && i + 2 < n
        && hexval((unsigned char)input[i + 1]) >= 0
        && hexval((unsigned char)input[i + 2]) >= 0) {
      *w++ = (char)(hexval((unsigned char)input[i + 1]) * 16 + hexval((unsigned char)input[i + 2]));
      i += 2;
    } else {
      *w++ = input[i];
    }
  }
  *w = 0;
  if (outlength) *outlength = (int)(w - out);
  return out;
}

void curl_free(void *ptr) { free(ptr); }

const char *curl_version(void) { return "libcurl/8.0.0-gucos (todos/0173 veneer)"; }
