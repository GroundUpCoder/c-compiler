/* saver.h — the screensaver configuration store, ONE policy in ONE place
 * (todos/0096).
 *
 * Header-only by design (the openwith.h/sounds.h precedent): static
 * functions shared by textual inclusion — os/wm.c (the idle-triggered saver
 * itself) and os/win32/ctlpanel.c (the Screen Saver applet) include this
 * and must stay behaviorally identical through it.
 *
 * The store is a plain text KEY<ws>VALUE map; the first existing file wins,
 * whole-file (no per-key merge — the openwith rule):
 *   $HOME/.config/screensaver  per-user (what sv_set writes)
 *   /etc/screensaver           admin override
 *   /usr/share/screensaver     baked default (os/image.json)
 * Keys ('#' starts a comment; matching is case-insensitive):
 *   saver    none | marquee | starfield   (which saver; none disables)
 *   timeout  seconds of idle before it raises (0 disables)
 *   text     the marquee banner string
 * No store at all = the SV_DEF_* defaults below (the baked file carries the
 * same values, so a factory image and a storeless standalone agree). */
#ifndef SAVER_H
#define SAVER_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#define SV_STORE_MAX   4096
#define SV_NAME_MAX    16
#define SV_TEXT_MAX    64
#define SV_DEF_SAVER   "starfield"
#define SV_DEF_TIMEOUT 900         /* 15 min, the Win95 classic — also safely
                                      past the 600s test-runner cap, so no
                                      headless e2e can have the saver raise
                                      mid-test under it (tests that want the
                                      saver set their own short timeout) */
#define SV_DEF_TEXT    "gucOS"

typedef struct {
    char saver[SV_NAME_MAX];           /* none | marquee | starfield */
    int timeout;                       /* seconds; 0 = never raise */
    char text[SV_TEXT_MAX];            /* the marquee banner */
} sv_cfg;

static const char *sv_home(void) {
    const char *h = getenv("HOME");
    return (h && *h) ? h : "/root";    /* kernel services run env-less */
}

/* Load the effective store (first existing file wins). Returns 1 and the
 * NUL-terminated text, or 0 with text[0] == 0. (snd_load, verbatim.) */
static int sv_load(char *text, size_t sz) {
    char user[300];
    snprintf(user, sizeof user, "%s/.config/screensaver", sv_home());
    const char *paths[3] = { user, "/etc/screensaver", "/usr/share/screensaver" };
    text[0] = 0;
    for (int i = 0; i < 3; i++) {
        FILE *f = fopen(paths[i], "r");
        if (!f) continue;
        size_t n = fread(text, 1, sz - 1, f);
        fclose(f);
        text[n] = 0;
        return 1;
    }
    return 0;
}

/* Find `key` in store text; copies its value into val. (ow_find, verbatim.) */
static int sv_find(const char *text, const char *key, char *val, size_t sz) {
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

/* The effective configuration: defaults, overlaid by the store. A malformed
 * timeout falls back to the default; a negative one clamps to 0 (off). */
static void sv_get(sv_cfg *c) {
    char text[SV_STORE_MAX], val[SV_TEXT_MAX];
    snprintf(c->saver, sizeof c->saver, "%s", SV_DEF_SAVER);
    c->timeout = SV_DEF_TIMEOUT;
    snprintf(c->text, sizeof c->text, "%s", SV_DEF_TEXT);
    if (!sv_load(text, sizeof text)) return;
    if (sv_find(text, "saver", val, sizeof val))
        snprintf(c->saver, sizeof c->saver, "%s", val);
    if (sv_find(text, "timeout", val, sizeof val)) {
        c->timeout = atoi(val);
        if (c->timeout < 0) c->timeout = 0;
    }
    if (sv_find(text, "text", val, sizeof val))
        snprintf(c->text, sizeof c->text, "%s", val);
}

/* Set one key: rewrite the EFFECTIVE table with `key` replaced into
 * $HOME/.config/screensaver (tmp + rename — the snd_set_mute shape), so
 * baked values carry forward past the first user write. Returns 0, or -1. */
static int sv_set(const char *key, const char *value) {
    char text[SV_STORE_MAX], out[SV_STORE_MAX + 128];
    size_t klen = strlen(key), k = 0;
    int replaced = 0;
    sv_load(text, sizeof text);
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

    char dir[300], tmp[300], dst[300];
    snprintf(dir, sizeof dir, "%s/.config", sv_home());
    mkdir(dir, 0755);   /* EEXIST is fine */
    snprintf(tmp, sizeof tmp, "%s/.screensaver.tmp", dir);
    snprintf(dst, sizeof dst, "%s/screensaver", dir);
    FILE *f = fopen(tmp, "w");
    if (!f) return -1;
    size_t w = fwrite(out, 1, k, f);
    if (fclose(f) != 0 || w != k) { remove(tmp); return -1; }
    if (rename(tmp, dst) != 0) { remove(tmp); return -1; }
    return 0;
}

#endif /* SAVER_H */
