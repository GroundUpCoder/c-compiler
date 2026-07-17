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
 * under. */
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
 * Returns 0, or -1 with errno set. */
static int cfg_set(const char *name, const char *key, const char *value) {
    char buf[CFG_STORE_MAX], user[300], dir[300], tmp[300];
    size_t klen = strlen(key);
    if (klen + 2 > sizeof buf) { errno = ENAMETOOLONG; return -1; }
    cfg_user_path(user, sizeof user, name);
    FILE *uf = fopen(user, "r");
    if (!uf && errno != ENOENT && errno != ENOTDIR) return -1;
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
            if (skip && !replaced) {
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
    if (!err && !replaced) {
        if (last != '\n' && fputc('\n', f) == EOF) err = errno ? errno : EIO;
        if (!err && fprintf(f, "%s\t%s\n", key, value) < 0)
            err = errno ? errno : EIO;
    }
    if (fclose(f) != 0 && !err) err = errno ? errno : EIO;
    if (!err && rename(tmp, user) != 0) err = errno ? errno : EIO;
    if (err) { remove(tmp); errno = err; return -1; }
    return 0;
}

#endif /* CFGSTORE_H */
