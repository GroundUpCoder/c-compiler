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
 * a key), lower layers are then skipped by the same space rule.
 *
 * Set = delta-write: cfg_set reads ONLY the user-layer file, replaces or
 * appends the one key, and writes it back (tmp + rename). The user file
 * holds nothing but genuine user overrides, so a future image's new baked
 * defaults reach existing users per-key — the pre-CS3 rule (first existing
 * file wins whole-file; set snapshots the effective table forward) froze a
 * user at the defaults of whatever release they first customized under. */
#ifndef CFGSTORE_H
#define CFGSTORE_H

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

/* One merged store: three layers of a few-hundred-byte text map each, so
 * this is generous — the line-boundary truncation above is the backstop. */
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
 * or 0 with text[0] == 0 — "no store at all" is still distinguishable. */
static int cfg_load3(char *text, size_t sz, const char *user,
                     const char *etc, const char *baked) {
    const char *paths[3] = { user, etc, baked };
    size_t k = 0;
    int found = 0;
    text[0] = 0;
    for (int i = 0; i < 3; i++) {
        FILE *f = fopen(paths[i], "r");
        if (!f) continue;
        found = 1;
        if (k && text[k - 1] != '\n' && k + 1 < sz) text[k++] = '\n';
        size_t space = (k + 1 < sz) ? sz - 1 - k : 0;
        size_t n = fread(text + k, 1, space, f);
        int trunc = n == space && fgetc(f) != EOF;
        fclose(f);
        if (trunc)   /* drop the partial tail line — never a half-value */
            while (n && text[k + n - 1] != '\n') n--;
        k += n;
        text[k] = 0;
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

/* Set one key in the USER layer only: read $HOME/.config/<name>, replace
 * the key's line (or append it), write back tmp + rename. The admin/baked
 * layers are never read here — the user file stays a pure override delta.
 * Returns 0, or -1 (errno from the failing fs op). */
static int cfg_set(const char *name, const char *key, const char *value) {
    char text[CFG_STORE_MAX], out[CFG_STORE_MAX + 512], user[300];
    size_t klen = strlen(key), k = 0;
    int replaced = 0;
    cfg_user_path(user, sizeof user, name);
    text[0] = 0;
    FILE *uf = fopen(user, "r");
    if (uf) {
        size_t n = fread(text, 1, sizeof text - 1, uf);
        fclose(uf);
        text[n] = 0;
    }
    const char *p = text;
    while (*p) {
        const char *eol = strchr(p, '\n');
        size_t len = eol ? (size_t)(eol - p) : strlen(p);
        int is_key = *p != '#' && len > klen &&
            strncasecmp(p, key, klen) == 0 && (p[klen] == ' ' || p[klen] == '\t');
        if (is_key && !replaced) {
            k += (size_t)snprintf(out + k, sizeof out - k, "%s\t%s\n", key, value);
            replaced = 1;
        } else if (!is_key && k + len + 1 < sizeof out) {
            memcpy(out + k, p, len);
            out[k + len] = '\n';
            k += len + 1;
        }
        if (!eol) break;
        p = eol + 1;
    }
    if (!replaced) k += (size_t)snprintf(out + k, sizeof out - k, "%s\t%s\n", key, value);
    if (k >= sizeof out) return -1;

    char dir[300], tmp[300];
    snprintf(dir, sizeof dir, "%s/.config", cfg_home());
    mkdir(dir, 0755);   /* EEXIST is fine */
    snprintf(tmp, sizeof tmp, "%s/.%s.tmp", dir, name);
    FILE *f = fopen(tmp, "w");
    if (!f) return -1;
    size_t w = fwrite(out, 1, k, f);
    if (fclose(f) != 0 || w != k) { remove(tmp); return -1; }
    if (rename(tmp, user) != 0) { remove(tmp); return -1; }
    return 0;
}

#endif /* CFGSTORE_H */
