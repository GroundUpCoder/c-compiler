/* cfgstore.h — the three-layer per-key config overlay, ONE mechanism in ONE
 * place (arch CS3). openwith.h, saver.h and sounds.h are thin wrappers over
 * these functions; include this only through them.
 *
 * Every store is a plain text KEY<ws>VALUE map ('#' starts a comment; key
 * matching is case-insensitive) living in three layers:
 *   $HOME/.config/<name>   per-user  (what cfg_set writes)
 *   /etc/<name-ish>        admin override
 *   /usr/share/<name-ish>  baked default (os/image.json)
 *
 * Load = per-key overlay: a key's value comes from the HIGHEST-precedence
 * layer that defines it (user > admin > baked). Mechanism: cfg_load3
 * concatenates the EXISTING layers in precedence order and cfg_find returns
 * the FIRST matching line — first-match over the concat IS per-key
 * precedence, with no table parse. Within one layer the first line for a
 * key wins, exactly as before. A layer that doesn't fit the remaining
 * buffer is truncated at a LINE boundary (a partial line could mis-resolve
 * a key), lower layers are then capped by the same space rule — and any
 * such truncation (or a layer read error) FAILS LOUD: -1/errno, never a
 * silent entry drop.
 *
 * Set = delta-write: cfg_set STREAMS ONLY the user-layer file, replacing or
 * appending the one key line as it copies to a tmp file, then renames over
 * the original. Streaming means no size cap on the write path — an
 * arbitrarily large override file survives a single-key change intact. The
 * user file holds nothing but genuine user overrides, so a future image's
 * new baked defaults reach existing users per-key — the pre-CS3 rule (first
 * existing file wins whole-file; set snapshots the effective table forward)
 * froze a user at the defaults of whatever release they first customized
 * under. cfg_unset is the same stream with the substitution dropped: it
 * removes the user override so the lower layers serve the key again (there
 * is deliberately NO tombstone — hiding a baked key is a store-wide
 * semantic change, todos/0338 §9).
 *
 * Iteration (todos/0338): cfg_find answers "the effective value"; a store
 * whose key may carry SEVERAL lines (cmdalt's candidate implementations)
 * also needs "every line for this key, in layer order" (cfg_each) and
 * "every distinct key" (cfg_keys). Both are read-only walks over the same
 * cfg_load3 concat, so first-match-wins still IS the precedence rule.
 *
 * Argv (todos/0338): cfg_split_argv + cfg_resolve_prog are the command
 * splitter openwith.h's ow_build used to own privately — a store VALUE is
 * an argv prefix whose bare first word resolves through the canonical
 * PATH. cmdalt appends N arguments where openwith appends one path, so the
 * splitter is here and ow_build is the n = 1 wrapper. */
#ifndef CFGSTORE_H
#define CFGSTORE_H

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

/* One merged store: three layers of a few-hundred-byte text map each, so
 * this is generous. It caps only the LOAD side (cfg_find needs the
 * concatenated text in one caller-owned buffer) and hitting it is a loud
 * -1/EFBIG; the cfg_set write path streams and has no cap at all. */
#define CFG_STORE_MAX 8192

static const char *cfg_home(void) {
    const char *h = getenv("HOME");
    return (h && *h) ? h : "/root";   /* kernel services run env-less */
}

static void cfg_user_path(char *out, size_t sz, const char *name) {
    snprintf(out, sz, "%s/.config/%s", cfg_home(), name);
}

/* Overlay-load the store: concatenate the existing layers, highest
 * precedence first, '\n'-separated, truncating each at a line boundary if
 * space runs out. Returns 1 if ANY layer existed (text NUL-terminated),
 * 0 with text[0] == 0 — "no store at all" is still distinguishable — or
 * -1 with errno set: EFBIG when the merged layers overflow sz (entries
 * past the cap are missing — LOUDLY, never silently), else the layer's
 * open/read errno. On -1 text still holds the line-boundary-clean prefix
 * that DID load, so truthiness-only callers degrade to a valid partial
 * overlay instead of losing the whole store. */
static int cfg_load3(char *text, size_t sz, const char *user,
                     const char *etc, const char *baked) {
    const char *paths[3] = { user, etc, baked };
    size_t k = 0;
    int found = 0, err = 0;
    text[0] = 0;
    for (int i = 0; i < 3; i++) {
        FILE *f = fopen(paths[i], "r");
        if (!f) {
            /* absent is the normal case; an EXISTING layer that won't open
             * (EACCES, EIO, ...) must not silently drop its entries */
            if (errno != ENOENT && errno != ENOTDIR && !err)
                err = errno ? errno : EIO;
            continue;
        }
        found = 1;
        if (k && text[k - 1] != '\n' && k + 1 < sz) text[k++] = '\n';
        size_t space = (k + 1 < sz) ? sz - 1 - k : 0;
        size_t n = fread(text + k, 1, space, f);
        int more = n == space && fgetc(f) != EOF;   /* layer didn't fit */
        int bad = ferror(f);
        fclose(f);
        if (bad && !err) err = errno ? errno : EIO;
        if (more && !err) err = EFBIG;
        if (more || bad)   /* drop the partial tail line — never a half-value */
            while (n && text[k + n - 1] != '\n') n--;
        k += n;
        text[k] = 0;
    }
    if (err) {
        fprintf(stderr, "cfgstore: %s: %s\n", user, err == EFBIG
            ? "merged store exceeds the load buffer; later entries dropped"
            : strerror(err));
        errno = err;
        return -1;
    }
    return found;
}

/* Find `key` in store text; copies its value into val. First matching line
 * wins — which over a cfg_load3 concat is the per-key layer precedence. */
static int cfg_find(const char *text, const char *key, char *val, size_t sz) {
    size_t klen = strlen(key);
    const char *p = text;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (*p != '#' && len > klen &&
            strncasecmp(p, key, klen) == 0 && (p[klen] == ' ' || p[klen] == '\t')) {
            const char *v = p + klen;
            while (v < p + len && (*v == ' ' || *v == '\t')) v++;
            size_t vlen = (size_t)(p + len - v);
            while (vlen && (v[vlen - 1] == ' ' || v[vlen - 1] == '\t' || v[vlen - 1] == '\r')) vlen--;
            if (vlen && vlen < sz) {
                memcpy(val, v, vlen);
                val[vlen] = 0;
                return 1;
            }
        }
        if (!eol) break;
        p = eol + 1;
    }
    return 0;
}

/* ------------------------- iteration (todos/0338) ------------------------
 *
 * cfg_find deliberately keeps its own in-place key compare (no key buffer
 * on the hot resolve path, and it is the one function every shipped store
 * resolves through — it stays byte-identical). The iterators below parse a
 * line into caller-visible key/value COPIES, and skip exactly what cfg_find
 * skips: comments, blank/valueless lines, and an entry too long for the
 * buffer. */

#define CFG_KEY_MAX 64
#define CFG_VAL_MAX 256

/* Visit one store line. Return nonzero to stop the walk. */
typedef int (*cfg_line_cb)(const char *key, const char *value, void *user);

/* Split ONE line [p, p+len) into NUL-terminated key/value copies. Returns 1
 * on a usable KEY<ws>VALUE line, 0 on anything cfg_find would skip. */
static int cfg_parse_line(const char *p, size_t len, char *key, size_t ksz,
                          char *val, size_t vsz) {
    if (!len || *p == '#') return 0;
    size_t k = 0;
    while (k < len && p[k] != ' ' && p[k] != '\t') k++;
    if (!k || k >= len || k + 1 > ksz) return 0;
    const char *v = p + k;
    while (v < p + len && (*v == ' ' || *v == '\t')) v++;
    size_t vlen = (size_t)(p + len - v);
    while (vlen && (v[vlen - 1] == ' ' || v[vlen - 1] == '\t' || v[vlen - 1] == '\r')) vlen--;
    if (!vlen || vlen + 1 > vsz) return 0;
    memcpy(key, p, k); key[k] = 0;
    memcpy(val, v, vlen); val[vlen] = 0;
    return 1;
}

/* Walk every usable line of the concat in order. Returns the number of
 * lines visited (a nonzero cb return stops the walk and still counts). */
static int cfg_walk(const char *text, cfg_line_cb cb, void *user) {
    char key[CFG_KEY_MAX], val[CFG_VAL_MAX];
    const char *p = text;
    int n = 0;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (cfg_parse_line(p, len, key, sizeof key, val, sizeof val)) {
            n++;
            if (cb && cb(key, val, user)) return n;
        }
        if (!eol) break;
        p = eol + 1;
    }
    return n;
}

struct cfg_sel { const char *key; cfg_line_cb cb; void *user; int n; int stop; };

static int cfg_sel_cb(const char *key, const char *value, void *u) {
    struct cfg_sel *s = (struct cfg_sel *)u;
    if (strcasecmp(key, s->key) != 0) return 0;
    s->n++;
    if (s->cb && s->cb(key, value, s->user)) { s->stop = 1; return 1; }
    return 0;
}

/* Every line for `key`, in layer order — the CANDIDATE set (cfg_find's
 * answer is just the first of these). Returns how many matched. */
static int cfg_each(const char *text, const char *key, cfg_line_cb cb, void *user) {
    struct cfg_sel s = { key, cb, user, 0, 0 };
    cfg_walk(text, cfg_sel_cb, &s);
    return s.n;
}

struct cfg_keys_st { cfg_line_cb cb; void *user; const char *text; int n; };

/* Is this the FIRST line for `key` in the concat? (dedup without a set:
 * the texts are a few hundred bytes) */
static int cfg_first_for(const char *text, const char *key, const char *at) {
    char k[CFG_KEY_MAX], v[CFG_VAL_MAX];
    const char *p = text;
    while (*p && p < at) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (cfg_parse_line(p, len, k, sizeof k, v, sizeof v) &&
            strcasecmp(k, key) == 0) return 0;
        if (!eol) break;
        p = eol + 1;
    }
    return 1;
}

/* Every DISTINCT key, in first-appearance order, with its EFFECTIVE value
 * (the first line — the cfg_find answer). Returns how many keys. */
static int cfg_keys(const char *text, cfg_line_cb cb, void *user) {
    char key[CFG_KEY_MAX], val[CFG_VAL_MAX];
    const char *p = text;
    int n = 0;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        if (cfg_parse_line(p, len, key, sizeof key, val, sizeof val) &&
            cfg_first_for(text, key, p)) {
            n++;
            if (cb && cb(key, val, user)) return n;
        }
        if (!eol) break;
        p = eol + 1;
    }
    return n;
}

/* ---------------------- argv from a store VALUE (todos/0338) -------------
 *
 * The canonical PATH, in ONE place: user-installed binaries win over baked
 * ones (todos/0040 — os/launch.h ships the same string as $PATH). */

/* First existing /usr/local/bin|/bin entry for a bare command name; 1 and
 * the absolute path, or 0 with out[0] == 0. */
static int cfg_path_find(const char *name, char *out, size_t sz) {
    static const char *dirs[2] = { "/usr/local/bin", "/bin" };
    for (int i = 0; i < 2; i++) {
        snprintf(out, sz, "%s/%s", dirs[i], name);
        if (access(out, 0 /* F_OK */) == 0) return 1;
    }
    out[0] = 0;
    return 0;
}

/* The spawnable program path for a store value's argv[0]: a word with a
 * slash is used as-is, a bare word resolves through the canonical PATH
 * (unfound falls back to /bin/<word>, so the caller reports the spawn's
 * own ENOENT rather than inventing one). */
static void cfg_resolve_prog(const char *arg0, char *prog, size_t progsz) {
    if (strchr(arg0, '/')) { snprintf(prog, progsz, "%s", arg0); return; }
    if (!cfg_path_find(arg0, prog, progsz))
        snprintf(prog, progsz, "/bin/%s", arg0);
}

/* Split a store value (an argv prefix) into words, backing storage in buf.
 * `reserve` slots are left free for the caller's own trailing arguments,
 * plus one for the NULL terminator. Returns the word count, or 0 (empty
 * value, or buf too small). The caller NUL-terminates argv after appending
 * its own args. */
static int cfg_split_argv(const char *cmd, char *argv[], int maxargs,
                          int reserve, char *buf, size_t bufsz) {
    int n = 0;
    size_t k = 0;
    const char *p = cmd;
    while (*p && n < maxargs - reserve - 1) {
        while (*p == ' ' || *p == '\t') p++;
        if (!*p) break;
        const char *s = p;
        while (*p && *p != ' ' && *p != '\t') p++;
        size_t len = (size_t)(p - s);
        if (k + len + 1 > bufsz) return 0;
        memcpy(buf + k, s, len);
        buf[k + len] = 0;
        argv[n++] = buf + k;
        k += len + 1;
    }
    return n;
}

/* Set one key in the USER layer only: STREAM $HOME/.config/<name> chunk by
 * chunk into a tmp file, substituting the key's line (or appending it at
 * the end), then rename over the original. No size cap on this path — an
 * arbitrarily large override file survives a single-key change intact
 * (lines longer than the chunk buffer copy through verbatim in pieces; a
 * line START always arrives with a full buffer of context, which is all
 * the key match needs). Duplicate lines for the key collapse to the one
 * new line, as before. The admin/baked layers are never read here — the
 * user file stays a pure override delta. A read error — or an existing
 * user file that won't open — fails LOUD and leaves the file untouched: a
 * bad snapshot must never be renamed over the original.
 *
 * value == NULL is the UNSET half (cfg_unset): the same stream with the
 * substitution dropped, so the key's user override disappears and the
 * admin/baked layers serve it again. Nothing is created when there is no
 * user file to edit — "revert my pick" on a virgin store is a no-op, not a
 * new empty file.
 * Returns 0, or -1 with errno set. */
static int cfg_write(const char *name, const char *key, const char *value) {
    char buf[CFG_STORE_MAX], user[300], dir[300], tmp[300];
    size_t klen = strlen(key);
    if (klen + 2 > sizeof buf) { errno = ENAMETOOLONG; return -1; }
    cfg_user_path(user, sizeof user, name);
    FILE *uf = fopen(user, "r");
    if (!uf && errno != ENOENT && errno != ENOTDIR) return -1;
    if (!uf && !value) return 0;              /* nothing to unset */
    snprintf(dir, sizeof dir, "%s/.config", cfg_home());
    mkdir(dir, 0755);   /* EEXIST is fine */
    snprintf(tmp, sizeof tmp, "%s/.%s.tmp", dir, name);
    FILE *f = fopen(tmp, "w");
    if (!f) { int e = errno; if (uf) fclose(uf); errno = e; return -1; }
    int replaced = 0, err = 0, bol = 1, skip = 0, last = '\n';
    while (!err && uf && fgets(buf, sizeof buf, uf)) {
        size_t len = strlen(buf);
        int eol = len && buf[len - 1] == '\n';
        if (bol) {   /* only a line START can match the key */
            size_t body = len - (eol ? 1 : 0);
            skip = buf[0] != '#' && body > klen &&
                strncasecmp(buf, key, klen) == 0 &&
                (buf[klen] == ' ' || buf[klen] == '\t');
            if (skip && !replaced && value) {
                replaced = 1;
                if (fprintf(f, "%s\t%s\n", key, value) < 0)
                    err = errno ? errno : EIO;
            }
        }
        if (!skip && len) {
            if (fwrite(buf, 1, len, f) != len) err = errno ? errno : EIO;
            else last = buf[len - 1];
        }
        bol = eol;   /* a chunk without '\n' continues on the next fgets */
    }
    if (uf) {
        if (!err && ferror(uf)) err = errno ? errno : EIO;
        fclose(uf);
    }
    if (!err && !replaced && value) {
        if (last != '\n' && fputc('\n', f) == EOF) err = errno ? errno : EIO;
        if (!err && fprintf(f, "%s\t%s\n", key, value) < 0)
            err = errno ? errno : EIO;
    }
    if (fclose(f) != 0 && !err) err = errno ? errno : EIO;
    if (!err && rename(tmp, user) != 0) err = errno ? errno : EIO;
    if (err) { remove(tmp); errno = err; return -1; }
    return 0;
}

static int cfg_set(const char *name, const char *key, const char *value) {
    return cfg_write(name, key, value);
}

/* Drop `key`'s USER override (todos/0338): the admin/baked layers serve it
 * again. Returns 0 (including "there was nothing to drop"), or -1. */
static int cfg_unset(const char *name, const char *key) {
    return cfg_write(name, key, NULL);
}

#endif /* CFGSTORE_H */
