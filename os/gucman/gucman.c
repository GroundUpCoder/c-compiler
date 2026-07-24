/*
 * gucman — the gucOS package manager (Slice 1: install / remove / list;
 * ticket #83 grew the human-readable catalog: `list [--all]` + `info`).
 *
 * CLI surface split (locked): `gucman index` prints the repository
 * index.json RAW — the machine-readable catalog for front-ends (the
 * storefront GUI parses it; never reformat those bytes). The HUMAN
 * surfaces are `list` (installed packages, aligned table, no network),
 * `list --all` (the full catalog cross-referenced with the install DB,
 * so every row shows installed y/n and at which version — a package baked
 * into the sealed /usr with no DB record reads `built-in`) and
 * `info <name>` (catalog fields + install state + the planted lists
 * from the DB record).
 *
 * Design (locked, ~git/meta gucman roadmap + design thread): optional apps
 * live OUT of the baked /usr blob as tar+gzip payloads on the same deploy
 * that served the OS, described by /packages/index.json. Install target is
 * /opt/<name>/ with tracked symlinks into /usr/local/bin (already first on
 * PATH). The manifest is FULLY DECLARATIVE — a package's control.json lists
 * its bin commands, openwith keys, menu entries and font faces (fallback-
 * chain lines in /etc/fonts/fallback, Unicode Phase D); install records the
 * EXACT planted list in the install DB /var/lib/gucman/<name>.json and
 * remove replays that record in reverse. No custom scripts in Slice 1
 * (postinst/prerm are a reserved narrow escape hatch, not yet implemented —
 * a control.json carrying them is refused loudly rather than half-run).
 *
 * Safety invariants (the engine, not per-package policy):
 *   - sha256 is verified against the index BEFORE anything is extracted;
 *     a corrupted payload is a loud refusal with nothing written.
 *   - the tar extractor REJECTS absolute member paths, `..` components,
 *     non-file/dir member types, and anything outside opt/<name>/ (plus
 *     the one top-level control.json) — validated in FULL before the
 *     first byte is written.
 *   - crash-safe ordering: extract into /opt/.staging.<name> -> atomic
 *     rename to /opt/<name> -> plant symlinks/openwith/menu -> write the
 *     DB record LAST. A crash before the DB write leaves no record; the
 *     next install of that name sweeps the orphan staging dir and any
 *     recordless /opt/<name> and starts over. Remove deletes the DB
 *     record LAST, and tolerates ENOENT while replaying, so a crashed
 *     remove can simply be re-run.
 *
 * Transport: the 0173 libcurl veneer over the kernel's __http_* bridge.
 * The repo base URL comes from /etc/gucman/repos (first non-comment line),
 * falling back to the baked /usr/share/gucman/repos — origin-relative
 * ("/packages") in the browser, an absolute http://host:port/... URL for
 * headless boots. Payload decompression is in-process zlib (gzip); JSON is
 * cJSON. Dependencies install depth-first off the index's deps[] (exact
 * names, cycle -> refuse), minBase gates against os-release VERSION_ID.
 */
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <curl/curl.h>
#include <zlib.h>
#include "cJSON.h"
#include "fileops.h"            /* fo_delete: the ONE recursive delete */

#define GM_DB_DIR       "/var/lib/gucman"
#define GM_OPT_DIR      "/opt"
#define GM_REPOS_ETC    "/etc/gucman/repos"
#define GM_REPOS_USR    "/usr/share/gucman/repos"
#define GM_OPENWITH     "/etc/openwith"
#define GM_MENU_DIR     "/etc/menu"
#define GM_FONTS_DIR    "/etc/fonts"
#define GM_FONT_LIST    "/etc/fonts/fallback"   /* the fontchain.h /etc layer */
#define GM_BIN_DIR      "/usr/local/bin"
#define GM_DESKTOP_DIR  "/root/Desktop"          /* where the wm scans icons */
#define GM_DESKTOP_FLAG GM_DB_DIR "/desktop_shortcuts"  /* Q5/#90 persistent toggle */
#define GM_OS_RELEASE   "/usr/share/os-release"
#define GM_NAME_MAX     64
#define GM_PATH_MAX     768

/* ================= sha256 (FIPS 180-4, self-contained) ================= */

typedef struct {
    uint32_t h[8];
    uint64_t len;
    uint8_t buf[64];
    int fill;
} sha256_ctx;

static const uint32_t sha256_k[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(sha256_ctx *c, const uint8_t *p) {
    uint32_t w[64], a, b, d, e, f, g, hh, t1, t2, hcur;
    int i;
    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = c->h[0]; b = c->h[1]; hcur = c->h[2]; d = c->h[3];
    e = c->h[4]; f = c->h[5]; g = c->h[6]; hh = c->h[7];
    for (i = 0; i < 64; i++) {
        uint32_t s1 = ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        t1 = hh + s1 + ch + sha256_k[i] + w[i];
        uint32_t s0 = ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22);
        uint32_t mj = (a & b) ^ (a & hcur) ^ (b & hcur);
        t2 = s0 + mj;
        hh = g; g = f; f = e; e = d + t1;
        d = hcur; hcur = b; b = a; a = t1 + t2;
    }
    c->h[0] += a; c->h[1] += b; c->h[2] += hcur; c->h[3] += d;
    c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += hh;
}

static void sha256_init(sha256_ctx *c) {
    static const uint32_t iv[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    memcpy(c->h, iv, sizeof iv);
    c->len = 0;
    c->fill = 0;
}

static void sha256_update(sha256_ctx *c, const void *data, size_t n) {
    const uint8_t *p = (const uint8_t *)data;
    c->len += n;
    while (n) {
        size_t take = 64 - (size_t)c->fill;
        if (take > n) take = n;
        memcpy(c->buf + c->fill, p, take);
        c->fill += (int)take;
        p += take;
        n -= take;
        if (c->fill == 64) { sha256_block(c, c->buf); c->fill = 0; }
    }
}

static void sha256_hex(sha256_ctx *c, char out[65]) {
    uint64_t bits = c->len * 8;
    uint8_t pad = 0x80;
    sha256_update(c, &pad, 1);
    uint8_t z = 0;
    while (c->fill != 56) sha256_update(c, &z, 1);
    uint8_t lb[8];
    for (int i = 0; i < 8; i++) lb[i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_update(c, lb, 8);
    static const char hexd[] = "0123456789abcdef";
    for (int i = 0; i < 8; i++)
        for (int j = 0; j < 4; j++) {
            uint8_t byte = (uint8_t)(c->h[i] >> (24 - 8 * j));
            out[i * 8 + j * 2] = hexd[byte >> 4];
            out[i * 8 + j * 2 + 1] = hexd[byte & 15];
        }
    out[64] = 0;
}

static void sha256_of(const void *data, size_t n, char out[65]) {
    sha256_ctx c;
    sha256_init(&c);
    sha256_update(&c, data, n);
    sha256_hex(&c, out);
}

/* ======================= small file/string helpers ===================== */

static int gm_mkdir_p(const char *path) {
    char p[GM_PATH_MAX];
    if (snprintf(p, sizeof p, "%s", path) >= (int)sizeof p) { errno = ENAMETOOLONG; return -1; }
    for (char *s = p + 1; *s; s++) {
        if (*s != '/') continue;
        *s = 0;
        if (mkdir(p, 0755) != 0 && errno != EEXIST) return -1;
        *s = '/';
    }
    if (mkdir(p, 0755) != 0 && errno != EEXIST) return -1;
    return 0;
}

/* Read a whole file into a malloc'd NUL-terminated buffer (NULL on error). */
static char *gm_read_file(const char *path, size_t *len_out) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;
    size_t cap = 8192, len = 0;
    char *buf = malloc(cap);
    if (!buf) { close(fd); return NULL; }
    for (;;) {
        if (len + 4096 + 1 > cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) { free(buf); close(fd); return NULL; }
            buf = nb;
        }
        ssize_t r = read(fd, buf + len, 4096);
        if (r < 0) { free(buf); close(fd); return NULL; }
        if (r == 0) break;
        len += (size_t)r;
    }
    close(fd);
    buf[len] = 0;
    if (len_out) *len_out = len;
    return buf;
}

/* Write a whole file via tmp + rename (atomic publish; the .win32reg rule). */
static int gm_write_file_atomic(const char *path, const void *data, size_t n, mode_t mode) {
    char tmp[GM_PATH_MAX];
    if (snprintf(tmp, sizeof tmp, "%s.tmp", path) >= (int)sizeof tmp) { errno = ENAMETOOLONG; return -1; }
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0) return -1;
    const char *p = (const char *)data;
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, p + off, n - off);
        if (w <= 0) { int e = errno; close(fd); unlink(tmp); errno = e; return -1; }
        off += (size_t)w;
    }
    if (close(fd) != 0) { unlink(tmp); return -1; }
    if (rename(tmp, path) != 0) { int e = errno; unlink(tmp); errno = e; return -1; }
    return 0;
}

static int gm_exists(const char *path) {
    struct stat st;
    return lstat(path, &st) == 0;
}

static int gm_valid_name(const char *n) {
    if (!n || !*n || strlen(n) >= GM_NAME_MAX) return 0;
    if (!islower((unsigned char)n[0]) && !isdigit((unsigned char)n[0])) return 0;
    for (const char *p = n; *p; p++)
        if (!islower((unsigned char)*p) && !isdigit((unsigned char)*p) && *p != '-' && *p != '_')
            return 0;
    return 1;
}

/* One path component check: no absolute, no "..", no empty segment. */
static int gm_safe_rel(const char *rel) {
    if (!rel || !*rel || rel[0] == '/') return 0;
    const char *p = rel;
    while (*p) {
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t sl = (size_t)(p - seg);
        if (sl == 0) return 0;                                   /* "//" or trailing "/" handled by caller */
        if (sl == 1 && seg[0] == '.') return 0;
        if (sl == 2 && seg[0] == '.' && seg[1] == '.') return 0;
        if (*p) p++;
        if (*p == 0 && p[-1] == '/') return 0;                   /* trailing slash */
    }
    return 1;
}

/* ============================ repo + http ============================== */

static int gm_repo_base(char *out, size_t cap) {
    size_t len;
    char *text = gm_read_file(GM_REPOS_ETC, &len);
    if (!text) text = gm_read_file(GM_REPOS_USR, &len);
    if (!text) {
        fprintf(stderr, "gucman: no repository configured (%s or %s)\n", GM_REPOS_ETC, GM_REPOS_USR);
        return -1;
    }
    int ok = -1;
    char *save = text;
    for (char *line = text; line && *line; ) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        while (*line == ' ' || *line == '\t') line++;
        char *end = line + strlen(line);
        while (end > line && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) *--end = 0;
        if (*line && *line != '#') {
            while (end > line && end[-1] == '/') *--end = 0;     /* no trailing '/' */
            if (snprintf(out, cap, "%s", line) < (int)cap) ok = 0;
            break;
        }
        line = nl ? nl + 1 : NULL;
    }
    free(save);
    if (ok != 0) fprintf(stderr, "gucman: no usable repository URL\n");
    return ok;
}

struct gm_buf {
    char *p;
    size_t len, cap;
};

static size_t gm_curl_sink(char *data, size_t sz, size_t nm, void *ud) {
    struct gm_buf *b = (struct gm_buf *)ud;
    size_t n = sz * nm;
    if (b->len + n + 1 > b->cap) {
        size_t nc = b->cap ? b->cap : 65536;
        while (nc < b->len + n + 1) nc *= 2;
        char *np = realloc(b->p, nc);
        if (!np) return 0;                                       /* aborts the transfer */
        b->p = np;
        b->cap = nc;
    }
    memcpy(b->p + b->len, data, n);
    b->len += n;
    b->p[b->len] = 0;
    return n;
}

/* GET base/rel into a malloc'd buffer; 0 on HTTP 200, -1 otherwise. */
static int gm_http_get(const char *base, const char *rel, struct gm_buf *out) {
    char url[GM_PATH_MAX];
    if (snprintf(url, sizeof url, "%s/%s", base, rel) >= (int)sizeof url) {
        fprintf(stderr, "gucman: URL too long\n");
        return -1;
    }
    memset(out, 0, sizeof *out);
    CURL *h = curl_easy_init();
    if (!h) { fprintf(stderr, "gucman: curl init failed\n"); return -1; }
    curl_easy_setopt(h, CURLOPT_URL, url);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, gm_curl_sink);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, out);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, 30L);
    CURLcode rc = curl_easy_perform(h);
    long code = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    curl_easy_cleanup(h);
    if (rc != CURLE_OK) {
        fprintf(stderr, "gucman: %s: %s\n", url, curl_easy_strerror(rc));
        free(out->p);
        out->p = NULL;
        return -1;
    }
    if (code != 200) {
        fprintf(stderr, "gucman: %s: HTTP %ld\n", url, code);
        free(out->p);
        out->p = NULL;
        return -1;
    }
    return 0;
}

/* ============================ gzip inflate ============================= */

static int gm_gunzip(const unsigned char *in, size_t inlen, unsigned char **out, size_t *outlen) {
    z_stream zs;
    memset(&zs, 0, sizeof zs);
    if (inflateInit2(&zs, 15 + 32) != Z_OK) return -1;           /* +32: gzip/zlib auto */
    size_t cap = inlen * 4 + 65536, len = 0;
    unsigned char *buf = malloc(cap);
    if (!buf) { inflateEnd(&zs); return -1; }
    zs.next_in = (unsigned char *)in;
    zs.avail_in = (uInt)inlen;
    for (;;) {
        if (cap - len < 65536) {
            cap *= 2;
            unsigned char *nb = realloc(buf, cap);
            if (!nb) { free(buf); inflateEnd(&zs); return -1; }
            buf = nb;
        }
        zs.next_out = buf + len;
        zs.avail_out = (uInt)(cap - len);
        int rc = inflate(&zs, Z_NO_FLUSH);
        len = zs.total_out;
        if (rc == Z_STREAM_END) break;
        if (rc != Z_OK) { free(buf); inflateEnd(&zs); return -1; }
    }
    inflateEnd(&zs);
    *out = buf;
    *outlen = len;
    return 0;
}

/* ========================== tar walk/extract =========================== */

struct tar_member {
    char name[257];             /* prefix + '/' + name */
    char type;                  /* '0'/'\0' file, '5' dir */
    size_t size;
    unsigned mode;
    const unsigned char *data;
};

static size_t tar_octal(const unsigned char *p, size_t n) {
    size_t v = 0;
    for (size_t i = 0; i < n && p[i]; i++) {
        if (p[i] == ' ') continue;
        if (p[i] < '0' || p[i] > '7') break;
        v = v * 8 + (size_t)(p[i] - '0');
    }
    return v;
}

/* Iterate members: returns 1 with *m filled, 0 at end, -1 on a malformed
 * archive. *off advances. */
static int tar_next(const unsigned char *tar, size_t len, size_t *off, struct tar_member *m) {
    if (*off + 512 > len) return -1;
    const unsigned char *h = tar + *off;
    int empty = 1;
    for (int i = 0; i < 512; i++) if (h[i]) { empty = 0; break; }
    if (empty) return 0;                                         /* end-of-archive block */
    if (memcmp(h + 257, "ustar", 5) != 0) return -1;
    char name[101], prefix[156];
    memcpy(name, h, 100); name[100] = 0;
    memcpy(prefix, h + 345, 155); prefix[155] = 0;
    if (prefix[0]) snprintf(m->name, sizeof m->name, "%s/%s", prefix, name);
    else snprintf(m->name, sizeof m->name, "%s", name);
    m->size = tar_octal(h + 124, 12);
    m->mode = (unsigned)tar_octal(h + 100, 8);
    m->type = (char)h[156];
    m->data = tar + *off + 512;
    size_t blocks = (m->size + 511) / 512;
    if (*off + 512 + blocks * 512 > len) return -1;
    *off += 512 + blocks * 512;
    return 1;
}

/* Validate EVERY member against the safety rules before extraction: only
 * one top-level control.json plus dirs/files inside opt/<name>/. Returns 0
 * ok, -1 with a message printed. */
static int tar_validate(const unsigned char *tar, size_t len, const char *pkgname) {
    char want[GM_NAME_MAX + 8];
    snprintf(want, sizeof want, "opt/%s", pkgname);
    size_t wl = strlen(want);
    size_t off = 0;
    struct tar_member m;
    int rc, saw_control = 0;
    while ((rc = tar_next(tar, len, &off, &m)) == 1) {
        char *nm = m.name;
        size_t nl = strlen(nm);
        while (nl > 1 && nm[nl - 1] == '/') nm[--nl] = 0;        /* dir names may carry '/' */
        if (m.type != '0' && m.type != 0 && m.type != '5') {
            fprintf(stderr, "gucman: payload member '%s' has unsupported type '%c' — refusing\n", nm, m.type);
            return -1;
        }
        if (!gm_safe_rel(nm)) {
            fprintf(stderr, "gucman: payload member '%s' is not a safe relative path — refusing\n", nm);
            return -1;
        }
        if (strcmp(nm, "control.json") == 0 && (m.type == '0' || m.type == 0)) {
            saw_control = 1;
            continue;
        }
        if (strcmp(nm, "opt") == 0 || strcmp(nm, want) == 0) {
            if (m.type != '5') {
                fprintf(stderr, "gucman: payload member '%s' must be a directory — refusing\n", nm);
                return -1;
            }
            continue;
        }
        if (strncmp(nm, want, wl) != 0 || nm[wl] != '/') {
            fprintf(stderr, "gucman: payload member '%s' escapes opt/%s/ — refusing\n", nm, pkgname);
            return -1;
        }
    }
    if (rc < 0) {
        fprintf(stderr, "gucman: malformed tar payload — refusing\n");
        return -1;
    }
    if (!saw_control) {
        fprintf(stderr, "gucman: payload has no control.json — refusing\n");
        return -1;
    }
    return 0;
}

/* Extract the validated archive: control.json into *control (malloc'd),
 * opt/<name>/** into stagedir/**. Records planted files/dirs (absolute
 * FINAL paths under /opt/<name>) into the JSON arrays for the DB. */
static int tar_extract(const unsigned char *tar, size_t len, const char *pkgname,
                       const char *stagedir, char **control,
                       cJSON *db_files, cJSON *db_dirs) {
    char want[GM_NAME_MAX + 8];
    snprintf(want, sizeof want, "opt/%s", pkgname);
    size_t wl = strlen(want);
    size_t off = 0;
    struct tar_member m;
    int rc;
    while ((rc = tar_next(tar, len, &off, &m)) == 1) {
        char *nm = m.name;
        size_t nl = strlen(nm);
        while (nl > 1 && nm[nl - 1] == '/') nm[--nl] = 0;
        if (strcmp(nm, "control.json") == 0) {
            *control = malloc(m.size + 1);
            if (!*control) return -1;
            memcpy(*control, m.data, m.size);
            (*control)[m.size] = 0;
            continue;
        }
        if (strncmp(nm, want, wl) != 0 || nm[wl] != '/') continue;   /* "opt", "opt/<name>" roots */
        const char *rel = nm + wl + 1;
        char dst[GM_PATH_MAX], fin[GM_PATH_MAX];
        if (snprintf(dst, sizeof dst, "%s/%s", stagedir, rel) >= (int)sizeof dst ||
            snprintf(fin, sizeof fin, "/opt/%s/%s", pkgname, rel) >= (int)sizeof fin) {
            errno = ENAMETOOLONG;
            return -1;
        }
        if (m.type == '5') {
            if (mkdir(dst, 0755) != 0 && errno != EEXIST) return -1;
            cJSON_AddItemToArray(db_dirs, cJSON_CreateString(fin));
        } else {
            mode_t mode = (m.mode & 0111) ? 0755 : 0644;
            int fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, mode);
            if (fd < 0) return -1;
            size_t o = 0;
            while (o < m.size) {
                ssize_t w = write(fd, m.data + o, m.size - o);
                if (w <= 0) { int e = errno; close(fd); errno = e; return -1; }
                o += (size_t)w;
            }
            if (close(fd) != 0) return -1;
            cJSON_AddItemToArray(db_files, cJSON_CreateString(fin));
        }
    }
    return rc < 0 ? -1 : 0;
}

/* ===================== openwith delta read/write ======================= */

/* Rewrite ONE key in /etc/openwith (value NULL deletes the key). Preserves
 * every other line, comments included; creates the file when absent. The
 * cfgstore per-key overlay means only /etc needs touching — the baked
 * /usr/share layer keeps serving every other key. */
static int gm_openwith_set(const char *key, const char *value) {
    size_t len = 0;
    char *old = gm_read_file(GM_OPENWITH, &len);
    size_t cap = (old ? len : 0) + strlen(key) + (value ? strlen(value) : 0) + 16;
    char *out = malloc(cap);
    if (!out) { free(old); return -1; }
    size_t o = 0;
    size_t kl = strlen(key);
    if (old) {
        for (char *line = old; line && *line; ) {
            char *nl = strchr(line, '\n');
            size_t ll = nl ? (size_t)(nl - line) + 1 : strlen(line);
            int is_key = (ll > kl && strncmp(line, key, kl) == 0 &&
                          (line[kl] == ' ' || line[kl] == '\t'));
            if (!is_key) { memcpy(out + o, line, ll); o += ll; }
            line = nl ? nl + 1 : NULL;
        }
    }
    if (o && out[o - 1] != '\n') out[o++] = '\n';
    if (value) o += (size_t)snprintf(out + o, cap - o, "%s\t%s\n", key, value);
    int rc = gm_write_file_atomic(GM_OPENWITH, out, o, 0644);
    free(out);
    free(old);
    return rc;
}

/* ==================== font fallback-line add/remove ==================== */

/* Add (add=1) or remove (add=0) one face-path LINE in /etc/fonts/fallback
 * (fontchain.h's /etc layer — one absolute path per line; the /etc lines
 * CONCATENATE ahead of the baked /usr/share list, so this only ever
 * touches the delta). Preserves every other line, comments included;
 * creates the file (and /etc/fonts) when absent; removing the last line
 * unlinks the file so a package-less system carries no empty config. */
static int gm_fontline_set(const char *path, int add) {
    size_t len = 0;
    char *old = gm_read_file(GM_FONT_LIST, &len);
    size_t cap = (old ? len : 0) + strlen(path) + 16;
    char *out = malloc(cap);
    if (!out) { free(old); return -1; }
    size_t o = 0;
    size_t pl = strlen(path);
    if (old) {
        for (char *line = old; line && *line; ) {
            char *nl = strchr(line, '\n');
            size_t ll = nl ? (size_t)(nl - line) + 1 : strlen(line);
            size_t body = ll - (nl ? 1 : 0);
            int is_path = body == pl && strncmp(line, path, pl) == 0;
            if (!is_path) { memcpy(out + o, line, ll); o += ll; }
            line = nl ? nl + 1 : NULL;
        }
    }
    if (o && out[o - 1] != '\n') out[o++] = '\n';
    if (add) o += (size_t)snprintf(out + o, cap - o, "%s\n", path);
    free(old);
    if (o == 0) {                        /* nothing left: drop the file */
        free(out);
        if (unlink(GM_FONT_LIST) != 0 && errno != ENOENT) return -1;
        return 0;
    }
    if (gm_mkdir_p(GM_FONTS_DIR) != 0) { free(out); return -1; }
    int rc = gm_write_file_atomic(GM_FONT_LIST, out, o, 0644);
    free(out);
    return rc;
}

/* ============================ install DB =============================== */

static void gm_db_path(const char *name, char *out, size_t cap) {
    snprintf(out, cap, GM_DB_DIR "/%s.json", name);
}

static cJSON *gm_db_load(const char *name) {
    char p[GM_PATH_MAX];
    gm_db_path(name, p, sizeof p);
    size_t len;
    char *text = gm_read_file(p, &len);
    if (!text) return NULL;
    cJSON *db = cJSON_Parse(text);
    free(text);
    return db;
}

/* ========================= base-version gate =========================== */

static int gm_base_version(void) {
    size_t len;
    char *text = gm_read_file(GM_OS_RELEASE, &len);
    if (!text) return -1;
    int v = -1;
    char *m = strstr(text, "VERSION_ID=");
    if (m && (m == text || m[-1] == '\n')) v = atoi(m + 11);
    free(text);
    return v;
}

/* ========================= baked-package set =========================== */

/* PACKAGES= in /usr/share/os-release names the packages folded into the
 * sealed /usr blob (os-common.js foldPackages — the fat-image identity
 * axis). One of these with NO install-DB record is BUILT-IN: present
 * under /usr/opt by construction, not installable or removable. A
 * DB record on top (installed over the base twin) keeps plain installed
 * semantics. Comma-separated, one line; absent on a minimal image. */
static char *gm_baked;                  /* the raw comma list, or NULL */
static int gm_baked_loaded;

static const char *gm_baked_list(void) {
    if (gm_baked_loaded) return gm_baked;
    gm_baked_loaded = 1;
    size_t len;
    char *text = gm_read_file(GM_OS_RELEASE, &len);
    if (!text) return NULL;
    char *m = strstr(text, "PACKAGES=");
    if (m && (m == text || m[-1] == '\n')) {
        char *e = strchr(m + 9, '\n');
        size_t n = e ? (size_t)(e - (m + 9)) : strlen(m + 9);
        gm_baked = malloc(n + 1);
        if (gm_baked) { memcpy(gm_baked, m + 9, n); gm_baked[n] = 0; }
    }
    free(text);
    return gm_baked;
}

static int gm_is_baked(const char *name) {
    const char *p = gm_baked_list();
    size_t nl = strlen(name);
    while (p && *p) {
        const char *c = strchr(p, ',');
        size_t l = c ? (size_t)(c - p) : strlen(p);
        if (l == nl && strncmp(p, name, nl) == 0) return 1;
        p = c ? c + 1 : p + l;
    }
    return 0;
}

/* ====================== install-to-Desktop toggle ===================== */

/* Q5/#90: the persistent "add new installs to Desktop" flag, shared with
 * the storefront GUI (software.c writes the same one-line file). ON iff the
 * file's first line is exactly "on"; absent/anything-else = OFF (opt-in
 * default). A CLI `gucman install` honours it just like the GUI does — the
 * setting lives with gucman, not in the front-end. */
static int gm_desktop_flag(void) {
    size_t len;
    char *t = gm_read_file(GM_DESKTOP_FLAG, &len);
    if (!t) return 0;
    char *nl = strchr(t, '\n');
    if (nl) *nl = 0;
    char *e = t + strlen(t);
    while (e > t && (e[-1] == ' ' || e[-1] == '\t' || e[-1] == '\r')) *--e = 0;
    int on = strcmp(t, "on") == 0;
    free(t);
    return on;
}

/* ============================== install ================================ */

/* Undo bookkeeping so a failed plant unwinds what it already did (the DB
 * was not written yet, so unwinding restores the pre-install state). */
struct gm_undo {
    cJSON *symlinks;            /* array of planted symlink paths */
    cJSON *openwith;            /* array of planted keys */
    cJSON *menu;                /* array of planted menu entry paths */
    cJSON *menu_dirs;           /* array of menu dirs WE created */
    cJSON *fonts;               /* array of planted fallback face lines */
    cJSON *desktop;             /* array of planted Desktop shortcut paths (Q5) */
};

static void gm_unwind(const char *name, struct gm_undo *u) {
    cJSON *it;
    cJSON_ArrayForEach(it, u->desktop) unlink(it->valuestring);
    cJSON_ArrayForEach(it, u->fonts) gm_fontline_set(it->valuestring, 0);
    cJSON_ArrayForEach(it, u->menu) unlink(it->valuestring);
    cJSON_ArrayForEach(it, u->menu_dirs) rmdir(it->valuestring);
    cJSON_ArrayForEach(it, u->openwith) gm_openwith_set(it->valuestring, NULL);
    cJSON_ArrayForEach(it, u->symlinks) unlink(it->valuestring);
    char opt[GM_PATH_MAX];
    snprintf(opt, sizeof opt, GM_OPT_DIR "/%s", name);
    fo_delete(opt);
}

static cJSON *gm_fetch_index(const char *base) {
    struct gm_buf buf;
    if (gm_http_get(base, "index.json", &buf) != 0) return NULL;
    cJSON *idx = cJSON_Parse(buf.p);
    free(buf.p);
    if (!idx) fprintf(stderr, "gucman: index.json is not valid JSON\n");
    return idx;
}

static int gm_install_one(const char *base, cJSON *index, const char *name,
                          cJSON *in_progress, int depth);

static int gm_install_deps(const char *base, cJSON *index, cJSON *deps,
                           cJSON *in_progress, int depth) {
    cJSON *d;
    cJSON_ArrayForEach(d, deps) {
        if (!cJSON_IsString(d) || !gm_valid_name(d->valuestring)) {
            fprintf(stderr, "gucman: bad dependency entry in index\n");
            return -1;
        }
        char dbp[GM_PATH_MAX];
        gm_db_path(d->valuestring, dbp, sizeof dbp);
        if (gm_exists(dbp)) continue;                            /* already installed
                                                                  * (also resolves diamonds) */
        if (cJSON_GetObjectItemCaseSensitive(in_progress, d->valuestring)) {
            fprintf(stderr, "gucman: dependency cycle through '%s' — refusing\n", d->valuestring);
            return -1;
        }
        if (gm_install_one(base, index, d->valuestring, in_progress, depth + 1) != 0) return -1;
    }
    return 0;
}

static int gm_install_one(const char *base, cJSON *index, const char *name,
                          cJSON *in_progress, int depth) {
    if (depth > 8) {
        fprintf(stderr, "gucman: dependency chain too deep — refusing\n");
        return -1;
    }
    cJSON *pkgs = cJSON_GetObjectItemCaseSensitive(index, "packages");
    cJSON *ent = pkgs ? cJSON_GetObjectItemCaseSensitive(pkgs, name) : NULL;
    if (!ent) {
        fprintf(stderr, "gucman: package '%s' not found in the repository index\n", name);
        return -1;
    }
    cJSON *jver = cJSON_GetObjectItemCaseSensitive(ent, "version");
    cJSON *jpay = cJSON_GetObjectItemCaseSensitive(ent, "payload");
    cJSON *jurl = jpay ? cJSON_GetObjectItemCaseSensitive(jpay, "url") : NULL;
    cJSON *jsha = jpay ? cJSON_GetObjectItemCaseSensitive(jpay, "sha256") : NULL;
    cJSON *jfmt = jpay ? cJSON_GetObjectItemCaseSensitive(jpay, "format") : NULL;
    cJSON *jmin = cJSON_GetObjectItemCaseSensitive(ent, "minBase");
    if (!cJSON_IsString(jver) || !cJSON_IsString(jurl) || !cJSON_IsString(jsha) ||
        !cJSON_IsString(jfmt) || strlen(jsha->valuestring) != 64) {
        fprintf(stderr, "gucman: index entry for '%s' is malformed\n", name);
        return -1;
    }
    if (strcmp(jfmt->valuestring, "tar+gzip") != 0) {
        fprintf(stderr, "gucman: '%s' payload format '%s' is not supported by this gucman\n",
                name, jfmt->valuestring);
        return -1;
    }
    if (cJSON_IsNumber(jmin)) {
        int bv = gm_base_version();
        if (bv >= 0 && bv < (int)jmin->valuedouble) {
            fprintf(stderr, "gucman: '%s' needs base v%d but this system is v%d — upgrade the OS first\n",
                    name, (int)jmin->valuedouble, bv);
            return -1;
        }
    }

    /* deps first (depth-first, cycle-guarded by the in-progress set) */
    cJSON_AddBoolToObject(in_progress, name, 1);
    cJSON *deps = cJSON_GetObjectItemCaseSensitive(ent, "deps");
    if (deps && gm_install_deps(base, index, deps, in_progress, depth) != 0) return -1;

    printf("gucman: downloading %s %s...\n", name, jver->valuestring);
    struct gm_buf pay;
    if (gm_http_get(base, jurl->valuestring, &pay) != 0) return -1;

    /* sha256 BEFORE anything touches the filesystem */
    char got[65];
    sha256_of(pay.p, pay.len, got);
    if (strcmp(got, jsha->valuestring) != 0) {
        fprintf(stderr, "gucman: '%s' payload is corrupted (sha256 mismatch:\n"
                        "  expected %s\n  got      %s) — refusing to install\n",
                name, jsha->valuestring, got);
        free(pay.p);
        return -1;
    }

    unsigned char *tar = NULL;
    size_t tarlen = 0;
    int rc = gm_gunzip((unsigned char *)pay.p, pay.len, &tar, &tarlen);
    free(pay.p);
    if (rc != 0) {
        fprintf(stderr, "gucman: '%s' payload failed to decompress — refusing\n", name);
        return -1;
    }
    if (tar_validate(tar, tarlen, name) != 0) { free(tar); return -1; }

    /* stage -> rename (crash-safe: /opt/<name> appears atomically) */
    char stage[GM_PATH_MAX], opt[GM_PATH_MAX];
    snprintf(stage, sizeof stage, GM_OPT_DIR "/.staging.%s", name);
    snprintf(opt, sizeof opt, GM_OPT_DIR "/%s", name);
    if (gm_mkdir_p(GM_OPT_DIR) != 0) { perror("gucman: mkdir /opt"); free(tar); return -1; }
    if (gm_exists(stage)) fo_delete(stage);                      /* crashed prior install */
    if (mkdir(stage, 0755) != 0) { perror("gucman: mkdir staging"); free(tar); return -1; }

    cJSON *db = cJSON_CreateObject();
    cJSON_AddStringToObject(db, "name", name);
    cJSON_AddStringToObject(db, "version", jver->valuestring);
    cJSON_AddStringToObject(db, "sha256", jsha->valuestring);
    cJSON *db_files = cJSON_AddArrayToObject(db, "files");
    cJSON *db_dirs = cJSON_AddArrayToObject(db, "dirs");
    cJSON *db_links = cJSON_AddArrayToObject(db, "symlinks");
    cJSON *db_ow = cJSON_AddArrayToObject(db, "openwith_keys");
    cJSON *db_menu = cJSON_AddArrayToObject(db, "menu_entries");
    cJSON *db_menu_dirs = cJSON_AddArrayToObject(db, "menu_dirs");
    cJSON *db_fonts = cJSON_AddArrayToObject(db, "font_faces");
    cJSON *db_desktop = cJSON_AddArrayToObject(db, "desktop");

    char *control_text = NULL;
    if (tar_extract(tar, tarlen, name, stage, &control_text, db_files, db_dirs) != 0) {
        fprintf(stderr, "gucman: extracting '%s' failed: %s\n", name, strerror(errno));
        fo_delete(stage);
        free(tar);
        free(control_text);
        cJSON_Delete(db);
        return -1;
    }
    free(tar);
    cJSON *control = control_text ? cJSON_Parse(control_text) : NULL;
    free(control_text);
    cJSON *cname = control ? cJSON_GetObjectItemCaseSensitive(control, "name") : NULL;
    if (!control || !cJSON_IsString(cname) || strcmp(cname->valuestring, name) != 0) {
        fprintf(stderr, "gucman: '%s' control.json is missing or names a different package — refusing\n", name);
        fo_delete(stage);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }
    /* Slice 1 has no script hatch — refuse rather than half-honor one. */
    if (cJSON_GetObjectItemCaseSensitive(control, "postinst") ||
        cJSON_GetObjectItemCaseSensitive(control, "prerm")) {
        fprintf(stderr, "gucman: '%s' carries postinst/prerm scripts, which this gucman does not run — refusing\n", name);
        fo_delete(stage);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }

    /* A recordless /opt/<name> is a crashed install (the DB write is LAST);
     * sweep it and take its place. */
    if (gm_exists(opt)) {
        fprintf(stderr, "gucman: sweeping leftover %s from an interrupted install\n", opt);
        fo_delete(opt);
    }
    if (rename(stage, opt) != 0) {
        perror("gucman: publishing /opt entry");
        fo_delete(stage);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }

    /* plant the declarative surface; unwind everything on any failure */
    struct gm_undo undo = { db_links, db_ow, db_menu, db_menu_dirs, db_fonts, db_desktop };
    int fail = 0;
    char primary[GM_NAME_MAX] = "";     /* the command a Desktop shortcut launches (Q5) */
    cJSON *cbin = cJSON_GetObjectItemCaseSensitive(control, "bin");
    cJSON *it;
    cJSON_ArrayForEach(it, cbin) {
        char link[GM_PATH_MAX], target[GM_PATH_MAX];
        if (!cJSON_IsString(it) || !gm_valid_name(it->string) || !gm_safe_rel(it->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed bin entry — refusing\n", name);
            fail = 1;
            break;
        }
        snprintf(link, sizeof link, GM_BIN_DIR "/%s", it->string);
        snprintf(target, sizeof target, GM_OPT_DIR "/%s/%s", name, it->valuestring);
        if (!gm_exists(target)) {
            fprintf(stderr, "gucman: '%s' bin %s -> %s names no packaged file — refusing\n",
                    name, it->string, it->valuestring);
            fail = 1;
            break;
        }
        if (gm_exists(link)) {
            fprintf(stderr, "gucman: %s already exists — refusing to overwrite\n", link);
            fail = 1;
            break;
        }
        if (symlink(target, link) != 0) {
            fprintf(stderr, "gucman: planting %s: %s\n", link, strerror(errno));
            fail = 1;
            break;
        }
        cJSON_AddItemToArray(db_links, cJSON_CreateString(link));
        /* the Desktop shortcut launches the package's primary command:
         * the one named exactly like the package if present, else the
         * first planted command (a font/library with no command gets no
         * shortcut — nothing to launch). */
        if (primary[0] == 0 || strcmp(it->string, name) == 0)
            snprintf(primary, sizeof primary, "%s", it->string);
    }
    cJSON *cow = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "openwith");
    cJSON_ArrayForEach(it, cow) {
        char cmdpath[GM_PATH_MAX];
        if (!cJSON_IsString(it) || !gm_valid_name(it->string) ||
            !cbin || !cJSON_GetObjectItemCaseSensitive(cbin, it->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed openwith entry — refusing\n", name);
            fail = 1;
            break;
        }
        snprintf(cmdpath, sizeof cmdpath, GM_BIN_DIR "/%s", it->valuestring);
        if (gm_openwith_set(it->string, cmdpath) != 0) {
            fprintf(stderr, "gucman: writing %s: %s\n", GM_OPENWITH, strerror(errno));
            fail = 1;
            break;
        }
        cJSON_AddItemToArray(db_ow, cJSON_CreateString(it->string));
    }
    cJSON *cmenu = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "menu");
    cJSON_ArrayForEach(it, cmenu) {
        cJSON *g = cJSON_GetObjectItemCaseSensitive(it, "group");
        cJSON *e = cJSON_GetObjectItemCaseSensitive(it, "entry");
        cJSON *c = cJSON_GetObjectItemCaseSensitive(it, "cmd");
        char gdir[GM_PATH_MAX], epath[GM_PATH_MAX], cmdpath[GM_PATH_MAX];
        if (!cJSON_IsString(g) || !cJSON_IsString(e) || !cJSON_IsString(c) ||
            !gm_safe_rel(g->valuestring) || strchr(g->valuestring, '/') ||
            !gm_safe_rel(e->valuestring) || strchr(e->valuestring, '/') ||
            !cbin || !cJSON_GetObjectItemCaseSensitive(cbin, c->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed menu entry — refusing\n", name);
            fail = 1;
            break;
        }
        snprintf(gdir, sizeof gdir, GM_MENU_DIR "/%s", g->valuestring);
        snprintf(epath, sizeof epath, "%s/%s", gdir, e->valuestring);
        snprintf(cmdpath, sizeof cmdpath, GM_BIN_DIR "/%s", c->valuestring);
        int made_root = !gm_exists(GM_MENU_DIR);
        if (made_root && mkdir(GM_MENU_DIR, 0755) != 0) { fail = 1; break; }
        if (made_root) cJSON_AddItemToArray(db_menu_dirs, cJSON_CreateString(GM_MENU_DIR));
        int made_group = !gm_exists(gdir);
        if (made_group && mkdir(gdir, 0755) != 0) { fail = 1; break; }
        if (made_group) cJSON_AddItemToArray(db_menu_dirs, cJSON_CreateString(gdir));
        if (gm_exists(epath)) {
            fprintf(stderr, "gucman: menu entry %s already exists — refusing to overwrite\n", epath);
            fail = 1;
            break;
        }
        if (symlink(cmdpath, epath) != 0) {
            fprintf(stderr, "gucman: planting %s: %s\n", epath, strerror(errno));
            fail = 1;
            break;
        }
        cJSON_AddItemToArray(db_menu, cJSON_CreateString(epath));
    }
    /* font packages (Unicode Phase D): each `fonts` entry is a packaged
     * face file appended to the /etc/fonts/fallback chain — newly started
     * apps' glyph caches (gdi32 + term, via fontchain.h) pick it up. */
    cJSON *cfonts = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "fonts");
    cJSON_ArrayForEach(it, cfonts) {
        char fpath[GM_PATH_MAX];
        if (!cJSON_IsString(it) || !gm_safe_rel(it->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed fonts entry — refusing\n", name);
            fail = 1;
            break;
        }
        snprintf(fpath, sizeof fpath, GM_OPT_DIR "/%s/%s", name, it->valuestring);
        if (!gm_exists(fpath)) {
            fprintf(stderr, "gucman: '%s' fonts %s names no packaged file — refusing\n",
                    name, it->valuestring);
            fail = 1;
            break;
        }
        if (gm_fontline_set(fpath, 1) != 0) {
            fprintf(stderr, "gucman: writing %s: %s\n", GM_FONT_LIST, strerror(errno));
            fail = 1;
            break;
        }
        cJSON_AddItemToArray(db_fonts, cJSON_CreateString(fpath));
    }

    /* Desktop shortcut (Q5 / #90): planted LAST, only for the user-requested
     * package (depth 0 — transitive library deps never clutter the desktop),
     * only when the persistent flag is on, and only when the package ships a
     * launchable command. It reuses the same symlink model as menu/bin
     * entries and is RECORDED in db_desktop so uninstall's reverse replay
     * removes exactly this and nothing else. A name collision or FS error is
     * a warning, never an install failure — the icon is cosmetic; the
     * install is not. */
    if (!fail && depth == 0 && primary[0] && gm_desktop_flag()) {
        char link[GM_PATH_MAX], target[GM_PATH_MAX];
        snprintf(link, sizeof link, GM_DESKTOP_DIR "/%s", name);
        snprintf(target, sizeof target, GM_BIN_DIR "/%s", primary);
        if (gm_exists(link)) {
            fprintf(stderr, "gucman: %s already exists — Desktop shortcut skipped\n", link);
        } else if (gm_mkdir_p(GM_DESKTOP_DIR) != 0) {
            fprintf(stderr, "gucman: %s: %s — Desktop shortcut skipped\n",
                    GM_DESKTOP_DIR, strerror(errno));
        } else if (symlink(target, link) != 0) {
            fprintf(stderr, "gucman: planting %s: %s — Desktop shortcut skipped\n",
                    link, strerror(errno));
        } else {
            cJSON_AddItemToArray(db_desktop, cJSON_CreateString(link));
        }
    }

    if (fail) {
        gm_unwind(name, &undo);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }

    /* the DB record — LAST, atomically: its existence == "installed" */
    if (gm_mkdir_p(GM_DB_DIR) != 0) {
        perror("gucman: mkdir " GM_DB_DIR);
        gm_unwind(name, &undo);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }
    cJSON *csum = cJSON_GetObjectItemCaseSensitive(control, "summary");
    if (cJSON_IsString(csum)) cJSON_AddStringToObject(db, "summary", csum->valuestring);
    char *db_text = cJSON_Print(db);
    char dbp[GM_PATH_MAX];
    gm_db_path(name, dbp, sizeof dbp);
    rc = db_text ? gm_write_file_atomic(dbp, db_text, strlen(db_text), 0644) : -1;
    free(db_text);
    cJSON_Delete(control);
    cJSON_Delete(db);
    if (rc != 0) {
        fprintf(stderr, "gucman: writing %s: %s\n", dbp, strerror(errno));
        gm_unwind(name, &undo);
        return -1;
    }
    printf("gucman: installed %s %s\n", name, jver->valuestring);
    return 0;
}

static int cmd_install(const char *name) {
    if (!gm_valid_name(name)) {
        fprintf(stderr, "gucman: '%s' is not a valid package name\n", name);
        return 1;
    }
    char dbp[GM_PATH_MAX];
    gm_db_path(name, dbp, sizeof dbp);
    if (gm_exists(dbp)) {
        cJSON *db = gm_db_load(name);
        cJSON *v = db ? cJSON_GetObjectItemCaseSensitive(db, "version") : NULL;
        printf("gucman: %s is already installed (%s)\n", name,
               cJSON_IsString(v) ? v->valuestring : "?");
        cJSON_Delete(db);
        return 0;
    }
    char base[GM_PATH_MAX];
    if (gm_repo_base(base, sizeof base) != 0) return 1;
    cJSON *index = gm_fetch_index(base);
    if (!index) return 1;
    cJSON *in_progress = cJSON_CreateObject();
    int rc = gm_install_one(base, index, name, in_progress, 0);
    cJSON_Delete(in_progress);
    cJSON_Delete(index);
    return rc == 0 ? 0 : 1;
}

/* ============================== remove ================================= */

static int cmd_remove(const char *name) {
    if (!gm_valid_name(name)) {
        fprintf(stderr, "gucman: '%s' is not a valid package name\n", name);
        return 1;
    }
    cJSON *db = gm_db_load(name);
    if (!db) {
        fprintf(stderr, "gucman: %s is not installed\n", name);
        return 1;
    }
    /* Replay the recorded plant in reverse install order. ENOENT along the
     * way is fine — a crashed remove re-runs to completion. */
    cJSON *it;
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "desktop"))
        if (cJSON_IsString(it)) unlink(it->valuestring);      /* Q5: remove the shortcut we planted */
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "font_faces"))
        if (cJSON_IsString(it)) gm_fontline_set(it->valuestring, 0);
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "menu_entries"))
        if (cJSON_IsString(it)) unlink(it->valuestring);
    /* menu dirs we created, innermost first (recorded outermost first) */
    cJSON *mdirs = cJSON_GetObjectItemCaseSensitive(db, "menu_dirs");
    for (int i = cJSON_GetArraySize(mdirs) - 1; i >= 0; i--) {
        cJSON *d = cJSON_GetArrayItem(mdirs, i);
        if (cJSON_IsString(d)) rmdir(d->valuestring);            /* ENOTEMPTY: shared now, keep */
    }
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "openwith_keys"))
        if (cJSON_IsString(it)) gm_openwith_set(it->valuestring, NULL);
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "symlinks"))
        if (cJSON_IsString(it)) unlink(it->valuestring);
    /* files, then dirs innermost-first, exactly the recorded list */
    cJSON *files = cJSON_GetObjectItemCaseSensitive(db, "files");
    for (int i = cJSON_GetArraySize(files) - 1; i >= 0; i--) {
        cJSON *f = cJSON_GetArrayItem(files, i);
        if (cJSON_IsString(f) && unlink(f->valuestring) != 0 && errno != ENOENT)
            fprintf(stderr, "gucman: removing %s: %s\n", f->valuestring, strerror(errno));
    }
    cJSON *dirs = cJSON_GetObjectItemCaseSensitive(db, "dirs");
    for (int i = cJSON_GetArraySize(dirs) - 1; i >= 0; i--) {
        cJSON *d = cJSON_GetArrayItem(dirs, i);
        if (cJSON_IsString(d) && rmdir(d->valuestring) != 0 && errno != ENOENT)
            fprintf(stderr, "gucman: removing %s: %s (kept)\n", d->valuestring, strerror(errno));
    }
    char opt[GM_PATH_MAX];
    snprintf(opt, sizeof opt, GM_OPT_DIR "/%s", name);
    if (rmdir(opt) != 0 && errno != ENOENT)
        fprintf(stderr, "gucman: removing %s: %s (kept — files not planted by gucman remain)\n",
                opt, strerror(errno));
    cJSON *v = cJSON_GetObjectItemCaseSensitive(db, "version");
    char ver[64];
    snprintf(ver, sizeof ver, "%s", cJSON_IsString(v) ? v->valuestring : "");
    cJSON_Delete(db);
    /* the DB record goes LAST — its absence == "not installed" */
    char dbp[GM_PATH_MAX];
    gm_db_path(name, dbp, sizeof dbp);
    if (unlink(dbp) != 0) {
        fprintf(stderr, "gucman: removing %s: %s\n", dbp, strerror(errno));
        return 1;
    }
    printf("gucman: removed %s %s\n", name, ver);
    return 0;
}

/* ============================ list / info ============================== */

#define GM_LIST_MAX 128

/* Collect installed package names (sorted) from the DB dir. */
static int gm_installed_names(char names[][GM_NAME_MAX], int max) {
    DIR *d = opendir(GM_DB_DIR);
    if (!d) return 0;                                            /* nothing installed yet */
    int n = 0;
    struct dirent *de;
    while ((de = readdir(d)) && n < max) {
        size_t l = strlen(de->d_name);
        if (l > 5 && strcmp(de->d_name + l - 5, ".json") == 0 && l - 5 < GM_NAME_MAX) {
            memcpy(names[n], de->d_name, l - 5);
            names[n][l - 5] = 0;
            n++;
        }
    }
    closedir(d);
    for (int i = 1; i < n; i++)
        for (int j = i; j > 0 && strcmp(names[j - 1], names[j]) > 0; j--) {
            char t[GM_NAME_MAX];
            memcpy(t, names[j - 1], sizeof t);
            memcpy(names[j - 1], names[j], sizeof t);
            memcpy(names[j], t, sizeof t);
        }
    return n;
}

struct gm_row {
    char name[GM_NAME_MAX];
    char ver[64];               /* list: installed version; --all: available */
    char inst[96];              /* --all only: "no" | "<ver>" | "<ver> (update)" */
    char summary[512];
};

static int gm_row_cmp(const void *a, const void *b) {
    return strcmp(((const struct gm_row *)a)->name, ((const struct gm_row *)b)->name);
}

/* Aligned human table. have_inst distinguishes the catalog layout
 * (NAME AVAILABLE INSTALLED SUMMARY) from the installed-only one
 * (NAME VERSION SUMMARY). Summary is last so it never needs padding. */
static void gm_row_print(struct gm_row *rows, int n, int have_inst) {
    const char *h2 = have_inst ? "AVAILABLE" : "VERSION";
    size_t wn = strlen("NAME"), wv = strlen(h2), wi = strlen("INSTALLED");
    for (int i = 0; i < n; i++) {
        if (strlen(rows[i].name) > wn) wn = strlen(rows[i].name);
        if (strlen(rows[i].ver) > wv) wv = strlen(rows[i].ver);
        if (have_inst && strlen(rows[i].inst) > wi) wi = strlen(rows[i].inst);
    }
    if (have_inst)
        printf("%-*s  %-*s  %-*s  %s\n", (int)wn, "NAME", (int)wv, h2, (int)wi, "INSTALLED", "SUMMARY");
    else
        printf("%-*s  %-*s  %s\n", (int)wn, "NAME", (int)wv, h2, "SUMMARY");
    for (int i = 0; i < n; i++) {
        if (have_inst)
            printf("%-*s  %-*s  %-*s  %s\n", (int)wn, rows[i].name, (int)wv, rows[i].ver,
                   (int)wi, rows[i].inst, rows[i].summary);
        else
            printf("%-*s  %-*s  %s\n", (int)wn, rows[i].name, (int)wv, rows[i].ver, rows[i].summary);
    }
}

static void gm_db_fields(cJSON *db, char *ver, size_t vcap, char *sum, size_t scap) {
    cJSON *v = db ? cJSON_GetObjectItemCaseSensitive(db, "version") : NULL;
    cJSON *s = db ? cJSON_GetObjectItemCaseSensitive(db, "summary") : NULL;
    if (ver) snprintf(ver, vcap, "%s", cJSON_IsString(v) ? v->valuestring : "?");
    if (sum) snprintf(sum, scap, "%s", cJSON_IsString(s) ? s->valuestring : "");
}

static int cmd_list(int all) {
    char names[GM_LIST_MAX][GM_NAME_MAX];
    int ninst = gm_installed_names(names, GM_LIST_MAX);

    if (!all) {
        if (!ninst) { printf("no packages installed\n"); return 0; }
        struct gm_row *rows = calloc((size_t)ninst, sizeof *rows);
        if (!rows) return 1;
        for (int i = 0; i < ninst; i++) {
            cJSON *db = gm_db_load(names[i]);
            snprintf(rows[i].name, sizeof rows[i].name, "%s", names[i]);
            gm_db_fields(db, rows[i].ver, sizeof rows[i].ver, rows[i].summary, sizeof rows[i].summary);
            cJSON_Delete(db);
        }
        gm_row_print(rows, ninst, 0);
        free(rows);
        return 0;
    }

    /* --all: the repository catalog, every row cross-referenced with the
     * install DB — installed y/n, at which version, update marker. */
    char base[GM_PATH_MAX];
    if (gm_repo_base(base, sizeof base) != 0) return 1;
    cJSON *index = gm_fetch_index(base);
    if (!index) return 1;
    cJSON *pkgs = cJSON_GetObjectItemCaseSensitive(index, "packages");
    int navail = 0;
    cJSON *e;
    cJSON_ArrayForEach(e, pkgs) navail++;
    const char *baked = gm_baked_list();
    int nbaked = 0;
    if (baked && *baked) {
        nbaked = 1;
        for (const char *p = baked; *p; p++) if (*p == ',') nbaked++;
    }
    struct gm_row *rows = calloc((size_t)(navail + ninst + nbaked) + 1, sizeof *rows);
    if (!rows) { cJSON_Delete(index); return 1; }
    int n = 0;
    cJSON_ArrayForEach(e, pkgs) {
        struct gm_row *r = &rows[n++];
        snprintf(r->name, sizeof r->name, "%s", e->string);
        cJSON *v = cJSON_GetObjectItemCaseSensitive(e, "version");
        cJSON *s = cJSON_GetObjectItemCaseSensitive(e, "summary");
        snprintf(r->ver, sizeof r->ver, "%s", cJSON_IsString(v) ? v->valuestring : "?");
        snprintf(r->summary, sizeof r->summary, "%s", cJSON_IsString(s) ? s->valuestring : "");
        cJSON *db = gm_db_load(e->string);
        if (!db) {
            snprintf(r->inst, sizeof r->inst, "%s",
                     gm_is_baked(e->string) ? "built-in" : "no");
        } else {
            char iv[64];
            gm_db_fields(db, iv, sizeof iv, NULL, 0);
            if (strcmp(iv, r->ver) == 0) snprintf(r->inst, sizeof r->inst, "%s", iv);
            else snprintf(r->inst, sizeof r->inst, "%s (update)", iv);
            cJSON_Delete(db);
        }
    }
    /* installed packages the index no longer carries stay honest rows */
    for (int i = 0; i < ninst; i++) {
        if (pkgs && cJSON_GetObjectItemCaseSensitive(pkgs, names[i])) continue;
        struct gm_row *r = &rows[n++];
        snprintf(r->name, sizeof r->name, "%s", names[i]);
        snprintf(r->ver, sizeof r->ver, "-");
        cJSON *db = gm_db_load(names[i]);
        char iv[64];
        gm_db_fields(db, iv, sizeof iv, r->summary, sizeof r->summary);
        snprintf(r->inst, sizeof r->inst, "%s (not in repository)", iv);
        cJSON_Delete(db);
    }
    /* baked (folded) packages the index no longer carries: still present
     * under the sealed /usr/opt, so they stay honest rows too (the
     * installed-not-in-repository rule, built-in flavored) */
    for (const char *p = baked; p && *p; ) {
        const char *c = strchr(p, ',');
        size_t l = c ? (size_t)(c - p) : strlen(p);
        char nm[GM_NAME_MAX];
        if (l && l < sizeof nm) {
            memcpy(nm, p, l);
            nm[l] = 0;
            char dbp[GM_PATH_MAX];
            gm_db_path(nm, dbp, sizeof dbp);
            if (!(pkgs && cJSON_GetObjectItemCaseSensitive(pkgs, nm)) &&
                !gm_exists(dbp)) {
                struct gm_row *r = &rows[n++];
                snprintf(r->name, sizeof r->name, "%s", nm);
                snprintf(r->ver, sizeof r->ver, "-");
                snprintf(r->inst, sizeof r->inst, "built-in (not in repository)");
            }
        }
        p = c ? c + 1 : p + l;
    }
    cJSON_Delete(index);
    qsort(rows, (size_t)n, sizeof *rows, gm_row_cmp);
    gm_row_print(rows, n, 1);
    free(rows);
    return 0;
}

/* Integer-math human size — "473.1 KiB (484467 bytes)". */
static void gm_human_size(long b, char *out, size_t cap) {
    if (b >= 1024 * 1024) {
        long x10 = (b * 10 + 524288) / 1048576;
        snprintf(out, cap, "%ld.%ld MiB (%ld bytes)", x10 / 10, x10 % 10, b);
    } else if (b >= 1024) {
        long x10 = (b * 10 + 512) / 1024;
        snprintf(out, cap, "%ld.%ld KiB (%ld bytes)", x10 / 10, x10 % 10, b);
    } else {
        snprintf(out, cap, "%ld bytes", b);
    }
}

static void gm_info_strings(cJSON *db, const char *key, const char *label) {
    cJSON *arr = db ? cJSON_GetObjectItemCaseSensitive(db, key) : NULL;
    if (!arr || cJSON_GetArraySize(arr) == 0) return;
    printf("%s\n", label);
    cJSON *it;
    cJSON_ArrayForEach(it, arr)
        if (cJSON_IsString(it)) printf("  %s\n", it->valuestring);
}

static int cmd_info(const char *name) {
    if (!gm_valid_name(name)) {
        fprintf(stderr, "gucman: '%s' is not a valid package name\n", name);
        return 1;
    }
    cJSON *db = gm_db_load(name);

    /* catalog side: the same fetch path install uses — nothing new */
    cJSON *index = NULL;
    char base[GM_PATH_MAX];
    if (gm_repo_base(base, sizeof base) == 0) index = gm_fetch_index(base);
    cJSON *pkgs = index ? cJSON_GetObjectItemCaseSensitive(index, "packages") : NULL;
    cJSON *ent = pkgs ? cJSON_GetObjectItemCaseSensitive(pkgs, name) : NULL;
    if (!ent && !db && !gm_is_baked(name)) {
        if (index)
            fprintf(stderr, "gucman: package '%s' is not installed and not in the repository index\n", name);
        cJSON_Delete(index);
        return 1;
    }
    if (!index && db)
        fprintf(stderr, "gucman: repository unavailable — showing local install state only\n");

    printf("%-11s%s\n", "package:", name);
    cJSON *esum = ent ? cJSON_GetObjectItemCaseSensitive(ent, "summary") : NULL;
    cJSON *dsum = db ? cJSON_GetObjectItemCaseSensitive(db, "summary") : NULL;
    if (cJSON_IsString(esum)) printf("%-11s%s\n", "summary:", esum->valuestring);
    else if (cJSON_IsString(dsum)) printf("%-11s%s\n", "summary:", dsum->valuestring);

    char avail[64] = "";
    if (ent) {
        cJSON *v = cJSON_GetObjectItemCaseSensitive(ent, "version");
        snprintf(avail, sizeof avail, "%s", cJSON_IsString(v) ? v->valuestring : "?");
        printf("%-11s%s\n", "available:", avail);
        cJSON *pay = cJSON_GetObjectItemCaseSensitive(ent, "payload");
        cJSON *sz = pay ? cJSON_GetObjectItemCaseSensitive(pay, "size") : NULL;
        if (cJSON_IsNumber(sz)) {
            char hs[80];
            gm_human_size((long)sz->valuedouble, hs, sizeof hs);
            printf("%-11s%s\n", "size:", hs);
        }
        cJSON *deps = cJSON_GetObjectItemCaseSensitive(ent, "deps");
        char dl[256] = "";
        size_t o = 0;
        cJSON *d;
        cJSON_ArrayForEach(d, deps) {
            if (!cJSON_IsString(d)) continue;
            o += (size_t)snprintf(dl + o, sizeof dl - o, "%s%s", o ? ", " : "", d->valuestring);
            if (o >= sizeof dl - 1) break;
        }
        printf("%-11s%s\n", "deps:", o ? dl : "(none)");
        cJSON *mb = cJSON_GetObjectItemCaseSensitive(ent, "minBase");
        if (cJSON_IsNumber(mb)) printf("%-11s%d\n", "minBase:", (int)mb->valuedouble);
    } else if (index) {
        printf("%-11s%s\n", "available:", "- (not in repository)");
    }

    if (!db) {
        printf("%-11s%s\n", "installed:", gm_is_baked(name) ? "built-in" : "no");
    } else {
        char iv[64];
        gm_db_fields(db, iv, sizeof iv, NULL, 0);
        printf("%-11syes (%s)\n", "installed:", iv);
        if (ent) {
            if (strcmp(iv, avail) == 0) printf("%-11s%s\n", "update:", "no (up to date)");
            else printf("%-11syes (%s -> %s)\n", "update:", iv, avail);
        }
        gm_info_strings(db, "files", "planted files:");
        gm_info_strings(db, "symlinks", "planted symlinks:");
        gm_info_strings(db, "openwith_keys", "openwith keys:");
        gm_info_strings(db, "menu_entries", "menu entries:");
        gm_info_strings(db, "font_faces", "font faces:");
        gm_info_strings(db, "desktop", "desktop shortcuts:");
    }
    cJSON_Delete(db);
    cJSON_Delete(index);
    return 0;
}

/* =============================== index ================================= */

/* Print the repository index RAW to stdout (the catalog surface for
 * front-ends — the storefront GUI spawns `gucman index` instead of
 * growing its own network stack; gucman stays the one engine). The bytes
 * are exactly what the repo served: front-ends parse, this never
 * reformats. Errors keep the CLI contract — stderr + exit 1. */
static int cmd_index(void) {
    char base[GM_PATH_MAX];
    if (gm_repo_base(base, sizeof base) != 0) return 1;
    struct gm_buf buf;
    if (gm_http_get(base, "index.json", &buf) != 0) return 1;
    /* validate before echoing: a broken repo fails loud, not downstream */
    cJSON *idx = cJSON_Parse(buf.p);
    if (!idx) {
        fprintf(stderr, "gucman: index.json is not valid JSON\n");
        free(buf.p);
        return 1;
    }
    cJSON_Delete(idx);
    fwrite(buf.p, 1, buf.len, stdout);
    free(buf.p);
    return 0;
}

/* =============================== main ================================== */

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "install") == 0) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        int rc = cmd_install(argv[2]);
        curl_global_cleanup();
        return rc;
    }
    if (argc >= 3 && strcmp(argv[1], "remove") == 0) return cmd_remove(argv[2]);
    if (argc == 2 && strcmp(argv[1], "list") == 0) return cmd_list(0);
    if (argc == 3 && strcmp(argv[1], "list") == 0 &&
        (strcmp(argv[2], "--all") == 0 || strcmp(argv[2], "-a") == 0)) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        int rc = cmd_list(1);
        curl_global_cleanup();
        return rc;
    }
    if (argc >= 3 && strcmp(argv[1], "info") == 0) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        int rc = cmd_info(argv[2]);
        curl_global_cleanup();
        return rc;
    }
    if (argc == 2 && strcmp(argv[1], "index") == 0) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        int rc = cmd_index();
        curl_global_cleanup();
        return rc;
    }
    fprintf(stderr,
            "usage: gucman install <name> | gucman remove <name> | gucman info <name>\n"
            "       gucman list [--all]   | gucman index (raw catalog JSON)\n");
    return 2;
}
