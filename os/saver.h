/* saver.h — the screensaver configuration store, ONE policy in ONE place
 * (todos/0096).
 *
 * Header-only by design (the openwith.h/sounds.h precedent): static
 * functions shared by textual inclusion — os/wm.c (the idle-triggered saver
 * itself) and os/win32/ctlpanel.c (the Screen Saver applet) include this
 * and must stay behaviorally identical through it.
 *
 * The store is a plain text KEY<ws>VALUE map in three layers, overlaid PER
 * KEY (cfgstore.h, arch CS3 — the openwith rule; sv_set writes only the
 * changed key to the user layer):
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

#include "cfgstore.h"

#define SV_STORE_MAX   CFG_STORE_MAX
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

/* Load the effective store (per-key overlay of the existing layers).
 * Returns 1 and the NUL-terminated text, or 0 with text[0] == 0. */
static int sv_load(char *text, size_t sz) {
    char user[300];
    cfg_user_path(user, sizeof user, "screensaver");
    return cfg_load3(text, sz, user, "/etc/screensaver", "/usr/share/screensaver");
}

/* Find `key` in store text; copies its value into val. */
static int sv_find(const char *text, const char *key, char *val, size_t sz) {
    return cfg_find(text, key, val, sz);
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

/* Set one key in the USER layer only (cfgstore.h delta-write — the
 * admin/baked layers keep serving every other key through the overlay).
 * Returns 0, or -1. */
static int sv_set(const char *key, const char *value) {
    return cfg_set("screensaver", key, value);
}

#endif /* SAVER_H */
