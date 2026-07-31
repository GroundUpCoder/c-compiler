/* netcfg.h — the network (HTTP bridge) configuration store, ONE policy in
 * ONE place (ticket #349; todos/NETWORK.md Tier 2.5).
 *
 * Header-only by design (the display.h/saver.h precedent): static functions
 * shared by textual inclusion — os/win32/ctlpanel.c (the Network applet) is
 * the writer today; the CONSUMER is the kernel embedder, which resolves
 * this same overlay JS-side (os/os-common.js netConfig) and re-resolves on
 * every settled store write via kernel.watchPath, so a checkbox click
 * retargets the next transfer live. Keep the two readers agreeing.
 *
 * The store is a plain text KEY<ws>VALUE map in three layers, overlaid PER
 * KEY (cfgstore.h, arch CS3; nc_set writes only the changed key to the
 * user layer):
 *   $HOME/.config/net   per-user (what nc_set writes)
 *   /etc/net            admin override
 *   /usr/share/net      baked default (none is baked — no store = off)
 * Keys ('#' starts a comment; matching is case-insensitive):
 *   bridge   on | off   Route kernel HTTP transfers through the localhost
 *                       bridge process (tools/net-bridge.js). DEFAULT OFF:
 *                       absent key = direct fetch, byte-identical to a
 *                       build without the feature.
 *   url      URL        The bridge's base URL. Default
 *                       http://127.0.0.1:8199 (the bridge's default port).
 *                       The bridge itself is NOT part of the OS image —
 *                       in the browser deploy the user runs it themselves:
 *                       node tools/net-bridge.js */
#ifndef NETCFG_H
#define NETCFG_H

#include <stdio.h>
#include <string.h>

#include "cfgstore.h"

#define NC_STORE_MAX CFG_STORE_MAX
#define NC_URL_MAX   256
#define NC_DEF_URL   "http://127.0.0.1:8199"

typedef struct {
    int  on;                   /* bridge on|off (default off) */
    char url[NC_URL_MAX];      /* bridge base URL */
} nc_cfg;

/* The effective configuration: defaults, overlaid by the store. */
static void nc_get(nc_cfg *c) {
    char text[NC_STORE_MAX], val[NC_URL_MAX], user[300];
    c->on = 0;
    snprintf(c->url, sizeof c->url, "%s", NC_DEF_URL);
    cfg_user_path(user, sizeof user, "net");
    /* -1 (loud partial) still leaves a line-boundary-clean prefix in text —
     * degrade to the partial overlay like every other store (display.h). */
    if (!cfg_load3(text, sizeof text, user, "/etc/net", "/usr/share/net"))
        return;
    if (cfg_find(text, "bridge", val, sizeof val))
        c->on = strcasecmp(val, "on") == 0;
    if (cfg_find(text, "url", val, sizeof val))
        snprintf(c->url, sizeof c->url, "%s", val);
}

/* Set one key in the USER layer only (cfgstore.h delta-write).
 * Returns 0, or -1 with errno set. */
static int nc_set(const char *key, const char *value) {
    return cfg_set("net", key, value);
}

#endif /* NETCFG_H */
