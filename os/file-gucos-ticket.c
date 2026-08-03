/* file-gucos-ticket.c — file a ticket (or alert) OUT of gucOS (ticket #451;
 * todos/NETWORK.md "The ticket bridge").
 *
 *   file-gucos-ticket --title <t> [--body <text>|-] [--priority 0..3]
 *                     [--difficulty light|medium|heavy] [--kind ticket|alert]
 *
 * A thin client for the host-side ticket bridge (tools/ticket-bridge.js):
 * it POSTs one JSON object {kind, title, body?, priority?, difficulty?} to
 * <base>/file and relays the reply. What filing a ticket MEANS lives
 * entirely on the other side of that wire — the bridge shells out to a
 * `file-gucos-ticket` command on the HOST's PATH, and this OS knows
 * nothing beyond "such a command may exist". `--body -` reads stdin.
 *
 * Transport: the kernel HTTP primitive (todos/0172, fd-shaped todos/0417),
 * exactly the seam curl and ctlpanel's Test Bridge ride — so the request
 * transits the net bridge when /etc/net says `bridge on` and goes direct
 * otherwise, with no special-casing here.
 *
 * The reply rides the net-bridge encapsulation convention: a 200 carries
 * x-guc-exit (the handler's exit code) + the handler's stdout; bridge-level
 * refusals are plain statuses without it. So "the handler rejected your
 * ticket" (exit N, its stdout relayed) stays distinguishable from "the
 * bridge refused you" (403/413/...) and from "no handler installed" (501).
 *
 * The bridge base URL is the `ticket` config store's `url` key (cfgstore.h
 * three-layer overlay: ~/.config/ticket > /etc/ticket > /usr/share/ticket;
 * nothing is baked), default http://127.0.0.1:8210. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "cfgstore.h"

__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

#define FGT_DEF_URL   "http://127.0.0.1:8210"
#define FGT_URL_MAX   256
#define TITLE_MAX     512
#define BODY_MAX      (48 * 1024)
#define JSON_MAX      (112 * 1024)   /* worst-case escaped body still fits */
#define HDR_MAX       8192

static char g_body[BODY_MAX];
static char g_json[JSON_MAX];
static char g_hdr[HDR_MAX];

static int usage(int code) {
    FILE *f = code ? stderr : stdout;
    fprintf(f,
        "usage: file-gucos-ticket --title <t> [--body <text>|-] [--priority 0..3]\n"
        "                         [--difficulty light|medium|heavy] [--kind ticket|alert]\n"
        "Files a ticket on the HOST through the ticket bridge (default\n"
        "http://127.0.0.1:8210; override: `url` in the `ticket` config store).\n"
        "The host runs the bridge itself: node tools/ticket-bridge.js\n"
        "--body - reads the body from stdin.\n");
    return code;
}

/* Append one JSON string value (quotes included) to g_json at *k.
 * Returns 0, or -1 when the escaped value would overflow. */
static int json_str(size_t *k, const char *s) {
    size_t n = strlen(s);
    if (*k + 2 >= JSON_MAX) return -1;
    g_json[(*k)++] = '"';
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (*k + 8 >= JSON_MAX) return -1;
        if (c == '"' || c == '\\') { g_json[(*k)++] = '\\'; g_json[(*k)++] = (char)c; }
        else if (c == '\n') { g_json[(*k)++] = '\\'; g_json[(*k)++] = 'n'; }
        else if (c == '\r') { g_json[(*k)++] = '\\'; g_json[(*k)++] = 'r'; }
        else if (c == '\t') { g_json[(*k)++] = '\\'; g_json[(*k)++] = 't'; }
        else if (c < 0x20) {
            *k += (size_t)snprintf(g_json + *k, JSON_MAX - *k, "\\u%04x", c);
        }
        else g_json[(*k)++] = (char)c;   /* UTF-8 bytes pass through verbatim */
    }
    g_json[(*k)++] = '"';
    g_json[*k] = 0;
    return 0;
}

static int json_lit(size_t *k, const char *s) {
    size_t n = strlen(s);
    if (*k + n + 1 >= JSON_MAX) return -1;
    memcpy(g_json + *k, s, n);
    *k += n;
    g_json[*k] = 0;
    return 0;
}

/* The bridge base URL: the `ticket` store's `url` key, or the default. */
static void ticket_url(char *out, size_t sz) {
    char text[CFG_STORE_MAX], val[FGT_URL_MAX], user[300];
    snprintf(out, sz, "%s", FGT_DEF_URL);
    cfg_user_path(user, sizeof user, "ticket");
    if (cfg_load3(text, sizeof text, user, "/etc/ticket", "/usr/share/ticket") &&
        cfg_find(text, "url", val, sizeof val))
        snprintf(out, sz, "%s", val);
    /* strip trailing '/' so base + "/file" is clean either way */
    size_t n = strlen(out);
    while (n > 1 && out[n - 1] == '/') out[--n] = 0;
}

static int wait_fd(int fd) {
    return __wait(&fd, 1, 0, -1);
}

/* Case-insensitive "x-guc-exit: N" scan over the flattened header blob.
 * Returns 1 with the code in *out, else 0. */
static int hdr_exit(const char *hdr, int *out) {
    const char *key = "x-guc-exit:";
    size_t klen = strlen(key);
    for (const char *p = hdr; *p; ) {
        if (strncasecmp(p, key, klen) == 0) {
            *out = atoi(p + klen);
            return 1;
        }
        const char *nl = strchr(p, '\n');
        if (!nl) break;
        p = nl + 1;
    }
    return 0;
}

/* Stream the response body to `dest` (1 stdout / 2 stderr). Returns total
 * bytes, or -1 on a read error (errno kept). */
static int drain_body(int fd, int dest) {
    int total = 0;
    for (;;) {
        char buf[4096];
        int n = (int)read(fd, buf, sizeof buf);
        if (n > 0) {
            int off = 0;
            while (off < n) {
                int w = (int)write(dest, buf + off, (size_t)(n - off));
                if (w < 0) { if (errno == EINTR) continue; return -1; }
                off += w;
            }
            total += n;
            continue;
        }
        if (n == 0) return total;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(fd); continue; }
        return -1;
    }
}

int main(int argc, char **argv) {
    const char *title = 0, *body = 0, *prio = 0, *diff = 0, *kind = "ticket";
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *val = (i + 1 < argc) ? argv[i + 1] : 0;
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) return usage(0);
        else if (strcmp(a, "--title") == 0 && val) { title = val; i++; }
        else if (strcmp(a, "--body") == 0 && val) { body = val; i++; }
        else if (strcmp(a, "--priority") == 0 && val) { prio = val; i++; }
        else if (strcmp(a, "--difficulty") == 0 && val) { diff = val; i++; }
        else if (strcmp(a, "--kind") == 0 && val) { kind = val; i++; }
        else {
            fprintf(stderr, "file-gucos-ticket: bad argument: %s\n", a);
            return usage(2);
        }
    }
    if (!title || !*title) {
        fprintf(stderr, "file-gucos-ticket: --title is required\n");
        return usage(2);
    }
    if (strlen(title) >= TITLE_MAX) {
        fprintf(stderr, "file-gucos-ticket: title exceeds %d bytes\n", TITLE_MAX - 1);
        return 2;
    }
    if (prio && (strlen(prio) != 1 || prio[0] < '0' || prio[0] > '3')) {
        fprintf(stderr, "file-gucos-ticket: --priority must be 0..3\n");
        return 2;
    }
    if (diff && strcmp(diff, "light") != 0 && strcmp(diff, "medium") != 0 &&
        strcmp(diff, "heavy") != 0) {
        fprintf(stderr, "file-gucos-ticket: --difficulty must be light|medium|heavy\n");
        return 2;
    }
    if (strcmp(kind, "ticket") != 0 && strcmp(kind, "alert") != 0) {
        fprintf(stderr, "file-gucos-ticket: --kind must be ticket|alert\n");
        return 2;
    }
    if (body && strcmp(body, "-") == 0) {          /* --body -: stdin to EOF */
        size_t got = 0;
        for (;;) {
            ssize_t n = read(0, g_body + got, sizeof g_body - 1 - got);
            if (n > 0) {
                got += (size_t)n;
                if (got >= sizeof g_body - 1) {
                    char c;
                    ssize_t more = read(0, &c, 1);
                    if (more > 0) {
                        fprintf(stderr, "file-gucos-ticket: stdin body exceeds %d bytes\n",
                                BODY_MAX - 1);
                        return 2;
                    }
                    break;
                }
                continue;
            }
            if (n == 0) break;
            if (errno == EINTR || errno == EAGAIN) continue;
            fprintf(stderr, "file-gucos-ticket: reading stdin: %s\n", strerror(errno));
            return 2;
        }
        g_body[got] = 0;
        body = g_body;
    }

    /* {kind, title, body?, priority?, difficulty?} — unset fields are
     * OMITTED (defaults are the handler's policy, not this repo's). */
    size_t k = 0;
    int of = json_lit(&k, "{\"kind\":") || json_str(&k, kind)
          || json_lit(&k, ",\"title\":") || json_str(&k, title);
    if (!of && body)
        of = json_lit(&k, ",\"body\":") || json_str(&k, body);
    if (!of && prio) {
        of = json_lit(&k, ",\"priority\":") || json_lit(&k, prio);
    }
    if (!of && diff)
        of = json_lit(&k, ",\"difficulty\":") || json_str(&k, diff);
    if (!of) of = json_lit(&k, "}");
    if (of) {
        fprintf(stderr, "file-gucos-ticket: request too large\n");
        return 2;
    }

    char base[FGT_URL_MAX], url[FGT_URL_MAX + 8];
    ticket_url(base, sizeof base);
    snprintf(url, sizeof url, "%s/file", base);

    /* 60s headers deadline: the bridge holds the reply while the handler
     * runs (its own default timeout is 30s), so outlive that. */
    int fd = __http_open("POST", url, "Content-Type: application/json\n",
                         g_json, (int)k, 60000, 0);
    if (fd < 0) {
        fprintf(stderr, "file-gucos-ticket: ticket bridge unreachable at %s (%s)"
                " — is tools/ticket-bridge.js running on the host?\n",
                base, strerror(errno));
        return 1;
    }
    int status = 0, hl;
    for (;;) {
        hl = __http_status(fd, &status, g_hdr, sizeof g_hdr - 1);
        if (hl >= 0) {
            g_hdr[hl < HDR_MAX - 1 ? hl : HDR_MAX - 1] = 0;
            break;
        }
        if (errno == EAGAIN || errno == EINTR) { wait_fd(fd); continue; }
        fprintf(stderr, "file-gucos-ticket: ticket bridge unreachable at %s (%s)"
                " — is tools/ticket-bridge.js running on the host?\n",
                base, strerror(errno));
        close(fd);
        return 1;
    }

    int rc = 1;
    if (status == 200) {
        int hexit;
        if (!hdr_exit(g_hdr, &hexit)) {
            fprintf(stderr, "file-gucos-ticket: %s answered 200 without x-guc-exit"
                    " — is the `ticket` url setting really pointing at"
                    " tools/ticket-bridge.js?\n", base);
            drain_body(fd, 2);
        } else if (hexit == 0) {
            /* success: the handler's reply (e.g. a ticket ref) verbatim */
            if (drain_body(fd, 1) >= 0) rc = 0;
            else fprintf(stderr, "file-gucos-ticket: reading the reply: %s\n",
                         strerror(errno));
        } else {
            /* the HANDLER rejected the ticket — its own words follow */
            fprintf(stderr, "file-gucos-ticket: the host ticket handler failed"
                    " (exit %d):\n", hexit);
            drain_body(fd, 2);
            fputc('\n', stderr);
        }
    } else if (status == 501) {
        fprintf(stderr, "file-gucos-ticket: no ticket handler installed on this"
                " host — the bridge found no `file-gucos-ticket` command on its"
                " PATH:\n");
        drain_body(fd, 2);
        fputc('\n', stderr);
    } else {
        /* bridge-level refusal (403 origin, 413 cap, 400, 502, 503, ...) */
        fprintf(stderr, "file-gucos-ticket: the ticket bridge refused the"
                " request (HTTP %d):\n", status);
        drain_body(fd, 2);
        fputc('\n', stderr);
    }
    close(fd);
    return rc;
}
