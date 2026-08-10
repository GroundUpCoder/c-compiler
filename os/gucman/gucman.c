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
 * its bin commands, openwith keys, command claims (todos/0338 —
 * dispatched command NAMES this package provides), menu entries, font
 * faces (fallback-
 * chain lines in /etc/fonts/fallback, Unicode Phase D), srclib tiers
 * (win32 source-lib design §3.1: header + require-source symlink farms at
 * /usr/local/include + /usr/local/src/<ns>, the standard install locations
 * the in-OS cc searches) and `seed` content (the CONTENT resource kind:
 * files COPIED into /root as the user's own, never symlinked — see the
 * seed section below); install records the
 * EXACT planted list in the install DB /var/lib/gucman/<name>.json and
 * remove replays that record in reverse.
 *
 * The postinst/prerm script hatch (ticket #74 — the narrow escape valve
 * Slice 1 reserved): control.json may name two optional payload-relative
 * scripts. They are ORDINARY payload members (sha256-verified with the
 * payload, validated by the same tar rules, recorded in `files` like any
 * other plant — never inline strings, which would be a second content
 * channel outside the recorded plant). Contract: argv[1] is the verb
 * ("install"/"remove"; an upgrade verb can slot in later), cwd is
 * /opt/<name>, env is the canonical desktop pair (PATH=/usr/local/bin:/bin,
 * HOME=/root — launch.h's LAUNCH_ENV values), stdio is inherited so script
 * output IS the progress UI, and a wall-clock bound (GM_SCRIPT_TIMEOUT_MS,
 * overridable via the GUCMAN_SCRIPT_TIMEOUT_MS env var — the test seam)
 * SIGKILLs a hung script. Ordering + failure semantics:
 *   - postinst runs AFTER the whole declarative plant and BEFORE the DB
 *     write. Failure/timeout rolls the install back COMPLETELY (gm_unwind),
 *     so the DB stays binary: record exists <=> correctly installed. A
 *     crash after postinst but before the DB write leaves a recordless
 *     /opt/<name>; the next install sweeps it and re-runs the script —
 *     scripts must tolerate re-running.
 *   - prerm runs FIRST in remove, while the package is fully intact.
 *     Failure/timeout warns loudly and the removal CONTINUES (an
 *     unremovable package is worse than a dirty one). A crash after prerm
 *     leaves the DB record; re-running remove re-runs prerm.
 *   - a script's side effects OUTSIDE the recorded plant are its own
 *     responsibility: gucman can only unwind what it tracks. A postinst
 *     that creates state must ship the prerm that removes it (a leftover
 *     under /opt/<name> surfaces as remove's "kept — files not planted by
 *     gucman remain" message).
 * HONESTY: this is NOT a sandbox — gucOS has no such primitive. The script
 * runs with gucman's full authority. What IS constrained: provenance
 * (sha256 against the index before extraction), a build-time and
 * install-time runnable check (#!/wasm magic, refused before anything
 * publishes), the fixed argv/env/cwd contract, the wall-clock bound, and
 * exit-status capture. foldPackages refuses a script-carrying definition:
 * a baked package never runs an install transaction, so folding one would
 * ship it silently unconfigured.
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
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <curl/curl.h>
#include <zlib.h>
#include "cJSON.h"
#include "fileops.h"            /* fo_delete + fo_merge: the ONE copy engine */
#include "sha256.h"             /* the ONE sha256 (shared with deskdefaults) */

#define GM_DB_DIR       "/var/lib/gucman"
#define GM_OPT_DIR      "/opt"
#define GM_REPOS_ETC    "/etc/gucman/repos"
#define GM_REPOS_USR    "/usr/share/gucman/repos"
#define GM_OPENWITH     "/etc/openwith"
#define GM_CMDALT       "/etc/cmdalt"           /* the cmdalt.h /etc layer */
#define GM_DISPATCH     "/usr/bin/cmdalt"       /* every dispatch link's inode */
#define GM_MENU_DIR     "/etc/menu"
#define GM_FONTS_DIR    "/etc/fonts"
#define GM_FONT_LIST    "/etc/fonts/fallback"   /* the fontchain.h /etc layer */
#define GM_BIN_DIR      "/usr/local/bin"
#define GM_INCLUDE_DIR  "/usr/local/include"     /* srclib header tier (§3.1) */
#define GM_SRC_DIR      "/usr/local/src"         /* srclib require-source tier */
#define GM_DESKTOP_DIR  "/root/Desktop"          /* where the wm scans icons */
#define GM_HOME         "/root"                  /* seed dests root here (§2.1) */
#define GM_DESKTOP_FLAG GM_DB_DIR "/desktop_shortcuts"  /* Q5/#90 persistent toggle */
#define GM_OS_RELEASE   "/usr/share/os-release"
#define GM_DEFAULTS_ETC "/etc/gucman/defaults"   /* #419: overrides wholesale */
#define GM_DEFAULTS_USR "/usr/share/gucman/defaults"  /* baked default set */
#define GM_REMOVED_DIR  GM_DB_DIR "/removed"     /* #419: removal tombstones */
#define GM_SYNC_STATUS  "/run/gucman-sync.status" /* #419: sync outcome record */
#define GM_NAME_MAX     64
#define GM_PATH_MAX     768
#define GM_SCRIPT_TIMEOUT_MS 120000     /* postinst/prerm wall-clock bound (#74) */

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

/* Same file THROUGH symlinks (todos/0338 — the dispatch-link test: every
 * /usr/bin/<name> dispatch link stats as the one /usr/bin/cmdalt inode). */
static int gm_same_file(const char *a, const char *b) {
    struct stat sa, sb;
    return stat(a, &sa) == 0 && stat(b, &sb) == 0 &&
           sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

static int gm_valid_name(const char *n) {
    if (!n || !*n || strlen(n) >= GM_NAME_MAX) return 0;
    if (!islower((unsigned char)n[0]) && !isdigit((unsigned char)n[0])) return 0;
    for (const char *p = n; *p; p++)
        if (!islower((unsigned char)*p) && !isdigit((unsigned char)*p) && *p != '-' && *p != '_')
            return 0;
    return 1;
}

/* srclib require namespace: [a-z0-9_-]+ (mkpkg's rule — builtin require
 * names carry no '/', so namespaced names can never collide with them). */
static int gm_valid_ns(const char *s) {
    if (!s || !*s) return 0;
    for (const char *p = s; *p; p++)
        if (!islower((unsigned char)*p) && !isdigit((unsigned char)*p) && *p != '-' && *p != '_')
            return 0;
    return 1;
}

/* One path component check: no absolute, no "..", no empty segment. The
 * implementation lives in fileops.h so desktop-defaults' seed reconcile
 * validates payload paths through exactly the same code. */
static int gm_safe_rel(const char *rel) { return fo_safe_rel(rel); }

/* A `seed` DESTINATION component check (the content resource kind, design
 * §1.3 / §2.1): gm_safe_rel PLUS "no component may start with '.'". Dests
 * are relative to /root, and hidden user territory is exactly where planting
 * a merely-ABSENT file changes system behavior — ~/.config/openwith is the
 * HIGHEST cfgstore layer (an association hijack), ~/.win32reg is the
 * registry hive, ~/.config/pinned feeds the Start menu. One rule excises the
 * channel. MUST MATCH os-common.js validateSeedShape — mkpkg and the fold
 * enforce it at build/bake time; this is the install-time layer, because the
 * engine never trusts a payload. */
static int gm_safe_seed_rel(const char *rel) { return fo_safe_seed_rel(rel); }

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

/* GET base/rel into a malloc'd buffer; 0 on HTTP 200, -1 otherwise.
 *
 * NB an empty or short body is NOT rejected here (ticket #456). A 200 that
 * ends cleanly at the HTTP level is a successful transfer by every measure
 * this layer has: a wire truncation never gets this far — the fetch under
 * the veneer rejects it, so it arrives as a curl error above — and a body
 * shorter than its own Content-Length cannot end cleanly. What DOES reach a
 * caller is a legitimately empty or legitimately short 200, and only the
 * caller knows what it expected the bytes to be. So the length question is
 * answered where the content is parsed, by gm_index_parse_error. */
static int gm_http_get(const char *base, const char *rel, struct gm_buf *out) {
    char url[GM_PATH_MAX];
    if (snprintf(url, sizeof url, "%s/%s", base, rel) >= (int)sizeof url) {
        fprintf(stderr, "gucman: URL too long\n");
        return -1;
    }
    memset(out, 0, sizeof *out);
    CURL *h = curl_easy_init();
    if (!h) { fprintf(stderr, "gucman: curl init failed\n"); return -1; }
    char errbuf[CURL_ERROR_SIZE];
    errbuf[0] = 0;
    curl_easy_setopt(h, CURLOPT_URL, url);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, gm_curl_sink);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, out);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(h, CURLOPT_ERRORBUFFER, errbuf);
    CURLcode rc = curl_easy_perform(h);
    long code = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    curl_easy_cleanup(h);
    if (rc != CURLE_OK) {
        /* #392: the errorbuffer carries the transport's own diagnostic (a
           CORS denial, a dead bridge, the refused address) — strerror alone
           said "Couldn't connect to server" for all of them. */
        fprintf(stderr, "gucman: %s: %s\n", url,
                errbuf[0] ? errbuf : curl_easy_strerror(rc));
        free(out->p);
        out->p = NULL;
        out->len = 0;
        return -1;
    }
    if (code != 200) {
        fprintf(stderr, "gucman: %s: HTTP %ld\n", url, code);
        free(out->p);
        out->p = NULL;
        out->len = 0;
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
        /* opt/<name>/control.json is RESERVED: install materializes the
         * VERIFIED top-level manifest there (below), which desktop-defaults
         * reads back to re-plant missing icons and seeds. A payload carrying
         * its own copy could forge that manifest — refuse it. */
        if (strcmp(nm + wl + 1, "control.json") == 0) {
            fprintf(stderr, "gucman: payload member '%s' is reserved (the package manifest) — refusing\n", nm);
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

/* ==================== cmdalt claim line add/remove ===================== *
 *
 * A package CLAIMS a dispatched command name (todos/0338 `commands`): one
 * "<name>\t<value>" LINE in /etc/cmdalt. Deliberately APPEND-not-replace —
 * unlike an openwith association, a command key may carry several lines
 * (that is the candidate set the picker offers, and the first line wins, so
 * the earliest-installed implementation stays the default and a later
 * install never silently steals the name). Remove deletes exactly THIS
 * key+value line, so two implementations installed and one removed leaves
 * the other's claim standing. Duplicates are idempotent: an identical line
 * is not appended twice. Removing the last line unlinks the file, so a
 * package-less system carries no empty config (the gm_fontline_set rule). */
static int gm_cmdalt_set(const char *key, const char *value, int add) {
    size_t len = 0;
    char *old = gm_read_file(GM_CMDALT, &len);
    size_t kl = strlen(key), vl = strlen(value);
    size_t cap = (old ? len : 0) + kl + vl + 16;
    char *out = malloc(cap);
    if (!out) { free(old); return -1; }
    size_t o = 0;
    if (old) {
        for (char *line = old; line && *line; ) {
            char *nl = strchr(line, '\n');
            size_t ll = nl ? (size_t)(nl - line) + 1 : strlen(line);
            size_t body = ll - (nl ? 1 : 0);
            /* the exact key+value line, whitespace between them free-form */
            int is_ours = 0;
            if (body > kl && strncmp(line, key, kl) == 0 &&
                (line[kl] == ' ' || line[kl] == '\t')) {
                const char *v = line + kl;
                while (v < line + body && (*v == ' ' || *v == '\t')) v++;
                size_t rest = (size_t)(line + body - v);
                while (rest && (v[rest - 1] == ' ' || v[rest - 1] == '\t' ||
                                v[rest - 1] == '\r')) rest--;
                is_ours = rest == vl && strncmp(v, value, vl) == 0;
            }
            if (!is_ours) { memcpy(out + o, line, ll); o += ll; }
            line = nl ? nl + 1 : NULL;
        }
    }
    if (o && out[o - 1] != '\n') out[o++] = '\n';
    if (add) o += (size_t)snprintf(out + o, cap - o, "%s\t%s\n", key, value);
    free(old);
    if (o == 0) {                        /* nothing left: drop the file */
        free(out);
        if (unlink(GM_CMDALT) != 0 && errno != ENOENT) return -1;
        return 0;
    }
    int rc = gm_write_file_atomic(GM_CMDALT, out, o, 0644);
    free(out);
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

/* Removal tombstone (#419): an empty marker at GM_REMOVED_DIR/<name>,
 * recording that the USER removed this package on purpose. The default set
 * means "install once, unless the user has ever said no" — sync-defaults
 * skips a tombstoned name forever, so a deliberate remove is durable across
 * reboots instead of degrading "first boot" into "every boot where the app
 * is missing". Written by cmd_remove BEFORE the DB record goes; cleared by
 * any successful install (the user said yes again). */
static void gm_tomb_path(const char *name, char *out, size_t cap) {
    snprintf(out, cap, GM_REMOVED_DIR "/%s", name);
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

/* A package may explicitly say its Desktop shortcut is part of the default
 * built-in surface. sync-defaults honors that bit for its top-level package;
 * ordinary desktop eligibility remains governed by the user's preference. */
static int gm_syncing_defaults;

static int gm_desktop_is_default(cJSON *desktop) {
    cJSON *d = desktop ? cJSON_GetObjectItemCaseSensitive(desktop, "default") : NULL;
    return cJSON_IsTrue(d);
}

/* ============================== install ================================ */

/* Undo bookkeeping so a failed plant unwinds what it already did (the DB
 * was not written yet, so unwinding restores the pre-install state). */
struct gm_undo {
    cJSON *symlinks;            /* array of planted symlink paths */
    cJSON *openwith;            /* array of planted keys */
    cJSON *commands;            /* array of {name,value} cmdalt claim lines */
    cJSON *menu;                /* array of planted menu entry paths */
    cJSON *menu_dirs;           /* array of menu dirs WE created */
    cJSON *fonts;               /* array of planted fallback face lines */
    cJSON *desktop;             /* array of planted Desktop shortcut paths (Q5) */
    cJSON *srclib_inc;          /* array of planted include-tier symlink paths (§3.1) */
    cJSON *srclib_ns;           /* array of planted src-namespace symlink paths */
    cJSON *srclib_dirs;         /* array of srclib tier dirs WE created */
    cJSON *seeds;               /* array of {path, sha256} planted seed files */
    cJSON *seed_dirs;           /* array of seed dirs WE created under /root */
};

static void gm_unwind(const char *name, struct gm_undo *u) {
    cJSON *it;
    cJSON_ArrayForEach(it, u->desktop) unlink(it->valuestring);
    /* Seeds unwind unconditionally — no checksum gate. These were planted
     * seconds ago in THIS run and are unedited by construction; the gate
     * exists to protect a user's later edits, which cannot exist yet. */
    cJSON_ArrayForEach(it, u->seeds) {
        cJSON *p = cJSON_GetObjectItemCaseSensitive(it, "path");
        if (cJSON_IsString(p)) unlink(p->valuestring);
    }
    for (int i = cJSON_GetArraySize(u->seed_dirs) - 1; i >= 0; i--) {
        cJSON *d = cJSON_GetArrayItem(u->seed_dirs, i);
        if (cJSON_IsString(d)) rmdir(d->valuestring);
    }
    cJSON_ArrayForEach(it, u->srclib_inc) unlink(it->valuestring);
    cJSON_ArrayForEach(it, u->srclib_ns) unlink(it->valuestring);
    cJSON_ArrayForEach(it, u->srclib_dirs) rmdir(it->valuestring);
    cJSON_ArrayForEach(it, u->fonts) gm_fontline_set(it->valuestring, 0);
    cJSON_ArrayForEach(it, u->menu) unlink(it->valuestring);
    cJSON_ArrayForEach(it, u->menu_dirs) rmdir(it->valuestring);
    cJSON_ArrayForEach(it, u->openwith) gm_openwith_set(it->valuestring, NULL);
    cJSON_ArrayForEach(it, u->commands) {
        cJSON *k = cJSON_GetObjectItemCaseSensitive(it, "name");
        cJSON *v = cJSON_GetObjectItemCaseSensitive(it, "value");
        if (cJSON_IsString(k) && cJSON_IsString(v))
            gm_cmdalt_set(k->valuestring, v->valuestring, 0);
    }
    cJSON_ArrayForEach(it, u->symlinks) unlink(it->valuestring);
    char opt[GM_PATH_MAX];
    snprintf(opt, sizeof opt, GM_OPT_DIR "/%s", name);
    fo_delete(opt);
}

/* mkdir-if-absent one srclib tier dir (/usr/local/include, /usr/local/src —
 * neither exists on a virgin root), RECORDING a dir WE created so
 * remove/unwind can rmdir it once it is empty again (the menu-dir rule). */
static int gm_tier_mkdir(const char *dir, cJSON *db_dirs) {
    if (gm_exists(dir)) return 0;
    if (mkdir(dir, 0755) != 0) {
        fprintf(stderr, "gucman: mkdir %s: %s\n", dir, strerror(errno));
        return -1;
    }
    cJSON_AddItemToArray(db_dirs, cJSON_CreateString(dir));
    return 0;
}

/* ===================== the `seed` content resource kind ================ *
 *
 * Design: ~git/meta gucos notes, "gucman `seed` — a first-class CONTENT
 * resource kind". Programs stay symlinks (the package owns the bytes);
 * CONTENT is COPIED, so the user owns their copy and may edit it. Every
 * planted file is recorded with the sha256 of the bytes AS PLANTED, which is
 * what lets remove unlink only PRISTINE copies and loudly keep edited ones
 * (§2.3) — gucman can never unlink a file it did not plant, because only
 * planted paths ever enter the record (a collision is kept and NOT recorded,
 * §2.2). */

/* mkdir-if-absent, RECORDING a dir WE created (the gm_tier_mkdir rule). */
static int gm_seed_mkdir(const char *dir, cJSON *db_dirs) {
    if (gm_exists(dir)) return 0;
    if (mkdir(dir, 0755) != 0) {
        fprintf(stderr, "gucman: mkdir %s: %s\n", dir, strerror(errno));
        return -1;
    }
    cJSON_AddItemToArray(db_dirs, cJSON_CreateString(dir));
    return 0;
}

/* mkdir -p the parent chain of /root/<dest>; the last component is the seed
 * node itself and belongs to fo_merge. */
static int gm_seed_parents(const char *dest, cJSON *db_dirs) {
    char p[GM_PATH_MAX];
    if (gm_seed_mkdir(GM_HOME, db_dirs) != 0) return -1;
    if (snprintf(p, sizeof p, GM_HOME "/%s", dest) >= (int)sizeof p) {
        errno = ENAMETOOLONG;
        fprintf(stderr, "gucman: seed dest %s: path too long\n", dest);
        return -1;
    }
    for (char *s = p + strlen(GM_HOME) + 1; *s; s++) {
        if (*s != '/') continue;
        *s = 0;
        int rc = gm_seed_mkdir(p, db_dirs);
        *s = '/';
        if (rc != 0) return -1;
    }
    return 0;
}

struct gm_seed_ctx {
    cJSON *files;               /* {path, sha256} per planted file */
    cJSON *dirs;                /* dirs the plant created */
    int err;
};

static void gm_seed_record(cJSON *arr, const char *path, const char *hex) {
    cJSON *o = cJSON_CreateObject();
    if (!o) return;
    cJSON_AddStringToObject(o, "path", path);
    cJSON_AddStringToObject(o, "sha256", hex);
    cJSON_AddItemToArray(arr, o);
}

static void gm_seed_ev(int ev, const char *path, void *ud) {
    struct gm_seed_ctx *c = (struct gm_seed_ctx *)ud;
    char hex[65];
    switch (ev) {
    case FO_MERGE_FILE:
    case FO_MERGE_LINK:
        if (sha256_path(path, hex) != 0) {
            fprintf(stderr, "gucman: hashing %s: %s\n", path, strerror(errno));
            c->err = 1;
            break;
        }
        gm_seed_record(c->files, path, hex);
        break;
    case FO_MERGE_DIR:
        cJSON_AddItemToArray(c->dirs, cJSON_CreateString(path));
        break;
    case FO_MERGE_KEPT:
        /* The user already has something here; their state is legitimate by
         * definition. Keep it, say so, do NOT record it (§2.2). */
        fprintf(stderr, "gucman: kept existing %s\n", path);
        break;
    case FO_MERGE_ERR:
        fprintf(stderr, "gucman: seeding %s: %s\n", path, strerror(errno));
        c->err = 1;
        break;
    default:
        break;                  /* NODE: the per-file records are the truth here */
    }
}

/* ================= postinst/prerm script hatch (#74) =================== */

/* The ow_is_runnable peek (openwith.h — not included here; that header is
 * the whole association resolver): a file whose first bytes are wasm magic
 * or a #! line is spawnable, anything else is refused BEFORE it can run. */
static int gm_runnable(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    unsigned char b[4];
    size_t n = fread(b, 1, 4, f);
    fclose(f);
    if (n >= 4 && b[0] == 0 && b[1] == 'a' && b[2] == 's' && b[3] == 'm') return 1;
    if (n >= 2 && b[0] == '#' && b[1] == '!') return 1;
    return 0;
}

static int gm_script_timeout_ms(void) {
    const char *e = getenv("GUCMAN_SCRIPT_TIMEOUT_MS");     /* the test seam */
    if (e && *e) {
        int v = atoi(e);
        if (v > 0) return v;
    }
    return GM_SCRIPT_TIMEOUT_MS;
}

/* Resolve + validate one script field ("postinst"/"prerm") against the
 * STAGED tree, before anything publishes. Absent -> 0 with out[0] == 0;
 * present and valid -> 0 with out = the FINAL /opt/<name>/<rel> path;
 * malformed / missing / not runnable -> -1, loudly. */
static int gm_script_field(cJSON *control, const char *key, const char *name,
                           const char *stagedir, char *out, size_t cap) {
    out[0] = 0;
    cJSON *s = cJSON_GetObjectItemCaseSensitive(control, key);
    if (!s) return 0;
    if (!cJSON_IsString(s) || !gm_safe_rel(s->valuestring)) {
        fprintf(stderr, "gucman: '%s' has a malformed %s entry — refusing\n", name, key);
        return -1;
    }
    char staged[GM_PATH_MAX];
    if (snprintf(staged, sizeof staged, "%s/%s", stagedir, s->valuestring) >= (int)sizeof staged ||
        snprintf(out, cap, GM_OPT_DIR "/%s/%s", name, s->valuestring) >= (int)cap) {
        fprintf(stderr, "gucman: '%s' %s path too long — refusing\n", name, key);
        return -1;
    }
    struct stat st;
    if (stat(staged, &st) != 0 || !S_ISREG(st.st_mode)) {
        fprintf(stderr, "gucman: '%s' %s %s names no packaged file — refusing\n",
                name, key, s->valuestring);
        return -1;
    }
    if (!gm_runnable(staged)) {
        fprintf(stderr, "gucman: '%s' %s %s is not runnable (no #! line or wasm magic) — refusing\n",
                name, key, s->valuestring);
        return -1;
    }
    return 0;
}

/* Run one package script synchronously: the cmdalt.c spawn-and-wait shape
 * (posix_spawn — the kernel's #! re-dispatch runs the interpreter line —
 * then reap), with a WNOHANG poll instead of a blocking waitpid so the
 * wall-clock bound can SIGKILL a hung script (there is no SIGALRM to lean
 * on; the 50 ms tick is a bounded supervision poll, not a sync primitive).
 * The child inherits gucman's stdio (script output IS the progress UI) and
 * pgroup (a tty ^C reaches it), gets the fixed verb argv and the canonical
 * desktop env, and runs with cwd /opt/<name>. Returns 0 only for exit(0);
 * every other outcome is reported here, loudly, with its cause. */
static int gm_run_script(const char *path, const char *verb, const char *name) {
    char cwd[GM_PATH_MAX], pdir[GM_PATH_MAX];
    snprintf(pdir, sizeof pdir, GM_OPT_DIR "/%s", name);
    if (!getcwd(cwd, sizeof cwd)) cwd[0] = 0;
    if (chdir(pdir) != 0) {
        fprintf(stderr, "gucman: %s %s: chdir %s: %s\n", name, verb, pdir, strerror(errno));
        return -1;
    }
    char *argv[3] = { (char *)path, (char *)verb, 0 };
    static char *const envp[] = { "PATH=/usr/local/bin:/bin", "HOME=/root", 0 };
    pid_t pid;
    int rc = posix_spawn(&pid, path, 0, 0, argv, envp);
    /* the spawn snapshot took the child's cwd; restore ours right away */
    if (cwd[0]) chdir(cwd);
    if (rc != 0) {
        fprintf(stderr, "gucman: running %s: %s\n", path, strerror(rc));
        return -1;
    }
    int timeout = gm_script_timeout_ms(), waited = 0, status = 0;
    for (;;) {
        pid_t r = waitpid(pid, &status, WNOHANG);
        if (r == pid) break;
        if (r < 0 && errno != EINTR) {
            fprintf(stderr, "gucman: waitpid %s: %s\n", path, strerror(errno));
            return -1;
        }
        if (waited >= timeout) {
            fprintf(stderr, "gucman: %s script %s did not finish within %d ms — killing it\n",
                    verb, path, timeout);
            kill(pid, SIGKILL);
            while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
            return -1;
        }
        usleep(50 * 1000);
        waited += 50;
    }
    if (WIFSIGNALED(status)) {
        fprintf(stderr, "gucman: %s script %s was killed by signal %d\n",
                verb, path, WTERMSIG(status));
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "gucman: %s script %s exited %d\n",
                verb, path, WIFEXITED(status) ? WEXITSTATUS(status) : -1);
        return -1;
    }
    return 0;
}

/* The ONE report for every way index.json can fail to parse — naming WHICH
 * one it was (ticket #456). The old text was the bare sentence "gucman:
 * index.json is not valid JSON", which reads as "this repository is
 * corrupt" whether the body was 31 KB of malformed JSON, a body cut short,
 * or nothing at all. Those are different faults with different owners, and
 * collapsing them is why one intermittent occurrence of the EMPTY case cost
 * two investigations: the artifact that would have identified it in a line
 * — how many bytes arrived — was the one fact the message threw away.
 * `buf->p` is NULL for a zero-length body, which is also why the old call
 * handed cJSON_Parse a NULL pointer. */
static void gm_index_parse_error(const char *base, const struct gm_buf *buf) {
    if (!buf->p || buf->len == 0) {
        fprintf(stderr, "gucman: %s/index.json: HTTP 200 with an EMPTY body — the repository "
                "served no index at all (a proxy, or a partial publish; not malformed JSON)\n", base);
        return;
    }
    const char *err = cJSON_GetErrorPtr();
    unsigned long off = (err && err >= buf->p && err <= buf->p + buf->len)
                      ? (unsigned long)(err - buf->p) : 0UL;
    char head[41];
    size_t n = buf->len < sizeof head - 1 ? buf->len : sizeof head - 1;
    memcpy(head, buf->p, n);
    head[n] = 0;
    for (size_t i = 0; i < n; i++)
        if ((unsigned char)head[i] < 0x20 || (unsigned char)head[i] > 0x7e) head[i] = '.';
    fprintf(stderr, "gucman: %s/index.json is not valid JSON — %lu byte(s) received, parse "
            "stopped at offset %lu; body starts \"%s\"\n",
            base, (unsigned long)buf->len, off, head);
}

static cJSON *gm_fetch_index(const char *base) {
    struct gm_buf buf;
    if (gm_http_get(base, "index.json", &buf) != 0) return NULL;
    cJSON *idx = buf.p ? cJSON_Parse(buf.p) : NULL;
    if (!idx) gm_index_parse_error(base, &buf);
    free(buf.p);
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
    cJSON *db_cmd = cJSON_AddArrayToObject(db, "commands");
    cJSON *db_menu = cJSON_AddArrayToObject(db, "menu_entries");
    cJSON *db_menu_dirs = cJSON_AddArrayToObject(db, "menu_dirs");
    cJSON *db_fonts = cJSON_AddArrayToObject(db, "font_faces");
    cJSON *db_desktop = cJSON_AddArrayToObject(db, "desktop");
    cJSON *db_inc = cJSON_AddArrayToObject(db, "include_entries");
    cJSON *db_srcns = cJSON_AddArrayToObject(db, "src_namespaces");
    cJSON *db_sldirs = cJSON_AddArrayToObject(db, "srclib_dirs");
    cJSON *db_seeds = cJSON_AddArrayToObject(db, "seeds");
    cJSON *db_seed_dirs = cJSON_AddArrayToObject(db, "seed_dirs");

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
    cJSON *cname = control ? cJSON_GetObjectItemCaseSensitive(control, "name") : NULL;
    if (!control || !cJSON_IsString(cname) || strcmp(cname->valuestring, name) != 0) {
        fprintf(stderr, "gucman: '%s' control.json is missing or names a different package — refusing\n", name);
        fo_delete(stage);
        free(control_text);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }
    /* The #74 script hatch: validate both fields against the STAGED tree —
     * a malformed, missing or non-runnable script refuses the install with
     * nothing published (only staging to sweep). The FINAL paths go into
     * the DB record: remove replays the RECORD, never the manifest, and
     * `gucman info` can tell the truth about what hooks a package carries. */
    char post_path[GM_PATH_MAX], prerm_path[GM_PATH_MAX];
    if (gm_script_field(control, "postinst", name, stage, post_path, sizeof post_path) != 0 ||
        gm_script_field(control, "prerm", name, stage, prerm_path, sizeof prerm_path) != 0) {
        fo_delete(stage);
        free(control_text);
        cJSON_Delete(control);
        cJSON_Delete(db);
        return -1;
    }
    if (post_path[0]) cJSON_AddStringToObject(db, "postinst", post_path);
    if (prerm_path[0]) cJSON_AddStringToObject(db, "prerm", prerm_path);
    /* Materialize the VERIFIED manifest at /opt/<name>/control.json (written
     * into the staging dir, so it publishes atomically with the tree and is
     * recorded in db_files like any other planted file). This is the twin of
     * the fold's /usr/opt/<name>/control.json: it is what lets
     * desktop-defaults reconcile installed AND built-in packages through one
     * code path — and without it, its phase 2 could never see an install's
     * declarations at all (the payload never carried this file). The tar
     * validator reserves the member name, so nothing can forge it. */
    {
        char cpath[GM_PATH_MAX], cfin[GM_PATH_MAX];
        snprintf(cpath, sizeof cpath, "%s/control.json", stage);
        snprintf(cfin, sizeof cfin, GM_OPT_DIR "/%s/control.json", name);
        if (gm_write_file_atomic(cpath, control_text, strlen(control_text), 0644) != 0) {
            fprintf(stderr, "gucman: writing %s: %s\n", cfin, strerror(errno));
            fo_delete(stage);
            free(control_text);
            cJSON_Delete(control);
            cJSON_Delete(db);
            return -1;
        }
        cJSON_AddItemToArray(db_files, cJSON_CreateString(cfin));
    }
    free(control_text);

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
    struct gm_undo undo = { db_links, db_ow, db_cmd, db_menu, db_menu_dirs, db_fonts, db_desktop,
                            db_inc, db_srcns, db_sldirs, db_seeds, db_seed_dirs };
    int fail = 0;
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
        /* todos/0338: never plant over a name the base image DISPATCHES.
         * /usr/local/bin precedes /bin on PATH and /var/local is user
         * territory an image upgrade never rewrites, so this link would
         * shadow /usr/bin/<cmd> -> /usr/bin/cmdalt forever, and the only
         * symptom is "switching the default does nothing". mkpkg refuses to
         * BUILD such a definition (the folded twin is claim()'s throw); this
         * is the runtime backstop for a payload that arrived another way.
         * The right declaration is `commands`, which appends to /etc/cmdalt. */
        {
            char disp[GM_PATH_MAX];
            snprintf(disp, sizeof disp, "/usr/bin/%s", it->string);
            if (gm_same_file(disp, GM_DISPATCH)) {
                fprintf(stderr, "gucman: '%s' bin %s would shadow the command "
                        "dispatcher at %s — refusing (declare a `commands` "
                        "claim instead)\n", name, it->string, disp);
                fail = 1;
                break;
            }
        }
        if (symlink(target, link) != 0) {
            fprintf(stderr, "gucman: planting %s: %s\n", link, strerror(errno));
            fail = 1;
            break;
        }
        cJSON_AddItemToArray(db_links, cJSON_CreateString(link));
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
    /* `commands` (todos/0338): claim a dispatched command NAME. The value
     * names one of this package's own bin commands, and the claim line
     * points at the /usr/local/bin symlink we just planted — so the claim
     * dies with the package even if someone edits /etc/cmdalt by hand.
     * APPEND, never replace: the key's candidate list is the point. */
    cJSON *ccmd = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "commands");
    cJSON_ArrayForEach(it, ccmd) {
        char cmdpath[GM_PATH_MAX];
        if (!cJSON_IsString(it) || !gm_valid_name(it->string) ||
            !cbin || !cJSON_GetObjectItemCaseSensitive(cbin, it->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed commands entry — refusing\n", name);
            fail = 1;
            break;
        }
        snprintf(cmdpath, sizeof cmdpath, GM_BIN_DIR "/%s", it->valuestring);
        if (gm_cmdalt_set(it->string, cmdpath, 1) != 0) {
            fprintf(stderr, "gucman: writing %s: %s\n", GM_CMDALT, strerror(errno));
            fail = 1;
            break;
        }
        cJSON *rec = cJSON_CreateObject();
        cJSON_AddStringToObject(rec, "name", it->string);
        cJSON_AddStringToObject(rec, "value", cmdpath);
        cJSON_AddItemToArray(db_cmd, rec);
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

    /* Source-lib plant (win32 source-lib design §3.1): a package carrying
     * `srclib` exposes headers and require-able sources at the standard
     * install locations the in-OS cc searches (os-common createCcDriver:
     * /usr/local/include, /usr/local/src). Both tiers are symlink farms
     * over the payload, mirroring the bin plant: per TOP-LEVEL entry for
     * each `include` dir (files or subdirs, so a freetype/ header tree
     * rides as one link), one link per `src` require namespace. Same
     * refuse-on-exists + unwind rules; recorded in the DB so remove
     * replays them exactly. */
    cJSON *csl = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "srclib");
    cJSON *sinc = csl ? cJSON_GetObjectItemCaseSensitive(csl, "include") : NULL;
    cJSON_ArrayForEach(it, sinc) {
        char pdir[GM_PATH_MAX];
        if (!cJSON_IsString(it) || !gm_safe_rel(it->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed srclib include entry — refusing\n", name);
            fail = 1;
            break;
        }
        snprintf(pdir, sizeof pdir, GM_OPT_DIR "/%s/%s", name, it->valuestring);
        DIR *d = opendir(pdir);
        if (!d) {
            fprintf(stderr, "gucman: '%s' srclib include %s names no packaged dir — refusing\n",
                    name, it->valuestring);
            fail = 1;
            break;
        }
        if (gm_tier_mkdir(GM_INCLUDE_DIR, db_sldirs) != 0) {
            closedir(d);
            fail = 1;
            break;
        }
        struct dirent *de;
        while (!fail && (de = readdir(d)) != NULL) {
            if (de->d_name[0] == '.') continue;
            char link[GM_PATH_MAX], target[GM_PATH_MAX];
            if (snprintf(link, sizeof link, GM_INCLUDE_DIR "/%s", de->d_name) >= (int)sizeof link ||
                snprintf(target, sizeof target, "%s/%s", pdir, de->d_name) >= (int)sizeof target) {
                fprintf(stderr, "gucman: srclib include path too long — refusing\n");
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
            cJSON_AddItemToArray(db_inc, cJSON_CreateString(link));
        }
        closedir(d);
        if (fail) break;
    }
    cJSON *ssrc = (fail || !csl) ? NULL : cJSON_GetObjectItemCaseSensitive(csl, "src");
    cJSON_ArrayForEach(it, ssrc) {
        char link[GM_PATH_MAX], target[GM_PATH_MAX];
        struct stat sst;
        /* '.' names the PAYLOAD ROOT (todos #407): the mechanical -sources
         * packages mount their whole repo-mirroring payload as the
         * namespace. MUST MATCH os-common.js validateSrclibShape. */
        int isroot = cJSON_IsString(it) && strcmp(it->valuestring, ".") == 0;
        if (!cJSON_IsString(it) || !gm_valid_ns(it->string) ||
            (!isroot && !gm_safe_rel(it->valuestring))) {
            fprintf(stderr, "gucman: '%s' has a malformed srclib src entry — refusing\n", name);
            fail = 1;
            break;
        }
        if (isroot)
            snprintf(target, sizeof target, GM_OPT_DIR "/%s", name);
        else
            snprintf(target, sizeof target, GM_OPT_DIR "/%s/%s", name, it->valuestring);
        if (stat(target, &sst) != 0 || !S_ISDIR(sst.st_mode)) {
            fprintf(stderr, "gucman: '%s' srclib namespace %s -> %s names no packaged dir — refusing\n",
                    name, it->string, it->valuestring);
            fail = 1;
            break;
        }
        if (gm_tier_mkdir(GM_SRC_DIR, db_sldirs) != 0) {
            fail = 1;
            break;
        }
        snprintf(link, sizeof link, GM_SRC_DIR "/%s", it->string);
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
        cJSON_AddItemToArray(db_srcns, cJSON_CreateString(link));
    }

    /* The `seed` content plant (design §3.2): planted after every system
     * integration point and before the cosmetic Desktop shortcut. Unlike
     * that shortcut, a failure here IS an install failure — for a content
     * package the seeds ARE the product — and gm_unwind removes exactly what
     * this recorded. Dests are always under /root: system integration points
     * already have TYPED resources with delta-write remove semantics (bin,
     * openwith, menu, fonts, srclib), and a raw copy into /etc would bypass
     * every one of those conventions (§2.1). */
    cJSON *cseed = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "seed");
    cJSON_ArrayForEach(it, cseed) {
        char abssrc[GM_PATH_MAX], absdst[GM_PATH_MAX];
        if (!cJSON_IsString(it) || !it->string ||
            !gm_safe_seed_rel(it->string) || !gm_safe_rel(it->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed seed entry — refusing\n", name);
            fail = 1;
            break;
        }
        if (snprintf(abssrc, sizeof abssrc, GM_OPT_DIR "/%s/%s", name, it->valuestring) >= (int)sizeof abssrc ||
            snprintf(absdst, sizeof absdst, GM_HOME "/%s", it->string) >= (int)sizeof absdst) {
            fprintf(stderr, "gucman: '%s' seed path too long — refusing\n", name);
            fail = 1;
            break;
        }
        if (!gm_exists(abssrc)) {
            fprintf(stderr, "gucman: '%s' seed %s -> %s names no packaged file — refusing\n",
                    name, it->string, it->valuestring);
            fail = 1;
            break;
        }
        if (gm_seed_parents(it->string, db_seed_dirs) != 0) { fail = 1; break; }
        struct gm_seed_ctx sctx = { db_seeds, db_seed_dirs, 0 };
        if (fo_merge(abssrc, absdst, gm_seed_ev, &sctx) != 0 || sctx.err) {
            fprintf(stderr, "gucman: '%s' seeding %s failed — refusing\n", name, absdst);
            fail = 1;
            break;
        }
    }

    /* Desktop shortcut (Q5 / #90; explicit eligibility per the win32
     * source-lib design §5): planted LAST, only for the user-requested
     * package (depth 0 — transitive library deps never clutter the desktop),
     * only when the persistent flag is on, and only when control.json
     * DECLARES eligibility via `desktop: {cmd}` — mkpkg validates cmd
     * against `bin` at package-build time, so eligibility is data, not a
     * heuristic: a CLI tool or library ships no field and never gets an
     * icon, whatever it plants in /usr/local/bin. It reuses the same
     * symlink model as menu/bin entries and is RECORDED in db_desktop so
     * uninstall's reverse replay removes exactly this and nothing else. A
     * name collision, malformed field or FS error is a warning, never an
     * install failure — the icon is cosmetic; the install is not. */
    cJSON *cdesk = fail ? NULL : cJSON_GetObjectItemCaseSensitive(control, "desktop");
    if (cdesk && depth == 0 &&
        (gm_desktop_flag() || (gm_syncing_defaults && gm_desktop_is_default(cdesk)))) {
        cJSON *dcmd = cJSON_GetObjectItemCaseSensitive(cdesk, "cmd");
        if (!cJSON_IsString(dcmd) || !gm_valid_name(dcmd->valuestring) ||
            !cbin || !cJSON_GetObjectItemCaseSensitive(cbin, dcmd->valuestring)) {
            fprintf(stderr, "gucman: '%s' has a malformed desktop entry — shortcut skipped\n", name);
        } else {
            char link[GM_PATH_MAX], target[GM_PATH_MAX];
            snprintf(link, sizeof link, GM_DESKTOP_DIR "/%s", name);
            snprintf(target, sizeof target, GM_BIN_DIR "/%s", dcmd->valuestring);
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
    }

    /* postinst (#74): the LAST act before the DB write — the whole
     * declarative plant is in place, so the script sees the package exactly
     * as a user would. A failure/timeout joins the plant-failure path below
     * and unwinds EVERYTHING (the DB stays binary: record <=> installed).
     * A crash right after the script leaves a recordless /opt/<name>, which
     * the next install sweeps and re-runs — scripts must tolerate re-runs. */
    if (!fail && post_path[0]) {
        printf("gucman: running %s postinst...\n", name);
        fflush(stdout);
        if (gm_run_script(post_path, "install", name) != 0) {
            fprintf(stderr, "gucman: '%s' postinst failed — rolling back the install\n", name);
            fail = 1;
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
    /* #419: a successful install clears the name's removal tombstone — an
     * explicit install is the user saying yes again (ENOENT: never removed). */
    char tomb[GM_PATH_MAX];
    gm_tomb_path(name, tomb, sizeof tomb);
    unlink(tomb);
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
    /* prerm (#74) runs FIRST, while the package is fully intact — the
     * script may need the package's own files. Failure or timeout is loud
     * but NEVER blocks the removal (an unremovable package is worse than a
     * dirty one); a crash after prerm leaves the DB record, so re-running
     * remove re-runs prerm. */
    cJSON *jprerm = cJSON_GetObjectItemCaseSensitive(db, "prerm");
    if (cJSON_IsString(jprerm)) {
        if (!gm_exists(jprerm->valuestring)) {
            fprintf(stderr, "gucman: %s prerm %s is gone — skipped\n",
                    name, jprerm->valuestring);
        } else {
            printf("gucman: running %s prerm...\n", name);
            fflush(stdout);
            if (gm_run_script(jprerm->valuestring, "remove", name) != 0)
                fprintf(stderr, "gucman: '%s' prerm failed — removing anyway\n", name);
        }
    }
    /* Replay the recorded plant in reverse install order. ENOENT along the
     * way is fine — a crashed remove re-runs to completion. */
    cJSON *it;
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "desktop"))
        if (cJSON_IsString(it)) unlink(it->valuestring);      /* Q5: remove the shortcut we planted */
    /* Seeds (the content resource kind, design §2.3): the copy exists so the
     * user can EDIT it, so remove is checksum-gated. Pristine == package
     * residue (identical bytes still sit in /opt) and goes; anything else is
     * the user's data and stays, loudly. A path that is simply gone is fine
     * (they deleted it) — remove's ENOENT tolerance. */
    cJSON *seeds = cJSON_GetObjectItemCaseSensitive(db, "seeds");
    for (int i = cJSON_GetArraySize(seeds) - 1; i >= 0; i--) {
        cJSON *s = cJSON_GetArrayItem(seeds, i);
        cJSON *p = cJSON_GetObjectItemCaseSensitive(s, "path");
        cJSON *h = cJSON_GetObjectItemCaseSensitive(s, "sha256");
        if (!cJSON_IsString(p) || !cJSON_IsString(h)) continue;
        struct stat sst;
        if (lstat(p->valuestring, &sst) != 0) continue;       /* already gone */
        char hex[65];
        if (sha256_path(p->valuestring, hex) == 0 && strcmp(hex, h->valuestring) == 0) {
            if (unlink(p->valuestring) != 0 && errno != ENOENT)
                fprintf(stderr, "gucman: removing %s: %s\n", p->valuestring, strerror(errno));
        } else {
            fprintf(stderr, "gucman: kept %s (modified since install)\n", p->valuestring);
        }
    }
    /* seed dirs we created, innermost first — one holding a kept-modified or
     * user-added file survives on ENOTEMPTY, automatically. */
    cJSON *sdirs = cJSON_GetObjectItemCaseSensitive(db, "seed_dirs");
    for (int i = cJSON_GetArraySize(sdirs) - 1; i >= 0; i--) {
        cJSON *d = cJSON_GetArrayItem(sdirs, i);
        if (cJSON_IsString(d)) rmdir(d->valuestring);
    }
    /* srclib plants (§3.1): the include-tier and namespace symlinks, then
     * the tier dirs WE created — innermost-first replay like menu_dirs;
     * rmdir on a now-shared (non-empty) tier just keeps it. */
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "include_entries"))
        if (cJSON_IsString(it)) unlink(it->valuestring);
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "src_namespaces"))
        if (cJSON_IsString(it)) unlink(it->valuestring);
    cJSON *sldirs = cJSON_GetObjectItemCaseSensitive(db, "srclib_dirs");
    for (int i = cJSON_GetArraySize(sldirs) - 1; i >= 0; i--) {
        cJSON *d = cJSON_GetArrayItem(sldirs, i);
        if (cJSON_IsString(d)) rmdir(d->valuestring);         /* ENOTEMPTY: shared now, keep */
    }
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
    /* cmdalt claims: delete exactly the recorded key+value LINE, never the
     * key — another implementation's claim on the same name must survive. */
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(db, "commands")) {
        cJSON *k = cJSON_GetObjectItemCaseSensitive(it, "name");
        cJSON *v = cJSON_GetObjectItemCaseSensitive(it, "value");
        if (cJSON_IsString(k) && cJSON_IsString(v))
            gm_cmdalt_set(k->valuestring, v->valuestring, 0);
    }
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
    /* #419: the removal tombstone, BEFORE the DB record goes — a crash
     * between the two leaves the package installed (re-run remove); the
     * reverse order would leave it removed but tombstone-less, which is
     * exactly the resurrection bug sync-defaults must never ship. Failure
     * is loud but non-fatal: the remove is the user's command. */
    char tomb[GM_PATH_MAX];
    gm_tomb_path(name, tomb, sizeof tomb);
    if (gm_mkdir_p(GM_REMOVED_DIR) != 0 || gm_write_file_atomic(tomb, "", 0, 0644) != 0)
        fprintf(stderr, "gucman: warning: could not record the removal of %s (%s) — "
                        "a defaults sync may reinstall it\n", name, strerror(errno));
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

/* The `commands` array is object-shaped too ({name, value} — remove deletes
 * that exact claim LINE, not the key), so it gets its own printer. */
static void gm_info_commands(cJSON *db) {
    cJSON *arr = db ? cJSON_GetObjectItemCaseSensitive(db, "commands") : NULL;
    if (!arr || cJSON_GetArraySize(arr) == 0) return;
    printf("command claims:\n");
    cJSON *it;
    cJSON_ArrayForEach(it, arr) {
        cJSON *k = cJSON_GetObjectItemCaseSensitive(it, "name");
        cJSON *v = cJSON_GetObjectItemCaseSensitive(it, "value");
        if (cJSON_IsString(k) && cJSON_IsString(v))
            printf("  %s -> %s\n", k->valuestring, v->valuestring);
    }
}

/* The `seeds` array is the one object-shaped record (path + sha256), so it
 * needs its own printer — and re-hashing each entry is what makes the list
 * honest about what remove will actually do. */
static void gm_info_seeds(cJSON *db) {
    cJSON *arr = db ? cJSON_GetObjectItemCaseSensitive(db, "seeds") : NULL;
    if (!arr || cJSON_GetArraySize(arr) == 0) return;
    printf("seeded files:\n");
    cJSON *it;
    cJSON_ArrayForEach(it, arr) {
        cJSON *p = cJSON_GetObjectItemCaseSensitive(it, "path");
        cJSON *h = cJSON_GetObjectItemCaseSensitive(it, "sha256");
        if (!cJSON_IsString(p)) continue;
        char hex[65];
        const char *mark = "";
        if (!gm_exists(p->valuestring)) mark = " (deleted)";
        else if (!cJSON_IsString(h) || sha256_path(p->valuestring, hex) != 0 ||
                 strcmp(hex, h->valuestring) != 0) mark = " (modified)";
        printf("  %s%s\n", p->valuestring, mark);
    }
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
        gm_info_commands(db);
        gm_info_strings(db, "menu_entries", "menu entries:");
        gm_info_strings(db, "font_faces", "font faces:");
        gm_info_strings(db, "desktop", "desktop shortcuts:");
        gm_info_strings(db, "include_entries", "include entries:");
        gm_info_strings(db, "src_namespaces", "source namespaces:");
        gm_info_seeds(db);
        cJSON *ps = cJSON_GetObjectItemCaseSensitive(db, "postinst");
        cJSON *pr = cJSON_GetObjectItemCaseSensitive(db, "prerm");
        if (cJSON_IsString(ps)) printf("%-11s%s\n", "postinst:", ps->valuestring);
        if (cJSON_IsString(pr)) printf("%-11s%s\n", "prerm:", pr->valuestring);
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
    cJSON *idx = buf.p ? cJSON_Parse(buf.p) : NULL;
    if (!idx) {
        gm_index_parse_error(base, &buf);
        free(buf.p);
        return 1;
    }
    cJSON_Delete(idx);
    fwrite(buf.p, 1, buf.len, stdout);
    free(buf.p);
    return 0;
}

/* ========================= sync-defaults (#419) ======================== */

/* Eager default-package install — the boot-time arm of "not baked but still
 * feels built-in" (design fork closed by jku 2026-08-03: eager on first
 * boot; a font default is pulled in by a glyph-cache miss, not a click, so
 * the trigger must be the boot, not a launch). The embedders (os/boot.js,
 * os/kernel-worker.js) spawn `gucman sync-defaults` as a kernel service
 * right after /bin/wm, on any boot where a defaults list exists at all;
 * service fd 1/2 route to the boot console in both hosts, so this command's
 * output IS the progress/failure UI.
 *
 * The default set: GM_DEFAULTS_ETC if it exists, else GM_DEFAULTS_USR (the
 * repos-file rule — /etc overrides wholesale). One name per line, `#`
 * comments. The baked file is derived from os/image.json `defaultPackages`
 * by bakeSystemImage, so a new default reaches cached installs through the
 * normal blob-upgrade wire.
 *
 * Skip rules — "install once, unless the user has ever said no": a name is
 * skipped when already installed (DB record), baked into the sealed /usr
 * (os-release PACKAGES=), or tombstoned by a deliberate remove
 * (GM_REMOVED_DIR — see cmd_remove). A FAILED install is NOT tombstoned:
 * the next boot retries it. The no-work path touches no network and prints
 * nothing (boots must stay byte-clean); one bad name does not stop the
 * rest.
 *
 * Outcome record: GM_SYNC_STATUS, written atomically at every conclusion —
 * line 1 `ok`/`failed`, then `installed <name>` / `failed <name>` lines.
 * The machine-readable completion marker for tests and front-ends; /run
 * persists on the root volume, so each run simply overwrites the last. */

#define GM_SYNC_MAX 64

struct gm_sync_log {
    char notes[8192];
    size_t len;
    int installed, failed;
};

static void gm_sync_note(struct gm_sync_log *sl, const char *verb, const char *name) {
    if (sl->len < sizeof sl->notes - 1)
        sl->len += (size_t)snprintf(sl->notes + sl->len, sizeof sl->notes - sl->len,
                                    "%s %s\n", verb, name);
    if (verb[0] == 'i') sl->installed++; else sl->failed++;
}

static void gm_sync_status(const struct gm_sync_log *sl) {
    static char text[sizeof sl->notes + 16];    /* off the 64K wasm stack */
    int n = snprintf(text, sizeof text, "%s\n%s", sl->failed ? "failed" : "ok", sl->notes);
    gm_mkdir_p("/run");                     /* virgin root volumes have it; be safe */
    if (gm_write_file_atomic(GM_SYNC_STATUS, text, (size_t)n, 0644) != 0)
        fprintf(stderr, "gucman: writing " GM_SYNC_STATUS ": %s\n", strerror(errno));
}

/* A folded default has no install transaction or DB record, but its verified
 * control.json is the baked twin of that transaction. Plant only shortcuts
 * explicitly marked as default surface; plain `desktop: {cmd}` packages such
 * as doom remain opt-in. */
static void gm_sync_baked_desktop(const char *name) {
    char control_path[GM_PATH_MAX];
    snprintf(control_path, sizeof control_path, "/usr/opt/%s/control.json", name);
    size_t len;
    char *text = gm_read_file(control_path, &len);
    if (!text) return;
    cJSON *control = cJSON_ParseWithLength(text, len);
    free(text);
    if (!control) return;
    cJSON *desk = cJSON_GetObjectItemCaseSensitive(control, "desktop");
    cJSON *cmd = desk ? cJSON_GetObjectItemCaseSensitive(desk, "cmd") : NULL;
    cJSON *bin = cJSON_GetObjectItemCaseSensitive(control, "bin");
    if (gm_desktop_is_default(desk) && cJSON_IsString(cmd) &&
        gm_valid_name(cmd->valuestring) && cJSON_IsObject(bin) &&
        cJSON_GetObjectItemCaseSensitive(bin, cmd->valuestring)) {
        char link[GM_PATH_MAX], target[GM_PATH_MAX];
        snprintf(link, sizeof link, GM_DESKTOP_DIR "/%s", name);
        snprintf(target, sizeof target, "/usr/bin/%s", cmd->valuestring);
        if (!gm_exists(link) && gm_mkdir_p(GM_DESKTOP_DIR) == 0 &&
            symlink(target, link) != 0)
            fprintf(stderr, "gucman: planting %s: %s — Desktop shortcut skipped\n",
                    link, strerror(errno));
    }
    cJSON_Delete(control);
}

static int cmd_sync_defaults(void) {
    size_t len;
    char *text = gm_read_file(GM_DEFAULTS_ETC, &len);
    if (!text) text = gm_read_file(GM_DEFAULTS_USR, &len);
    if (!text) return 0;                    /* no default set declared: nothing to
                                             * do, nothing to write, nothing to say */
    static struct gm_sync_log sl;               /* zeroed; off the 64K wasm stack */
    static char want[GM_SYNC_MAX][GM_NAME_MAX];
    int nwant = 0;
    char *save = text;
    for (char *line = text; line && *line; ) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        while (*line == ' ' || *line == '\t') line++;
        char *end = line + strlen(line);
        while (end > line && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) *--end = 0;
        if (*line && *line != '#') {
            if (!gm_valid_name(line)) {
                fprintf(stderr, "gucman: defaults: '%s' is not a valid package name — skipped\n", line);
                sl.failed++;
            } else if (nwant >= GM_SYNC_MAX) {
                fprintf(stderr, "gucman: defaults: more than %d names — '%s' and the rest skipped\n",
                        GM_SYNC_MAX, line);
                sl.failed++;
            } else {
                char dbp[GM_PATH_MAX], tomb[GM_PATH_MAX];
                gm_db_path(line, dbp, sizeof dbp);
                gm_tomb_path(line, tomb, sizeof tomb);
                if (!gm_exists(dbp) && !gm_exists(tomb)) {
                    if (gm_is_baked(line)) gm_sync_baked_desktop(line);
                    else snprintf(want[nwant++], GM_NAME_MAX, "%s", line);
                }
            }
        }
        line = nl ? nl + 1 : NULL;
    }
    free(save);

    if (nwant == 0 && sl.failed == 0) {     /* the every-boot fast path: no
                                             * network, no output */
        gm_sync_status(&sl);
        return 0;
    }

    if (nwant > 0) {
        printf("gucman: installing %d default package(s)\n", nwant);
        fflush(stdout);
        char base[GM_PATH_MAX];
        cJSON *index = (gm_repo_base(base, sizeof base) == 0) ? gm_fetch_index(base) : NULL;
        if (!index) {
            /* gm_repo_base/gm_fetch_index already named the fault on stderr
             * (#456); record every pending name as failed — the next boot
             * retries them all. */
            for (int i = 0; i < nwant; i++) gm_sync_note(&sl, "failed", want[i]);
        } else {
            for (int i = 0; i < nwant; i++) {
                char dbp[GM_PATH_MAX];
                gm_db_path(want[i], dbp, sizeof dbp);
                if (gm_exists(dbp)) continue;            /* duplicate line / dep of
                                                          * an earlier default */
                cJSON *in_progress = cJSON_CreateObject();
                gm_syncing_defaults = 1;
                int rc = gm_install_one(base, index, want[i], in_progress, 0);
                gm_syncing_defaults = 0;
                cJSON_Delete(in_progress);
                gm_sync_note(&sl, rc == 0 ? "installed" : "failed", want[i]);
                fflush(stdout);
                fflush(stderr);
            }
            cJSON_Delete(index);
        }
    }
    if (sl.failed) {
        fprintf(stderr, "gucman: %d default package(s) not installed (will retry next boot)\n",
                sl.failed);
        fflush(stderr);
    }
    gm_sync_status(&sl);
    return sl.failed ? 1 : 0;
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
    if (argc == 2 && strcmp(argv[1], "sync-defaults") == 0) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        int rc = cmd_sync_defaults();
        curl_global_cleanup();
        return rc;
    }
    fprintf(stderr,
            "usage: gucman install <name> | gucman remove <name> | gucman info <name>\n"
            "       gucman list [--all]   | gucman index (raw catalog JSON)\n"
            "       gucman sync-defaults (boot: install missing default packages)\n");
    return 2;
}
