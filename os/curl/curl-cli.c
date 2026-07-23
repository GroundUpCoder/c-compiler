/*
 * /bin/curl — small fetch CLI over the os/curl easy veneer (todos/0182).
 *
 * NOT a port of real curl's CLI: just enough tool, in the curl idiom, for
 * the shell to fetch. Links the 0173 easy veneer unchanged; the same source
 * builds natively against real libcurl (clang -lcurl,
 * os/curl/build-native-cli.sh — the gcode dual-target pattern).
 *
 * Flags (boolean flags bundle: -sf; value flags take attached or separate
 * arguments: -oFILE / -o FILE, curl style; no fixed argument order):
 *   -s          silent: no status line, no transport-error messages
 *   -o FILE     write the body to FILE instead of stdout ("-" = stdout)
 *   -X METHOD   custom request method (CURLOPT_CUSTOMREQUEST)
 *   -H HDR      extra request header, repeatable (curl_slist)
 *   -d DATA     request body, implies POST; repeatable, pieces joined
 *               with '&' (real curl's -d semantics; DATA is taken
 *               literally — no @file form)
 *   -f          fail on HTTP >= 400: body suppressed, exit 22
 *   -L          accepted no-op: the veneer's transport already follows
 *               redirects unconditionally (fetch redirect:'follow', the
 *               documented 0173 divergence), so -L asks for what always
 *               happens
 *
 * Default output: body to stdout, one status line ("curl: HTTP NNN") to
 * stderr unless -s.
 *
 * Exit codes in the curl idiom: 0 on success (any HTTP status without -f);
 * the CURLcode itself on transport failure (7 refused, 28 timeout, ...);
 * 22 (CURLE_HTTP_RETURNED_ERROR) for -f with HTTP >= 400; 23 when the -o
 * file can't be opened; 2 on usage errors. Usage errors print even under
 * -s (they are CLI-level, not transport-level).
 *
 * The -f body suppression works like real curl's --fail: the header
 * callback sees the status line before any body byte reaches the write
 * callback, so an error body is never emitted (natively, redirect hops
 * each deliver a status line and the last one wins).
 */
#include <curl/curl.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  FILE *out;         /* body sink: stdout or the -o file */
  int fail_on_error; /* -f */
  long status;       /* last status line seen by the header callback */
} Ctx;

static size_t header_cb(char *buf, size_t size, size_t nmemb, void *ud) {
  Ctx *c = ud;
  size_t len = size * nmemb;
  if (len > 5 && memcmp(buf, "HTTP/", 5) == 0) {
    const char *p = buf + 5;
    while (p < buf + len && *p != ' ') p++;
    c->status = strtol(p, NULL, 10);
  }
  return len;
}

static size_t write_cb(char *buf, size_t size, size_t nmemb, void *ud) {
  Ctx *c = ud;
  size_t len = size * nmemb;
  if (c->fail_on_error && c->status >= 400) return len; /* -f: drop the body */
  return fwrite(buf, 1, len, c->out);
}

/* -d accumulator: pieces joined with '&', real curl's repeat semantics. */
static int append_data(char **data, size_t *datalen, const char *piece) {
  size_t plen = strlen(piece);
  char *nd = realloc(*data, *datalen + plen + 2); /* '&' + NUL worst case */
  if (!nd) return -1;
  *data = nd;
  if (*datalen) nd[(*datalen)++] = '&';
  memcpy(nd + *datalen, piece, plen + 1);
  *datalen += plen;
  return 0;
}

static void usage(FILE *f) {
  fputs("usage: curl [-sfL] [-o FILE] [-X METHOD] [-H HEADER]... [-d DATA]... URL\n", f);
}

int main(int argc, char **argv) {
  const char *url = NULL, *ofile = NULL, *method = NULL;
  struct curl_slist *hdrs = NULL;
  char *data = NULL;
  size_t datalen = 0;
  int silent = 0, failon = 0;

  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (a[0] != '-' || a[1] == '\0') { /* bare word (or "-") = the URL */
      if (url) {
        fprintf(stderr, "curl: only one URL is supported\n");
        return 2;
      }
      url = a;
      continue;
    }
    for (const char *p = a + 1; *p;) {
      char c = *p++;
      const char *val = NULL;
      switch (c) {
        case 's': silent = 1; continue;
        case 'f': failon = 1; continue;
        case 'L': continue; /* redirects always follow — header comment */
        case 'o': case 'X': case 'H': case 'd':
          if (*p) { val = p; p += strlen(p); } /* attached: -oFILE */
          else if (i + 1 < argc) val = argv[++i];
          if (!val) {
            fprintf(stderr, "curl: option -%c requires an argument\n", c);
            return 2;
          }
          break;
        default:
          fprintf(stderr, "curl: unknown option -%c\n", c);
          usage(stderr);
          return 2;
      }
      if (c == 'o') ofile = val;
      else if (c == 'X') method = val;
      else if (c == 'H') hdrs = curl_slist_append(hdrs, val);
      else if (append_data(&data, &datalen, val) != 0) {
        fprintf(stderr, "curl: out of memory\n");
        return CURLE_OUT_OF_MEMORY;
      }
    }
  }
  if (!url) {
    fprintf(stderr, "curl: no URL specified\n");
    usage(stderr);
    return 2;
  }

  Ctx ctx = { stdout, failon, 0 };
  if (ofile && strcmp(ofile, "-") != 0) {
    ctx.out = fopen(ofile, "wb");
    if (!ctx.out) {
      if (!silent)
        fprintf(stderr, "curl: (23) can't open %s: %s\n", ofile, strerror(errno));
      return CURLE_WRITE_ERROR;
    }
  }

  CURL *h = curl_easy_init();
  if (!h) {
    if (!silent) fprintf(stderr, "curl: (2) init failed\n");
    return CURLE_FAILED_INIT;
  }
  curl_easy_setopt(h, CURLOPT_URL, url);
  curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 1L); /* uniform with the veneer */
  curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, write_cb);
  curl_easy_setopt(h, CURLOPT_WRITEDATA, &ctx);
  curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, header_cb);
  curl_easy_setopt(h, CURLOPT_HEADERDATA, &ctx);
  if (method) curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, method);
  if (hdrs) curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdrs);
  if (data) {
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, data);
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, (long)datalen);
  }

  CURLcode rc = curl_easy_perform(h);
  long code = 0;
  curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);

  int exitcode;
  if (rc != CURLE_OK) {
    if (!silent) fprintf(stderr, "curl: (%d) %s\n", (int)rc, curl_easy_strerror(rc));
    exitcode = (int)rc;
  } else if (failon && code >= 400) {
    if (!silent)
      fprintf(stderr, "curl: (22) The requested URL returned error: %ld\n", code);
    exitcode = CURLE_HTTP_RETURNED_ERROR;
  } else {
    if (!silent) fprintf(stderr, "curl: HTTP %ld\n", code);
    exitcode = 0;
  }

  if (ctx.out != stdout) fclose(ctx.out);
  curl_slist_free_all(hdrs);
  curl_easy_cleanup(h);
  free(data);
  return exitcode;
}
