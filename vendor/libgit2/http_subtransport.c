/* http_subtransport.c — the gucOS smart-HTTP subtransport (ticket #478).
 *
 * libgit2's builtin transport table (src/libgit2/transports/transport.c) routes
 * http:// and https:// to git_transport_smart over a definition whose stream
 * factory is git_smart_subtransport_http — the function this file provides.
 * The smart protocol machinery (smart.c / smart_pkt.c / smart_protocol.c) is
 * compiled in and does all the talking; this file only moves its bytes over
 * the kernel's Tier 2 HTTP transport (todos/0172, fd-shaped todos/0417):
 *
 *   __http_open -> an ordinary fd. __wait on it, consume the status with
 *   __http_status, then read(2) until 0 (EOF) / EAGAIN (WAIT again),
 *   close(2) to abort or finish — the same WAIT-first discipline as
 *   os/curl/libcurl.c, the transport's reference consumer.
 *
 * The subtransport is registered rpc=1 (stateless): every action() stream is
 * exactly one HTTP request —
 *   UPLOADPACK_LS   GET  <base>/info/refs?service=git-upload-pack
 *   UPLOADPACK      POST <base>/git-upload-pack
 *   RECEIVEPACK_LS  GET  <base>/info/refs?service=git-receive-pack
 *   RECEIVEPACK     POST <base>/git-receive-pack
 * write() buffers the request body (the platform fetch cannot stream request
 * bodies, so a POST is assembled whole — the same documented posture as the
 * curl veneer's READFUNCTION); the first read() performs the request and then
 * STREAMS the response through the kernel's backpressured fd, so a multi-MB
 * clone never sits fully in process memory.
 *
 * Redirects: the platform fetch follows them opaquely; the kernel surfaces the
 * post-redirect FINAL URL as the synthetic `x-guc-final-url` header line
 * (#359). When an info/refs response lands somewhere else, the base URL is
 * re-derived from the final URL so the follow-up POST goes where the server
 * said (github.com's http->https and trailing-.git redirects).
 *
 * Auth: HTTP Basic only — TLS is the platform's, and Basic-over-https is what
 * every token-authed git host speaks. Credentials come from (in order) the
 * URL's own userinfo, then the owner transport's credential callback
 * (git_transport_smart_credentials -> the CLI's callback; ticket rule: the
 * value is read in-process and never logged). A 401 retries with fresh
 *  credentials up to 3 times, then fails GIT_EAUTH.
 */

#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdio.h>
#include <errno.h>
#include <unistd.h>

#include "git2.h"
#include "git2/credential.h"
#include "git2/sys/transport.h"
#include "git2/sys/errors.h"

/* The kernel HTTP primitive + unified wait (todos/0172/0417/0178), surfaced
   by host.js as env imports — declared here like any other consumer. */
__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

#define HDR_BLOB_CAP   (64 * 1024)   /* matches the kernel's flatten cap */
#define READ_CHUNK_CAP 49152         /* stay under the kernel RPC payload cap */
#define AUTH_ATTEMPTS  3

typedef struct {
  const char *ls_suffix;     /* GET path + query, appended to base */
  const char *rpc_suffix;    /* POST path, appended to base */
  const char *svc;           /* protocol service name */
} service_info;

static const service_info UPLOAD_INFO = {
  "/info/refs?service=git-upload-pack", "/git-upload-pack", "git-upload-pack",
};
static const service_info RECEIVE_INFO = {
  "/info/refs?service=git-receive-pack", "/git-receive-pack", "git-receive-pack",
};

/* ---- tiny grow buffer (public-header-only file: no git_str) ---- */
typedef struct { char *p; size_t len, cap; } buf_t;

static int buf_put(buf_t *b, const char *data, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t nc = b->cap ? b->cap : 256;
    while (nc < b->len + n + 1) nc *= 2;
    char *np = realloc(b->p, nc);
    if (!np) return -1;
    b->p = np; b->cap = nc;
  }
  memcpy(b->p + b->len, data, n);
  b->len += n;
  b->p[b->len] = 0;
  return 0;
}
static int buf_puts(buf_t *b, const char *s) { return buf_put(b, s, strlen(s)); }
static void buf_free(buf_t *b) { free(b->p); b->p = NULL; b->len = b->cap = 0; }

static int b64_put(buf_t *b, const char *data, size_t n) {
  static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  char q[4];
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned char)data[i] << 16;
    if (i + 1 < n) v |= (unsigned char)data[i + 1] << 8;
    if (i + 2 < n) v |= (unsigned char)data[i + 2];
    q[0] = T[(v >> 18) & 63];
    q[1] = T[(v >> 12) & 63];
    q[2] = i + 1 < n ? T[(v >> 6) & 63] : '=';
    q[3] = i + 2 < n ? T[v & 63] : '=';
    if (buf_put(b, q, 4) < 0) return -1;
  }
  return 0;
}

static int hexval(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Percent-decode a userinfo span into a fresh string. */
static char *pct_decode(const char *s, size_t n) {
  char *out = malloc(n + 1), *w = out;
  if (!out) return NULL;
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '%' && i + 2 < n && hexval(s[i + 1]) >= 0 && hexval(s[i + 2]) >= 0) {
      *w++ = (char)(hexval(s[i + 1]) * 16 + hexval(s[i + 2]));
      i += 2;
    } else *w++ = s[i];
  }
  *w = 0;
  return out;
}

typedef struct gucos_http_subtransport gucos_http_subtransport;

typedef struct {
  git_smart_subtransport_stream parent;
  gucos_http_subtransport *t;
  const service_info *info;
  int is_post;
  buf_t body;                /* buffered request body (write() collects) */
  int fd;                    /* kernel http fd; -1 until performed */
  int eof;
} http_stream;

struct gucos_http_subtransport {
  git_smart_subtransport parent;
  git_transport *owner;
  char *base;                /* current base URL, userinfo-stripped */
  char *user, *pass;         /* URL-embedded credentials, if any */
  git_credential *cred;      /* callback-provided credentials, if any */
  int auth_attempts;
};

/* Parse the action URL: strip any userinfo into t->user/t->pass and store the
 * clean base (platform fetch REJECTS URLs with embedded credentials, so they
 * must never reach __http_open). Also strips trailing slashes. */
static int set_base_url(gucos_http_subtransport *t, const char *url) {
  const char *scheme_end = strstr(url, "://");
  if (!scheme_end || (strncmp(url, "http://", 7) && strncmp(url, "https://", 8))) {
    git_error_set(GIT_ERROR_NET, "unsupported URL '%s' (http:// and https:// only)", url);
    return -1;
  }
  const char *host = scheme_end + 3;
  const char *path = strchr(host, '/');
  const char *at = NULL;
  for (const char *p = host; *p && (!path || p < path); p++)
    if (*p == '@') at = p;
  free(t->base); t->base = NULL;
  if (at) {
    const char *colon = memchr(host, ':', (size_t)(at - host));
    free(t->user); free(t->pass);
    t->user = pct_decode(host, colon ? (size_t)(colon - host) : (size_t)(at - host));
    t->pass = colon ? pct_decode(colon + 1, (size_t)(at - colon - 1)) : NULL;
    if (!t->user || (colon && !t->pass)) return -1;
    buf_t b = { 0 };
    if (buf_put(&b, url, (size_t)(host - url)) < 0 || buf_puts(&b, at + 1) < 0) {
      buf_free(&b);
      return -1;
    }
    t->base = b.p;   /* ownership moves */
  } else {
    t->base = strdup(url);
    if (!t->base) return -1;
  }
  size_t n = strlen(t->base);
  while (n > 0 && t->base[n - 1] == '/') t->base[--n] = 0;
  return 0;
}

/* One WAIT-first park on the fd (the libcurl.c wait_step shape): 0 = retry
 * the consume, -1 = no unified WAIT in this flavor. Kernel deadlines bound
 * the transfer, so an infinite timeout here cannot hang past them. */
static int wait_fd(int fd) {
  int why = __wait(&fd, 1, 0, -1);
  if (why == -2) {
    git_error_set(GIT_ERROR_NET, "no kernel wait (__wait unsupported in this flavor)");
    return -1;
  }
  return 0;   /* readable, EINTR (handler ran) or timeout: retry */
}

/* Find a header VALUE in the kernel's flattened "name: value\n" blob.
 * Returns a malloc'd copy or NULL. Case-insensitive names. */
static char *blob_header(const char *blob, const char *name) {
  size_t nl = strlen(name);
  for (const char *p = blob; *p; ) {
    const char *eol = strchr(p, '\n');
    size_t ll = eol ? (size_t)(eol - p) : strlen(p);
    if (ll > nl + 1 && p[nl] == ':' && !strncasecmp(p, name, nl)) {
      const char *v = p + nl + 1;
      size_t vl = ll - nl - 1;
      while (vl && (*v == ' ' || *v == '\t')) { v++; vl--; }
      char *out = malloc(vl + 1);
      if (out) { memcpy(out, v, vl); out[vl] = 0; }
      return out;
    }
    if (!eol) break;
    p = eol + 1;
  }
  return NULL;
}

/* The Authorization header line for the currently-held credentials, or an
 * empty buf when none are held. The value is used, never printed. */
static int auth_header(gucos_http_subtransport *t, buf_t *out) {
  const char *user = NULL, *pass = NULL;
  if (t->cred && t->cred->credtype == GIT_CREDENTIAL_USERPASS_PLAINTEXT) {
    git_credential_userpass_plaintext *c = (git_credential_userpass_plaintext *)t->cred;
    user = c->username; pass = c->password;
  } else if (t->user) {
    user = t->user; pass = t->pass ? t->pass : "";
  }
  if (!user) return 0;
  buf_t up = { 0 };
  int rc = -1;
  if (buf_puts(&up, user) == 0 && buf_puts(&up, ":") == 0 && buf_puts(&up, pass) == 0
      && buf_puts(out, "Authorization: Basic ") == 0
      && b64_put(out, up.p, up.len) == 0
      && buf_puts(out, "\n") == 0)
    rc = 0;
  buf_free(&up);
  return rc;
}

/* A 401 landed: get (fresh) credentials or fail GIT_EAUTH. URL userinfo is
 * attempt #1; after that the owner's credential callback is asked. */
static int acquire_credentials(gucos_http_subtransport *t) {
  if (++t->auth_attempts >= AUTH_ATTEMPTS) {
    git_error_set(GIT_ERROR_HTTP, "too many authentication failures");
    return GIT_EAUTH;
  }
  if (t->user && t->auth_attempts == 1)
    return 0;                              /* try the URL's own userinfo first */
  git_credential *cred = NULL;
  int rc = git_transport_smart_credentials(&cred, t->owner, t->user,
                                           GIT_CREDENTIAL_USERPASS_PLAINTEXT);
  if (rc == GIT_PASSTHROUGH || (rc == 0 && !cred)) {
    git_error_set(GIT_ERROR_HTTP,
      "authentication required but no credentials are available "
      "(add them to ~/.git-credentials, or embed them in the remote URL)");
    return GIT_EAUTH;
  }
  if (rc < 0)
    return rc;                             /* the callback set the error */
  if (cred->credtype != GIT_CREDENTIAL_USERPASS_PLAINTEXT) {
    git_credential_free(cred);
    git_error_set(GIT_ERROR_HTTP, "unsupported credential type (Basic auth needs userpass)");
    return -1;
  }
  if (t->cred) git_credential_free(t->cred);
  t->cred = cred;
  return 0;
}

/* Issue the stream's HTTP request and consume the response status + headers.
 * Loops over 401s acquiring credentials. On success s->fd is the readable
 * body fd. */
static int http_perform(http_stream *s) {
  gucos_http_subtransport *t = s->t;
  char *hdrblob = malloc(HDR_BLOB_CAP + 1);
  if (!hdrblob) return -1;

  for (;;) {
    /* request URL */
    buf_t url = { 0 };
    const char *suffix = s->is_post ? s->info->rpc_suffix : s->info->ls_suffix;
    if (buf_puts(&url, t->base) < 0 || buf_puts(&url, suffix) < 0) {
      buf_free(&url); free(hdrblob); return -1;
    }

    /* request headers */
    buf_t hdrs = { 0 };
    int hrc = buf_puts(&hdrs, "User-Agent: git/2.0 (gucOS libgit2 " LIBGIT2_VERSION ")\n");
    if (hrc == 0 && s->is_post) {
      hrc = buf_puts(&hdrs, "Content-Type: application/x-");
      if (hrc == 0) hrc = buf_puts(&hdrs, s->info->svc);
      if (hrc == 0) hrc = buf_puts(&hdrs, "-request\n");
    }
    if (hrc == 0) hrc = buf_puts(&hdrs, "Accept: application/x-");
    if (hrc == 0) hrc = buf_puts(&hdrs, s->info->svc);
    if (hrc == 0) hrc = buf_puts(&hdrs, s->is_post ? "-result\n" : "-advertisement\n");
    if (hrc == 0) hrc = auth_header(t, &hdrs);
    if (hrc < 0) { buf_free(&url); buf_free(&hdrs); free(hdrblob); return -1; }

    int fd = __http_open(s->is_post ? "POST" : "GET", url.p, hdrs.p,
                         s->body.p, (int)s->body.len, 0, 0);
    buf_free(&url); buf_free(&hdrs);
    if (fd < 0) {
      git_error_set(GIT_ERROR_NET, errno == ENOSYS
        ? "no network transport (fetch disabled in this kernel)"
        : "could not open HTTP transfer");
      free(hdrblob);
      return -1;
    }

    /* status + headers: WAIT-first consume */
    int status = 0, hl;
    for (;;) {
      hl = __http_status(fd, &status, hdrblob, HDR_BLOB_CAP);
      if (hl >= 0) break;
      if (errno == EAGAIN || errno == EINTR) {
        if (wait_fd(fd) == 0) continue;
        close(fd); free(hdrblob); return -1;
      }
      git_error_set(GIT_ERROR_NET, errno == ETIMEDOUT
        ? "timed out waiting for the HTTP response"
        : "HTTP transfer failed");
      close(fd); free(hdrblob);
      return -1;
    }
    hdrblob[hl < HDR_BLOB_CAP ? hl : HDR_BLOB_CAP] = 0;

    if (status == 401 || status == 407) {
      close(fd);
      int arc = acquire_credentials(t);
      if (arc != 0) { free(hdrblob); return arc; }
      continue;                            /* retry with credentials */
    }
    if (status == 404) {
      close(fd);
      git_error_set(GIT_ERROR_NET, "remote repository not found (HTTP 404)");
      free(hdrblob);
      return -1;
    }
    if (status != 200) {
      close(fd);
      git_error_set(GIT_ERROR_NET, "unexpected HTTP status %d", status);
      free(hdrblob);
      return -1;
    }

    /* Content-type validation: a smart server names the service; anything
     * else (text/plain, text/html) is the dumb protocol or not git at all. */
    {
      char *ct = blob_header(hdrblob, "content-type");
      buf_t want = { 0 };
      int ok = buf_puts(&want, "application/x-") == 0
            && buf_puts(&want, s->info->svc) == 0
            && buf_puts(&want, s->is_post ? "-result" : "-advertisement") == 0;
      if (!ok) { free(ct); buf_free(&want); close(fd); free(hdrblob); return -1; }
      if (!ct || strncmp(ct, want.p, want.len)) {
        git_error_set(GIT_ERROR_NET,
          "server does not speak the smart git protocol (content-type '%s', expected '%s')",
          ct ? ct : "<none>", want.p);
        free(ct); buf_free(&want); close(fd); free(hdrblob);
        return -1;
      }
      free(ct); buf_free(&want);
    }

    /* Redirect re-base (#359): the kernel's synthetic x-guc-final-url line
     * names where the response REALLY came from. When an info/refs GET
     * landed elsewhere, later POSTs must go to the new base. */
    if (!s->is_post) {
      char *fin = blob_header(hdrblob, "x-guc-final-url");
      if (fin && *fin) {
        const char *suf = s->info->ls_suffix;
        size_t fl = strlen(fin), sl = strlen(suf);
        size_t cut = 0;
        if (fl > sl && !strcmp(fin + fl - sl, suf)) cut = sl;
        else {   /* some servers drop the query on redirect */
          const char *q = strchr(suf, '?');
          size_t pl = q ? (size_t)(q - suf) : sl;
          if (fl > pl && !strncmp(fin + fl - pl, suf, pl)) cut = pl;
        }
        if (cut) {
          fin[fl - cut] = 0;
          if (strcmp(fin, t->base)) {
            char *nb = strdup(fin);
            if (nb) { free(t->base); t->base = nb; }
          }
        }
      }
      free(fin);
    }

    s->fd = fd;
    free(hdrblob);
    return 0;
  }
}

/* ---- git_smart_subtransport_stream ---- */

static int http_stream_read(git_smart_subtransport_stream *stream,
                            char *buffer, size_t buf_size, size_t *bytes_read) {
  http_stream *s = (http_stream *)stream;
  *bytes_read = 0;
  if (s->fd < 0) {
    int rc = http_perform(s);
    if (rc != 0) return rc;
  }
  if (s->eof || buf_size == 0) return 0;
  size_t want = buf_size < READ_CHUNK_CAP ? buf_size : READ_CHUNK_CAP;
  for (;;) {
    int n = (int)read(s->fd, buffer, want);
    if (n > 0) { *bytes_read = (size_t)n; return 0; }
    if (n == 0) { s->eof = 1; return 0; }              /* clean EOF */
    if (errno == EAGAIN || errno == EINTR) {
      if (wait_fd(s->fd) == 0) continue;
      return -1;
    }
    git_error_set(GIT_ERROR_NET, errno == ETIMEDOUT
      ? "timed out reading the HTTP response body"
      : "HTTP body read failed");
    return -1;
  }
}

static int http_stream_write(git_smart_subtransport_stream *stream,
                             const char *buffer, size_t len) {
  http_stream *s = (http_stream *)stream;
  if (s->fd >= 0) {
    /* The stateless shape is strictly write-then-read; smart.c never
     * interleaves. A write after the request went out is a logic error. */
    git_error_set(GIT_ERROR_NET, "cannot write after the HTTP request was sent");
    return -1;
  }
  if (buf_put(&s->body, buffer, len) < 0) {
    git_error_set(GIT_ERROR_NET, "out of memory buffering the request body");
    return -1;
  }
  return 0;
}

static void http_stream_free(git_smart_subtransport_stream *stream) {
  http_stream *s = (http_stream *)stream;
  if (s->fd >= 0) close(s->fd);
  buf_free(&s->body);
  free(s);
}

/* ---- git_smart_subtransport ---- */

static int http_action(git_smart_subtransport_stream **out,
                       git_smart_subtransport *transport,
                       const char *url, git_smart_service_t action) {
  gucos_http_subtransport *t = (gucos_http_subtransport *)transport;
  const service_info *info;
  int is_post;

  switch (action) {
    case GIT_SERVICE_UPLOADPACK_LS:  info = &UPLOAD_INFO;  is_post = 0; break;
    case GIT_SERVICE_UPLOADPACK:     info = &UPLOAD_INFO;  is_post = 1; break;
    case GIT_SERVICE_RECEIVEPACK_LS: info = &RECEIVE_INFO; is_post = 0; break;
    case GIT_SERVICE_RECEIVEPACK:    info = &RECEIVE_INFO; is_post = 1; break;
    default:
      git_error_set(GIT_ERROR_NET, "unknown smart-transport action %d", (int)action);
      return -1;
  }

  /* The LS of each pair (re)establishes the base from the caller's URL; the
   * POST keeps whatever base the LS's redirect handling settled on. */
  if (!is_post && set_base_url(t, url) < 0)
    return -1;
  if (!t->base) {
    git_error_set(GIT_ERROR_NET, "no base URL (action before ls?)");
    return -1;
  }

  http_stream *s = calloc(1, sizeof(*s));
  if (!s) return -1;
  s->parent.subtransport = transport;
  s->parent.read = http_stream_read;
  s->parent.write = http_stream_write;
  s->parent.free = http_stream_free;
  s->t = t;
  s->info = info;
  s->is_post = is_post;
  s->fd = -1;
  *out = &s->parent;
  return 0;
}

static int http_close(git_smart_subtransport *transport) {
  (void)transport;   /* streams own their fds; nothing is connection-shaped */
  return 0;
}

static void http_free(git_smart_subtransport *transport) {
  gucos_http_subtransport *t = (gucos_http_subtransport *)transport;
  free(t->base);
  free(t->user);
  free(t->pass);
  if (t->cred) git_credential_free(t->cred);
  free(t);
}

int git_smart_subtransport_http(git_smart_subtransport **out,
                                git_transport *owner, void *param) {
  (void)param;
  gucos_http_subtransport *t = calloc(1, sizeof(*t));
  if (!t) return -1;
  t->parent.action = http_action;
  t->parent.close = http_close;
  t->parent.free = http_free;
  t->owner = owner;
  *out = &t->parent;
  return 0;
}
