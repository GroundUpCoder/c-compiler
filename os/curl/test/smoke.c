/*
 * smoke.c — the 0173 differential acceptance program.
 *
 * ONE source, built BOTH ways:
 *   native: clang smoke.c -lcurl          (real libcurl = reference oracle)
 *   gucOS:  os/curl/test/smoke.json       (the veneer over __http_*)
 * and run against the same local Node server (tests/kernel/test_curl_e2e.js).
 * Outputs must match modulo documented divergences: header ORDER/CASING and
 * the exact set of transport-added headers differ (fetch vs raw wire), so
 * headers are printed as "H <lowercased-name>" only and the harness compares
 * a normalized allowlist. Everything else — perform rc, response codes,
 * bodies, getinfo values, escape/unescape — must be byte-identical.
 *
 * argv[1] = base URL (http://127.0.0.1:PORT), argv[2] = closed-port URL for
 * the connection-refused case.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>

/* wasm stack is the low 64KB — keep big buffers static */
static char g_body[1 << 20];
static long g_blen;
static char g_hdrnames[16384];

static size_t on_body(char *p, size_t sz, size_t nm, void *ud) {
    size_t n = sz * nm;
    (void)ud;
    if (g_blen + (long)n < (long)sizeof g_body) {
        memcpy(g_body + g_blen, p, n);
        g_blen += (long)n;
    }
    return n;
}

/* record just the lowercased header NAME — order/casing/value of transport
   headers is a documented divergence, names prove the callback contract */
static size_t on_header(char *p, size_t sz, size_t nm, void *ud) {
    size_t n = sz * nm;
    (void)ud;
    if (n > 5 && !strncmp(p, "HTTP/", 5)) {
        /* status line: keep only the code (reason phrase differs) */
        int code = 0;
        const char *sp = memchr(p, ' ', n);
        if (sp) code = atoi(sp + 1);
        char tmp[64];
        snprintf(tmp, sizeof tmp, "S %d\n", code);
        strncat(g_hdrnames, tmp, sizeof g_hdrnames - strlen(g_hdrnames) - 1);
        return n;
    }
    const char *colon = memchr(p, ':', n);
    if (colon) {
        char name[128];
        size_t nl = (size_t)(colon - p);
        if (nl >= sizeof name) nl = sizeof name - 1;
        for (size_t i = 0; i < nl; i++) {
            char c = p[i];
            name[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
        }
        name[nl] = 0;
        strncat(g_hdrnames, "H ", sizeof g_hdrnames - strlen(g_hdrnames) - 1);
        strncat(g_hdrnames, name, sizeof g_hdrnames - strlen(g_hdrnames) - 1);
        strncat(g_hdrnames, "\n", sizeof g_hdrnames - strlen(g_hdrnames) - 1);
    }
    return n;
}

/* upstream body for the READFUNCTION case */
static const char *g_up;
static size_t g_uplen, g_upoff;
static size_t on_read(char *buf, size_t sz, size_t nm, void *ud) {
    size_t room = sz * nm, left = g_uplen - g_upoff;
    size_t n = left < room ? left : room;
    (void)ud;
    memcpy(buf, g_up + g_upoff, n);
    g_upoff += n;
    return n;
}

/* xferinfo abort (#306): returns continue until body bytes have arrived,
   then aborts — the mid-response interrupt path (gcode's Ctrl+C shape) */
static curl_off_t g_xfer_seen;
static int on_xfer(void *ud, curl_off_t dltotal, curl_off_t dlnow,
                   curl_off_t ultotal, curl_off_t ulnow) {
    (void)ud; (void)dltotal; (void)ultotal; (void)ulnow;
    if (dlnow > g_xfer_seen) g_xfer_seen = dlnow;
    return g_xfer_seen > 0 ? 1 : 0;
}

static void report(const char *name, CURL *h, CURLcode rc) {
    printf("== %s ==\n", name);
    printf("rc=%d\n", (int)rc);
    if (rc == CURLE_OK) {
        long code = 0;
        char *ctype = NULL;
        curl_off_t dl = -1, clen = -1;
        curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
        curl_easy_getinfo(h, CURLINFO_CONTENT_TYPE, &ctype);
        curl_easy_getinfo(h, CURLINFO_SIZE_DOWNLOAD_T, &dl);
        curl_easy_getinfo(h, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &clen);
        printf("status=%ld\n", code);
        printf("ctype=%s\n", ctype ? ctype : "(null)");
        printf("size=%lld clen=%lld\n", (long long)dl, (long long)clen);
        printf("hdrnames:\n%s", g_hdrnames);
        printf("body[%ld]=", g_blen);
        fwrite(g_body, 1, (size_t)g_blen, stdout);
        printf("\n");
    }
}

static CURL *fresh(const char *url) {
    CURL *h = curl_easy_init();
    g_blen = 0;
    g_body[0] = 0;
    g_hdrnames[0] = 0;
    curl_easy_setopt(h, CURLOPT_URL, url);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, on_body);
    curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, on_header);
    return h;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: smoke BASE_URL REFUSED_URL\n");
        return 2;
    }
    const char *base = argv[1], *refused = argv[2];
    char url[512];
    char errbuf[CURL_ERROR_SIZE];
    CURL *h;
    CURLcode rc;

    curl_global_init(CURL_GLOBAL_DEFAULT);

    /* 1: streamed 200 GET */
    snprintf(url, sizeof url, "%s/hello", base);
    h = fresh(url);
    rc = curl_easy_perform(h);
    report("get", h, rc);
    curl_easy_cleanup(h);

    /* 2: POST via POSTFIELDS */
    snprintf(url, sizeof url, "%s/echo", base);
    h = fresh(url);
    {
        struct curl_slist *hd = curl_slist_append(NULL, "Content-Type: text/plain");
        hd = curl_slist_append(hd, "X-Smoke: yes");
        curl_easy_setopt(h, CURLOPT_HTTPHEADER, hd);
        curl_easy_setopt(h, CURLOPT_POSTFIELDS, "ping-echo-42");
        rc = curl_easy_perform(h);
        report("post", h, rc);
        curl_slist_free_all(hd);
    }
    curl_easy_cleanup(h);

    /* 3: POST via READFUNCTION (buffered) */
    snprintf(url, sizeof url, "%s/echo", base);
    h = fresh(url);
    {
        struct curl_slist *hd = curl_slist_append(NULL, "Content-Type: application/octet-stream");
        g_up = "read-callback-body";
        g_uplen = strlen(g_up);
        g_upoff = 0;
        curl_easy_setopt(h, CURLOPT_HTTPHEADER, hd);
        curl_easy_setopt(h, CURLOPT_POST, 1L);
        curl_easy_setopt(h, CURLOPT_READFUNCTION, on_read);
        curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, (long)g_uplen);
        rc = curl_easy_perform(h);
        report("readcb", h, rc);
        curl_slist_free_all(hd);
    }
    curl_easy_cleanup(h);

    /* 4: 404 — perform SUCCEEDS, status surfaced */
    snprintf(url, sizeof url, "%s/missing", base);
    h = fresh(url);
    rc = curl_easy_perform(h);
    report("404", h, rc);
    curl_easy_cleanup(h);

    /* 5: connection refused */
    h = fresh(refused);
    errbuf[0] = 0;
    curl_easy_setopt(h, CURLOPT_ERRORBUFFER, errbuf);
    rc = curl_easy_perform(h);
    printf("== refused ==\n");
    printf("rc=%d\n", (int)rc);
    printf("errbuf_set=%d\n", errbuf[0] ? 1 : 0);
    curl_easy_cleanup(h);

    /* 6: total timeout on a stalling body */
    snprintf(url, sizeof url, "%s/stall", base);
    h = fresh(url);
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, 800L);
    rc = curl_easy_perform(h);
    printf("== timeout ==\n");
    printf("rc=%d\n", (int)rc);
    curl_easy_cleanup(h);

    /* 7: xferinfo abort on an in-flight response (#306) — the callback
       lets the transfer start, then aborts once body bytes have arrived.
       Both sides must abort the stalled stream with rc 42; TIMEOUT_MS is
       a backstop so a regression fails fast as rc=28 instead of hanging. */
    snprintf(url, sizeof url, "%s/stall", base);
    h = fresh(url);
    g_xfer_seen = 0;
    curl_easy_setopt(h, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(h, CURLOPT_XFERINFOFUNCTION, on_xfer);
    curl_easy_setopt(h, CURLOPT_XFERINFODATA, (void *)0);
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, 15000L);
    rc = curl_easy_perform(h);
    printf("== abortcb ==\n");
    printf("rc=%d midstream=%d\n", (int)rc, g_xfer_seen > 0 ? 1 : 0);
    curl_easy_cleanup(h);

    /* 8: escape/unescape (pure — identical both sides) */
    {
        h = curl_easy_init();
        char *esc = curl_easy_escape(h, "a b&c/d~e_f", 0);
        int ol = 0;
        char *un = curl_easy_unescape(h, "a%20b%26c%2Fd", 0, &ol);
        printf("== escape ==\n");
        printf("esc=%s\n", esc ? esc : "(null)");
        printf("unesc=%s len=%d\n", un ? un : "(null)", ol);
        curl_free(esc);
        curl_free(un);
        curl_easy_cleanup(h);
    }

    curl_global_cleanup();
    printf("done\n");
    return 0;
}
