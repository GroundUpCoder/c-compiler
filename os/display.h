/* display.h — the display (desktop density / VT2 zoom) configuration
 * store, ONE policy in ONE place (hires-display).
 *
 * Header-only by design (the saver.h/sounds.h precedent): static functions
 * shared by textual inclusion — os/win32/ctlpanel.c (the Display applet)
 * is the writer today; the CONSUMER is the page (os/os.html), which the
 * kernel worker feeds by resolving this same overlay JS-side and posting
 * {type:'display-config'} on boot and on every settled store write
 * (os/kernel-worker.js displayAnnounce — keep the two readers agreeing).
 *
 * The store is a plain text KEY<ws>VALUE map in three layers, overlaid PER
 * KEY (cfgstore.h, arch CS3; dp_set writes only the changed key to the
 * user layer):
 *   $HOME/.config/display  per-user (what dp_set writes — the page's −/+
 *                          quick control lands here too, via the worker)
 *   /etc/display           admin override
 *   /usr/share/display     baked default (os/image.json)
 * Keys ('#' starts a comment; matching is case-insensitive):
 *   zoom   auto | 0.5 | 0.75 | 1 | 2 | 3
 *          The VT2 desktop zoom factor: >1 = magnified (integer, crisp
 *          nearest-neighbor upscale), 1 = native, <1 = high-density (more
 *          logical pixels than the pane — fixed-pixel UI occupies a
 *          smaller fraction, more fits; smooth-filtered downscale).
 *          `auto` = the page's viewport default (phone-shaped boots 2x,
 *          everything else 1x). No store at all = auto. */
#ifndef DISPLAY_H
#define DISPLAY_H

#include <stdio.h>
#include <string.h>

#include "cfgstore.h"

#define DP_STORE_MAX CFG_STORE_MAX
#define DP_ZOOM_MAX  16
#define DP_DEF_ZOOM  "auto"

typedef struct {
    char zoom[DP_ZOOM_MAX];            /* auto | 0.5 | 0.75 | 1 | 2 | 3 */
} dp_cfg;

/* The effective configuration: defaults, overlaid by the store. */
static void dp_get(dp_cfg *c) {
    char text[DP_STORE_MAX], val[DP_ZOOM_MAX], user[300];
    snprintf(c->zoom, sizeof c->zoom, "%s", DP_DEF_ZOOM);
    cfg_user_path(user, sizeof user, "display");
    if (!cfg_load3(text, sizeof text, user, "/etc/display", "/usr/share/display"))
        return;
    if (cfg_find(text, "zoom", val, sizeof val))
        snprintf(c->zoom, sizeof c->zoom, "%s", val);
}

/* Set one key in the USER layer only (cfgstore.h delta-write).
 * Returns 0, or -1 with errno set. */
static int dp_set(const char *key, const char *value) {
    return cfg_set("display", key, value);
}

#endif /* DISPLAY_H */
