/* keys.h — the system keyboard scheme, ONE keymap in ONE place
 * (todos/0149 + 0150, design todos/KEYMAP.md).
 *
 * Header-only by design (the openwith.h/saver.h/sounds.h precedent):
 * static functions shared by textual inclusion — os/win32/user32.c (EDIT/
 * LISTBOX verbs + the TranslateAccelerator modifier), os/term/term.c (the
 * copy/paste chord), os/wm.c (desktop select-all) and os/win32/ctlpanel.c
 * (the Keyboard applet) include this and must stay behaviorally identical
 * through it.
 *
 * The store is a plain text KEY<ws>VALUE map in three layers, overlaid PER
 * KEY (cfgstore.h, arch CS3; ks_set writes only the changed key to the
 * user layer):
 *   $HOME/.config/keys   per-user (what ks_set writes)
 *   /etc/keys            admin override
 *   /usr/share/keys      baked default (os/image.json)
 * Keys ('#' starts a comment; matching is case-insensitive):
 *   scheme    windows | macos   (which keymap; windows is the native idiom)
 *   readline  on | off          (emacs rows in GUI text fields — the rows
 *                                only EXIST in the macos table, where the
 *                                ⌘ verbs free the Ctrl register; in the
 *                                windows table Ctrl is the verb modifier,
 *                                so the rows are structurally absent, not
 *                                switched off)
 *
 * ONE dispatch: key_action(ctx, mods, key) resolves a chord against the
 * static table below under the EFFECTIVE scheme and returns a KA_* verb
 * (KA_NONE = unbound; the caller's native un-chorded handling proceeds).
 * The config is CACHED with a once-a-second revalidate (the wm.c
 * saver_poll cadence) — a Control Panel Apply reaches every running app
 * within ~1s with no notification mechanism.
 *
 * Deliberately NOT in the table (decided, todos/KEYMAP.md):
 *   - ⌘+arrow rows: the kernel intercepts GUI+arrow for Aero Snap before
 *     apps ever see it (a separate WM axis) — macOS line/doc nav is
 *     ^A/^E/Home/End instead.
 *   - browser-eaten ⌘ chords (⌘N/W/Q/T/Tab/Space): never bound; the
 *     passthrough spike table in KEYMAP.md records the real list.
 *   - kernel global chords (snap/cycle/menu): a different layer, untouched.
 */
#ifndef KEYS_H
#define KEYS_H

#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include "cfgstore.h"

/* schemes */
#define KS_WINDOWS 0
#define KS_MACOS   1

/* contexts (mask — one binding can serve several) */
#define KCTX_EDIT 0x01     /* a GUI text field (user32 EDIT) */
#define KCTX_LIST 0x02     /* an item list (user32 LISTBOX, the desktop grid) */
#define KCTX_TERM 0x04     /* the terminal (os/term) */

/* canonical modifiers (km_from_sdl folds the SDL_KMOD_* word to these) */
#define KM_SHIFT 0x1
#define KM_CTRL  0x2
#define KM_ALT   0x4
#define KM_GUI   0x8

/* canonical non-printable keys (callers fold their own vocabulary — SDL
 * keysyms or win32 VKs — to these; printables are lowercase ASCII) */
#define KK_LEFT  0x1001
#define KK_RIGHT 0x1002
#define KK_UP    0x1003
#define KK_DOWN  0x1004
#define KK_HOME  0x1005
#define KK_END   0x1006

/* actions */
enum {
    KA_NONE = 0,
    /* the edit verbs */
    KA_COPY, KA_CUT, KA_PASTE, KA_SELECT_ALL, KA_UNDO,
    /* word/document navigation (EDIT) */
    KA_WORD_LEFT, KA_WORD_RIGHT, KA_DOC_START, KA_DOC_END,
    /* the readline rows (EDIT; macos scheme only — see the header note) */
    KA_LINE_START, KA_LINE_END, KA_CHAR_LEFT, KA_CHAR_RIGHT,
    KA_DEL_CHAR, KA_DEL_WORD, KA_KILL_EOL, KA_KILL_BOL,
    KA_LINE_UP, KA_LINE_DOWN,
};

typedef struct {
    int scheme;                /* KS_WINDOWS | KS_MACOS */
    int readline;              /* the macos emacs rows: 1 on (default) */
} ks_cfg;

typedef struct {
    unsigned char scheme;      /* which keymap this row belongs to */
    unsigned char ctx;         /* KCTX_* mask */
    unsigned char mods;        /* exact KM_* chord (see the Shift rule) */
    unsigned char rl;          /* 1 = gated by cfg.readline */
    int key;                   /* lowercase ASCII or KK_* */
    int action;                /* KA_* */
} KeyBinding;

/* The two keymaps (todos/KEYMAP.md "The two keymaps"). Shift is significant
 * only where a row names it: selection-extension belongs to the CONTEXT
 * (the EDIT caret machinery), not to the chord, so Ctrl+Shift+C still
 * copies while the windows-term row genuinely requires the Shift. */
static const KeyBinding KS_TABLE[] = {
    /* ---- windows: Ctrl is the verb modifier (the native Win95 idiom) ---- */
    { KS_WINDOWS, KCTX_EDIT | KCTX_LIST, KM_CTRL, 0, 'a',      KA_SELECT_ALL },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, 'c',      KA_COPY },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, 'x',      KA_CUT },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, 'v',      KA_PASTE },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, 'z',      KA_UNDO },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_LEFT,  KA_WORD_LEFT },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_RIGHT, KA_WORD_RIGHT },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_HOME,  KA_DOC_START },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_END,   KA_DOC_END },
    { KS_WINDOWS, KCTX_TERM, KM_CTRL | KM_SHIFT,  0, 'c',      KA_COPY },
    { KS_WINDOWS, KCTX_TERM, KM_CTRL | KM_SHIFT,  0, 'v',      KA_PASTE },

    /* ---- macos: ⌘ takes the verbs, freeing Ctrl for the emacs rows.
     * NO ⌘+arrow rows (Aero Snap owns GUI+arrow in the kernel). ---- */
    { KS_MACOS, KCTX_EDIT | KCTX_LIST, KM_GUI, 0, 'a',     KA_SELECT_ALL },
    { KS_MACOS, KCTX_EDIT | KCTX_TERM, KM_GUI, 0, 'c',     KA_COPY },
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, 'x',     KA_CUT },
    { KS_MACOS, KCTX_EDIT | KCTX_TERM, KM_GUI, 0, 'v',     KA_PASTE },
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, 'z',     KA_UNDO },
    { KS_MACOS, KCTX_EDIT,             KM_ALT, 0, KK_LEFT,  KA_WORD_LEFT },
    { KS_MACOS, KCTX_EDIT,             KM_ALT, 0, KK_RIGHT, KA_WORD_RIGHT },
    /* the readline rows (todos/0150; ^A ^E ^F ^B ^D ^W ^K ^U ^N ^P) */
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'a', KA_LINE_START },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'e', KA_LINE_END },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'f', KA_CHAR_RIGHT },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'b', KA_CHAR_LEFT },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'd', KA_DEL_CHAR },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'w', KA_DEL_WORD },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'k', KA_KILL_EOL },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'u', KA_KILL_BOL },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'n', KA_LINE_DOWN },
    { KS_MACOS, KCTX_EDIT, KM_CTRL, 1, 'p', KA_LINE_UP },
};

/* Fold the SDL modifier word (SDL_KMOD_*: SHIFT 0x0003, CTRL 0x00C0,
 * ALT 0x0300, GUI 0x0C00 — the same raw word user32 keeps in g_mod) to the
 * canonical KM_* bits. keys.h deliberately doesn't include SDL headers. */
static int km_from_sdl(int sdlmod) {
    return ((sdlmod & 0x0003) ? KM_SHIFT : 0) |
           ((sdlmod & 0x00C0) ? KM_CTRL : 0) |
           ((sdlmod & 0x0300) ? KM_ALT : 0) |
           ((sdlmod & 0x0C00) ? KM_GUI : 0);
}

/* The effective configuration, read FRESH from the store (per-key overlay
 * of the existing layers; defaults on no store — the baked file carries the
 * same values). The ctlpanel applet syncs from this; the dispatch path uses
 * the cached twin below. */
static void ks_get(ks_cfg *c) {
    char text[CFG_STORE_MAX], val[32], user[300];
    c->scheme = KS_WINDOWS;
    c->readline = 1;
    cfg_user_path(user, sizeof user, "keys");
    if (cfg_load3(text, sizeof text, user, "/etc/keys", "/usr/share/keys") == 0)
        return;                        /* -1 still dispatches on the prefix */
    if (cfg_find(text, "scheme", val, sizeof val) &&
        strcasecmp(val, "macos") == 0)
        c->scheme = KS_MACOS;
    if (cfg_find(text, "readline", val, sizeof val) &&
        strcasecmp(val, "off") == 0)
        c->readline = 0;
}

/* The cached configuration: re-read at most once a second (time(2) is
 * second-coarse — the saver_poll cadence, decided in todos/0149), so a
 * Control Panel write reaches this process within ~1s and the per-keypress
 * cost is a clock read. */
static const ks_cfg *ks_cached(void) {
    static ks_cfg c = { KS_WINDOWS, 1 };
    static time_t stamp = (time_t)-1;
    time_t now = time(NULL);
    if (now != stamp) {
        stamp = now;
        ks_get(&c);
    }
    return &c;
}

/* The effective scheme (KS_*) — the TranslateAccelerator choke reads this. */
static int ks_scheme(void) {
    return ks_cached()->scheme;
}

/* THE dispatch: resolve one chord in one context against the effective
 * scheme. key is lowercase ASCII or KK_* (uppercase folds here so callers
 * can pass modifier-applied keysyms verbatim); mods are KM_* bits. Returns
 * KA_NONE when the chord is unbound — the caller's native handling (plain
 * typing, the tty control fold, arrow stepping) proceeds. */
static int key_action(int ctx, int mods, int key) {
    const ks_cfg *cfg = ks_cached();
    if (key >= 'A' && key <= 'Z') key += 32;
    for (size_t i = 0; i < sizeof KS_TABLE / sizeof KS_TABLE[0]; i++) {
        const KeyBinding *b = &KS_TABLE[i];
        if (b->scheme != cfg->scheme) continue;
        if (!(b->ctx & ctx)) continue;
        if (b->key != key) continue;
        if (b->rl && !cfg->readline) continue;
        if ((mods & ~KM_SHIFT) != (b->mods & ~KM_SHIFT)) continue;
        if ((b->mods & KM_SHIFT) && !(mods & KM_SHIFT)) continue;
        return b->action;
    }
    return KA_NONE;
}

/* Set one key in the USER layer only (cfgstore.h delta-write — the
 * admin/baked layers keep serving every other key through the overlay).
 * Returns 0, or -1. */
static int ks_set(const char *key, const char *value) {
    return cfg_set("keys", key, value);
}

#endif /* KEYS_H */
