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
 * User-overridable bindings (todos/KEYBINDING-OVERRIDE-SYSTEM.md, CHUNK 2):
 * every rebindable behavior is a named action in the KS_ACTIONS registry
 * below; a `bind.<action> <chord>` key in the SAME cfgstore overlay layers
 * on top of the scheme default (none = unbind, a rebind MOVES the binding).
 * key_action() is override-aware; ks_action_binding()/ks_action_default()
 * resolve a registry action to its effective/default chord (wm.c pushes the
 * SYSTEM ones into the kernel grab table in chunk iii, ctlpanel edits them
 * in chunk iv). ks_parse_chord/ks_chord_str/ks_chord_scancode are the ONE
 * text<->(mods,key)<->scancode surface.
 *
 * Notes (todos/KEYMAP.md, superseded/updated by the override system):
 *   - ⌘+arrow rows EXIST in the macos table (⌘←/→ line nav, ⌘↑/↓ doc nav)
 *     and are LIVE: wm.c relocated tiling off GUI+arrow to Ctrl+Alt+arrow
 *     (the grab-table push, META-ARROW-KEYBIND.md), so ⌘+arrow now passes
 *     through the kernel to the focused app where key_action resolves it.
 *   - browser-eaten ⌘ chords (⌘N/W/Q/T/Tab/Space): never bound; the
 *     passthrough spike table in KEYMAP.md records the real list.
 *   - kernel global chords (snap/cycle/menu/sysmenu/overview) are SYSTEM
 *     actions in the registry; their per-scheme defaults live here, the
 *     kernel grab MECHANISM in kernel.js (KEYBINDING-OVERRIDE-SYSTEM.md §3).
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
 * keysyms or win32 VKs — to these; printables are lowercase ASCII). The
 * grab-table world (KEYBINDING-OVERRIDE-SYSTEM.md §2) extends this to the
 * full chord vocabulary; ks_chord_scancode() maps each to its SDL scancode
 * for the kernel grab table. Values are opaque ids — keep them contiguous
 * within a family (KK_F1..KK_F12 is indexed) but not otherwise meaningful. */
#define KK_LEFT      0x1001
#define KK_RIGHT     0x1002
#define KK_UP        0x1003
#define KK_DOWN      0x1004
#define KK_HOME      0x1005
#define KK_END       0x1006
#define KK_PGUP      0x1007
#define KK_PGDN      0x1008
#define KK_INS       0x1009
#define KK_DELETE    0x100A
#define KK_BACKSPACE 0x100B
#define KK_TAB       0x100C
#define KK_ESC       0x100D
#define KK_SPACE     0x100E
#define KK_ENTER     0x100F
#define KK_F1        0x1010   /* KK_F1 + (n-1) == KK_Fn, through KK_F12 */
#define KK_F12       0x101B

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
    /* copy/cut/paste carry KCTX_LIST too (todos/0398): the desktop grid
     * dispatches them in desk_key like the existing select-all case. */
    { KS_WINDOWS, KCTX_EDIT | KCTX_LIST, KM_CTRL, 0, 'a',      KA_SELECT_ALL },
    { KS_WINDOWS, KCTX_EDIT | KCTX_LIST, KM_CTRL, 0, 'c',      KA_COPY },
    { KS_WINDOWS, KCTX_EDIT | KCTX_LIST, KM_CTRL, 0, 'x',      KA_CUT },
    { KS_WINDOWS, KCTX_EDIT | KCTX_LIST, KM_CTRL, 0, 'v',      KA_PASTE },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, 'z',      KA_UNDO },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_LEFT,  KA_WORD_LEFT },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_RIGHT, KA_WORD_RIGHT },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_HOME,  KA_DOC_START },
    { KS_WINDOWS, KCTX_EDIT,             KM_CTRL, 0, KK_END,   KA_DOC_END },
    { KS_WINDOWS, KCTX_TERM, KM_CTRL | KM_SHIFT,  0, 'c',      KA_COPY },
    { KS_WINDOWS, KCTX_TERM, KM_CTRL | KM_SHIFT,  0, 'v',      KA_PASTE },

    /* ---- macos: ⌘ takes the verbs, freeing Ctrl for the emacs rows.
     * ⌘+arrow rows below are LIVE — tiling moved to Ctrl+Alt+arrow, so
     * GUI+arrow reaches the app (META-ARROW-KEYBIND.md). ---- */
    { KS_MACOS, KCTX_EDIT | KCTX_LIST, KM_GUI, 0, 'a',     KA_SELECT_ALL },
    { KS_MACOS, KCTX_EDIT | KCTX_TERM | KCTX_LIST, KM_GUI, 0, 'c', KA_COPY },
    { KS_MACOS, KCTX_EDIT | KCTX_LIST, KM_GUI, 0, 'x',     KA_CUT },
    { KS_MACOS, KCTX_EDIT | KCTX_TERM | KCTX_LIST, KM_GUI, 0, 'v', KA_PASTE },
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, 'z',     KA_UNDO },
    { KS_MACOS, KCTX_EDIT,             KM_ALT, 0, KK_LEFT,  KA_WORD_LEFT },
    { KS_MACOS, KCTX_EDIT,             KM_ALT, 0, KK_RIGHT, KA_WORD_RIGHT },
    /* ⌘←/→ line nav, ⌘↑/↓ doc nav (todos/KEYBINDING-OVERRIDE-SYSTEM.md +
     * META-ARROW-KEYBIND.md, jku-decided). rl=0: these are the native macOS
     * idiom, not the readline bundle — always on in macos scheme. LIVE: wm.c
     * relocated tiling to Ctrl+Alt+arrow, so GUI+arrow passes through to the
     * app. Shift extends selection for free (the context rule, keys.h:206-207). */
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, KK_LEFT,  KA_LINE_START },
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, KK_RIGHT, KA_LINE_END },
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, KK_UP,    KA_DOC_START },
    { KS_MACOS, KCTX_EDIT,             KM_GUI, 0, KK_DOWN,  KA_DOC_END },
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

/* ======================================================================
 * The named-action registry + user overrides
 * (todos/KEYBINDING-OVERRIDE-SYSTEM.md §2/§5). ONE fixed table of every
 * rebindable behavior; a `bind.<name> <chord>` key in the SAME cfgstore
 * overlay layers on top (none = unbind, absent/`default` = scheme default,
 * a rebind MOVES the binding). Names are stable public API, like config
 * keys. Two kinds:
 *   SYSTEM  global chords the kernel grabs before any app (snap/cycle/
 *           menu/sysmenu/overview) — wm.c pushes them into the kernel grab
 *           table (KEYBINDING-OVERRIDE-SYSTEM.md §3) tagged with the KTOK_*
 *           below and dispatches EV_HOTKEY by token. Their per-scheme
 *           default chords live HERE (no KS_TABLE home).
 *   APP     per-focused-app verbs resolved by key_action(). Their default
 *           chords are the KS_TABLE rows above (derived by KA_*+ctx); the
 *           registry adds the stable name, ctx and KA_* mapping.
 * ====================================================================== */

/* A canonical chord: KM_* mask + one key (lowercase ASCII or KK_*). key==0
 * means "empty / no chord". This is what ks_parse_chord/ks_chord_str carry
 * and what key_action matches; ks_chord_scancode(key) turns it into the SDL
 * scancode the kernel grab table wants. */
typedef struct { int mods; int key; } KsChord;

/* WM grab tokens for the SYSTEM actions. wm.c installs these in the kernel
 * grab table and dispatches WMP_EV_HOTKEY by token; the kernel is
 * token-blind. Non-reserved (high bit clear) so they ride EV_HOTKEY, not the
 * legacy default-table emissions (kernel.js WM_TOK_* are the reserved twins
 * used only by the built-in default table). Values are the wire contract
 * with wm.c (chunk iii) — stable. */
enum {
    KTOK_NONE = 0,
    KTOK_SNAP_LEFT = 1, KTOK_SNAP_RIGHT, KTOK_SNAP_UP, KTOK_SNAP_DOWN,
    KTOK_CYCLE, KTOK_START_MENU, KTOK_SYSMENU, KTOK_OVERVIEW,
};

/* action kind */
#define KAK_SYS 0
#define KAK_APP 1

/* Registry action ids — stable, and the index into KS_ACTIONS (asserted).
 * Order is the conflict tie-break (§7.3: two hand-edited overrides on one
 * chord — the earlier registry action wins). */
enum {
    /* system (kernel-grabbed global chords) */
    KSA_SNAP_LEFT, KSA_SNAP_RIGHT, KSA_SNAP_UP, KSA_SNAP_DOWN,
    KSA_CYCLE, KSA_START_MENU, KSA_SYSMENU, KSA_OVERVIEW,
    /* app (per-focused-app verbs) */
    KSA_SELECT_ALL, KSA_COPY, KSA_CUT, KSA_PASTE, KSA_UNDO,
    KSA_WORD_LEFT, KSA_WORD_RIGHT, KSA_LINE_START, KSA_LINE_END,
    KSA_DOC_START, KSA_DOC_END, KSA_TERM_COPY, KSA_TERM_PASTE,
    KSA_COUNT,
};

typedef struct {
    const char *name;      /* stable public id, e.g. "wm.snap-left" */
    unsigned char kind;    /* KAK_SYS | KAK_APP */
    unsigned char ctx;     /* app: KCTX_* mask; system: 0 */
    int token;             /* system: KTOK_*; app: the KA_* it maps to */
    /* SYSTEM default chord(s) per scheme ([KS_*][slot]; key==0 => unused).
     * App rows leave this zeroed — their defaults are the KS_TABLE rows,
     * looked up by ks_action_default() via (scheme, KA_*, ctx). */
    KsChord def[2][2];
} KsAction;

/* The registry. SYSTEM rows carry per-scheme defaults (windows col, macos
 * col); the macos snap column is the RELOCATED Ctrl+Alt+arrow tiling, and
 * NOT installing GUI+arrow there is the whole "⌘+arrow reaches apps" story
 * (META-ARROW). cycle keeps its dual default (Ctrl+Alt+Tab AND bare Alt+Tab)
 * as two chord slots — an override collapses both to the one user chord. */
static const KsAction KS_ACTIONS[] = {
  /* --- system --- */
  { "wm.snap-left",  KAK_SYS, 0, KTOK_SNAP_LEFT,
    { {{KM_GUI,KK_LEFT}},  {{KM_CTRL|KM_ALT,KK_LEFT}}  } },
  { "wm.snap-right", KAK_SYS, 0, KTOK_SNAP_RIGHT,
    { {{KM_GUI,KK_RIGHT}}, {{KM_CTRL|KM_ALT,KK_RIGHT}} } },
  { "wm.snap-up",    KAK_SYS, 0, KTOK_SNAP_UP,
    { {{KM_GUI,KK_UP}},    {{KM_CTRL|KM_ALT,KK_UP}}    } },
  { "wm.snap-down",  KAK_SYS, 0, KTOK_SNAP_DOWN,
    { {{KM_GUI,KK_DOWN}},  {{KM_CTRL|KM_ALT,KK_DOWN}}  } },
  { "wm.cycle",      KAK_SYS, 0, KTOK_CYCLE,
    { {{KM_CTRL|KM_ALT,KK_TAB},{KM_ALT,KK_TAB}},
      {{KM_CTRL|KM_ALT,KK_TAB},{KM_ALT,KK_TAB}} } },
  { "wm.start-menu", KAK_SYS, 0, KTOK_START_MENU,
    { {{KM_CTRL,KK_ESC}},  {{KM_CTRL,KK_ESC}}  } },
  { "wm.sysmenu",    KAK_SYS, 0, KTOK_SYSMENU,
    { {{KM_ALT,KK_SPACE}}, {{KM_ALT,KK_SPACE}} } },
  { "wm.overview",   KAK_SYS, 0, KTOK_OVERVIEW,
    { {{KM_CTRL|KM_ALT,'e'}}, {{KM_CTRL|KM_ALT,'e'}} } },  /* Ctrl+Alt+E both
      schemes (todos/EXPOSE-MISSION-CONTROL.md open-Q1): F3 is a macOS Mission-
      Control media key the host eats — the wm-chord namespace, host-collision-
      free, and scheme-independent (unlike snap's win/mac split) */
  /* --- app (defaults derived from KS_TABLE by KA_*+ctx) --- */
  { "edit.select-all", KAK_APP, KCTX_EDIT | KCTX_LIST, KA_SELECT_ALL },
  { "edit.copy",       KAK_APP, KCTX_EDIT | KCTX_LIST, KA_COPY },
  { "edit.cut",        KAK_APP, KCTX_EDIT | KCTX_LIST, KA_CUT },
  { "edit.paste",      KAK_APP, KCTX_EDIT | KCTX_LIST, KA_PASTE },
  { "edit.undo",       KAK_APP, KCTX_EDIT,             KA_UNDO },
  { "edit.word-left",  KAK_APP, KCTX_EDIT,             KA_WORD_LEFT },
  { "edit.word-right", KAK_APP, KCTX_EDIT,             KA_WORD_RIGHT },
  { "edit.line-start", KAK_APP, KCTX_EDIT,             KA_LINE_START },
  { "edit.line-end",   KAK_APP, KCTX_EDIT,             KA_LINE_END },
  { "edit.doc-start",  KAK_APP, KCTX_EDIT,             KA_DOC_START },
  { "edit.doc-end",    KAK_APP, KCTX_EDIT,             KA_DOC_END },
  { "term.copy",       KAK_APP, KCTX_TERM,             KA_COPY },
  { "term.paste",      KAK_APP, KCTX_TERM,             KA_PASTE },
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

/* ---- chord parse / format / scancode (KEYBINDING-OVERRIDE-SYSTEM.md §2) ----
 * The ONE parse/format pair; the applet, wm.c and the override resolver all
 * use them (round-trip canonical). keys.h stays SDL-header-free: the
 * scancode constants are the plain SDL_SCANCODE_* integers, kept as the twin
 * of the kernel's scancode use in kernel.js WM_DEFAULT_GRABS. */

/* The named non-printable keys (canonical name <-> KK_*). Printable keys are
 * their own lowercase ASCII char and are not in this table. */
typedef struct { const char *name; int key; } KsKeyName;
static const KsKeyName KS_KEYNAMES[] = {
    { "left", KK_LEFT }, { "right", KK_RIGHT }, { "up", KK_UP },
    { "down", KK_DOWN }, { "home", KK_HOME }, { "end", KK_END },
    { "pgup", KK_PGUP }, { "pgdn", KK_PGDN }, { "ins", KK_INS },
    { "delete", KK_DELETE }, { "backspace", KK_BACKSPACE }, { "tab", KK_TAB },
    { "esc", KK_ESC }, { "space", KK_SPACE }, { "enter", KK_ENTER },
    { "f1", KK_F1 + 0 }, { "f2", KK_F1 + 1 }, { "f3", KK_F1 + 2 },
    { "f4", KK_F1 + 3 }, { "f5", KK_F1 + 4 }, { "f6", KK_F1 + 5 },
    { "f7", KK_F1 + 6 }, { "f8", KK_F1 + 7 }, { "f9", KK_F1 + 8 },
    { "f10", KK_F1 + 9 }, { "f11", KK_F1 + 10 }, { "f12", KK_F1 + 11 },
};

/* Map a canonical key to its SDL scancode (SDL_SCANCODE_*), or -1 if the key
 * has none (unknown / not gunable). Letters a-z = 4+(c-'a'); digits 1-9 = 30+,
 * 0 = 39 — the SDL keyboard-usage layout, twin of the kernel's constants. */
static int ks_chord_scancode(int key) {
    if (key >= 'a' && key <= 'z') return 4 + (key - 'a');
    if (key >= '1' && key <= '9') return 30 + (key - '1');
    if (key == '0') return 39;
    if (key >= KK_F1 && key <= KK_F12) return 58 + (key - KK_F1);
    switch (key) {
        case KK_ENTER:     return 40;
        case KK_ESC:       return 41;
        case KK_BACKSPACE: return 42;
        case KK_TAB:       return 43;
        case KK_SPACE:     return 44;
        case KK_INS:       return 73;
        case KK_HOME:      return 74;
        case KK_PGUP:      return 75;
        case KK_DELETE:    return 76;
        case KK_END:       return 77;
        case KK_PGDN:      return 78;
        case KK_RIGHT:     return 79;
        case KK_LEFT:      return 80;
        case KK_DOWN:      return 81;
        case KK_UP:        return 82;
        default:           return -1;
    }
}

/* Parse ONE '+'-joined chord token to a KM_* bit if it names a modifier, else
 * 0. ctrl / alt(=option) / shift / gui(=cmd/win/meta). */
static int ks_mod_token(const char *t) {
    if (!strcasecmp(t, "ctrl")) return KM_CTRL;
    if (!strcasecmp(t, "alt") || !strcasecmp(t, "option")) return KM_ALT;
    if (!strcasecmp(t, "shift")) return KM_SHIFT;
    if (!strcasecmp(t, "gui") || !strcasecmp(t, "cmd") ||
        !strcasecmp(t, "win") || !strcasecmp(t, "meta")) return KM_GUI;
    return 0;
}

/* Parse a key token (one printable ASCII char or a KS_KEYNAMES name) to a
 * canonical key, or 0 if unknown. Uppercase folds to lowercase. */
static int ks_key_token(const char *t) {
    if (t[0] && !t[1]) {                       /* single printable char */
        int c = (unsigned char)t[0];
        if (c >= 'A' && c <= 'Z') c += 32;
        if (c > ' ' && c < 127) return c;
        return 0;
    }
    for (size_t i = 0; i < sizeof KS_KEYNAMES / sizeof KS_KEYNAMES[0]; i++)
        if (!strcasecmp(t, KS_KEYNAMES[i].name)) return KS_KEYNAMES[i].key;
    return 0;
}

/* Parse a text chord ("ctrl+shift+e", "cmd+left", "f3") into the out params.
 * Case-insensitive. Exactly one key token (two key tokens is malformed);
 * a modifier-only chord is malformed. Returns 0 on success, -1 (leaving the
 * out params untouched) on a malformed value. */
static int ks_parse_chord(const char *s, int *mods, int *key) {
    char buf[64], tok[64];
    if (!s || !*s) return -1;
    size_t n = strlen(s);
    if (n >= sizeof buf) return -1;
    memcpy(buf, s, n + 1);
    int m = 0, k = 0;
    /* hand-rolled '+'-splitter (no strtok_r — not in the OS libc): each
     * segment between '+'s is one token, whitespace-trimmed. An empty segment
     * ("ctrl+", "a++b") is malformed. */
    const char *p = buf;
    for (;;) {
        const char *plus = strchr(p, '+');
        const char *end = plus ? plus : p + strlen(p);
        const char *t = p, *e = end;
        while (t < e && (*t == ' ' || *t == '\t')) t++;
        while (e > t && (e[-1] == ' ' || e[-1] == '\t')) e--;
        size_t tl = (size_t)(e - t);
        if (tl == 0 || tl >= sizeof tok) return -1;   /* empty / absurd token */
        memcpy(tok, t, tl); tok[tl] = 0;
        int mb = ks_mod_token(tok);
        if (mb) m |= mb;
        else {
            int kk = ks_key_token(tok);
            if (!kk || k) return -1;               /* unknown, or a second key */
            k = kk;
        }
        if (!plus) break;
        p = plus + 1;
    }
    if (!k) return -1;                             /* modifier-only is invalid */
    *mods = m; *key = k;
    return 0;
}

/* Format a chord to canonical text (round-trips through ks_parse_chord).
 * Modifier order ctrl, alt, shift, gui; canonical modifier names (gui, not
 * cmd/win). Returns out. */
static char *ks_chord_str(int mods, int key, char *out, size_t sz) {
    char keybuf[16];
    const char *kn = keybuf;
    keybuf[0] = 0;
    if (key >= ' ' && key < 127) { keybuf[0] = (char)key; keybuf[1] = 0; }
    else {
        for (size_t i = 0; i < sizeof KS_KEYNAMES / sizeof KS_KEYNAMES[0]; i++)
            if (KS_KEYNAMES[i].key == key) { kn = KS_KEYNAMES[i].name; break; }
    }
    snprintf(out, sz, "%s%s%s%s%s",
        (mods & KM_CTRL)  ? "ctrl+"  : "",
        (mods & KM_ALT)   ? "alt+"   : "",
        (mods & KM_SHIFT) ? "shift+" : "",
        (mods & KM_GUI)   ? "gui+"   : "", kn);
    return out;
}

/* Match a canonical chord against an incoming (mods, key), applying the
 * shared Shift rule (keys.h:206-207 origin): a chord that names Shift
 * requires it; one that doesn't still matches with Shift held (selection-
 * extension belongs to the context). key is compared verbatim — callers
 * case-fold A-Z before matching (key_action does). */
static int ks_chord_match(int cmods, int ckey, int mods, int key) {
    if (ckey != key) return 0;
    if ((mods & ~KM_SHIFT) != (cmods & ~KM_SHIFT)) return 0;
    if ((cmods & KM_SHIFT) && !(mods & KM_SHIFT)) return 0;
    return 1;
}

/* per-action override state (KEYBINDING-OVERRIDE-SYSTEM.md §5) */
#define KOV_DEFAULT 0    /* no bind.<name> (or `default`) — scheme default */
#define KOV_BOUND   1    /* bind.<name> <chord> — rebound (moves the binding) */
#define KOV_NONE    2    /* bind.<name> none — unbound */

typedef struct {
    int scheme;                /* KS_WINDOWS | KS_MACOS */
    int readline;              /* the macos emacs rows: 1 on (default) */
    /* the parsed bind.<action> overlay, indexed by registry action id. */
    signed char ovr_state[KSA_COUNT];   /* KOV_* */
    int ovr_mods[KSA_COUNT];
    int ovr_key[KSA_COUNT];
} ks_cfg;

/* The effective configuration, read FRESH from the store (per-key overlay
 * of the existing layers; defaults on no store — the baked file carries the
 * same values). The ctlpanel applet syncs from this; the dispatch path uses
 * the cached twin below. Overrides read from the SAME text via bind.<name>
 * — a user, admin, or rebound-baked binding composes exactly like scheme,
 * for free (no second store read). A malformed value is ignored LOUDLY (one
 * stderr line, action falls back to its default). */
static void ks_get(ks_cfg *c) {
    char text[CFG_STORE_MAX], val[64], user[300], key[64];
    c->scheme = KS_WINDOWS;
    c->readline = 1;
    for (int i = 0; i < KSA_COUNT; i++) c->ovr_state[i] = KOV_DEFAULT;
    cfg_user_path(user, sizeof user, "keys");
    if (cfg_load3(text, sizeof text, user, "/etc/keys", "/usr/share/keys") == 0)
        return;                        /* -1 still dispatches on the prefix */
    if (cfg_find(text, "scheme", val, sizeof val) &&
        strcasecmp(val, "macos") == 0)
        c->scheme = KS_MACOS;
    if (cfg_find(text, "readline", val, sizeof val) &&
        strcasecmp(val, "off") == 0)
        c->readline = 0;
    for (int i = 0; i < KSA_COUNT; i++) {
        snprintf(key, sizeof key, "bind.%s", KS_ACTIONS[i].name);
        if (!cfg_find(text, key, val, sizeof val)) continue;
        if (!strcasecmp(val, "default")) continue;          /* explicit reset */
        if (!strcasecmp(val, "none")) { c->ovr_state[i] = KOV_NONE; continue; }
        if (ks_parse_chord(val, &c->ovr_mods[i], &c->ovr_key[i]) == 0)
            c->ovr_state[i] = KOV_BOUND;
        else
            fprintf(stderr, "keys: %s: malformed chord \"%s\" (using default)\n",
                    key, val);
    }
}

/* The cached configuration: re-read at most once a second (time(2) is
 * second-coarse — the saver_poll cadence, decided in todos/0149), so a
 * Control Panel write reaches this process within ~1s and the per-keypress
 * cost is a clock read. */
static const ks_cfg *ks_cached(void) {
    static ks_cfg c;
    static int init = 0;
    static time_t stamp = (time_t)-1;
    time_t now = time(NULL);
    if (!init) { init = 1; c.scheme = KS_WINDOWS; c.readline = 1; }
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

/* Is the HOST a Mac? Reads the per-boot verdict both boot paths persist at
 * /run/host-platform (ticket #96 / todos/0432; os-common.js
 * writeHostPlatform). Cached per process — the file is per-boot state and
 * never changes under a running process. Absent file (old kernel,
 * standalone in-process fs) = not a Mac, so every pre-existing environment
 * resolves exactly as before. */
static int ks_host_mac(void) {
    static int cached = -1;
    if (cached < 0) {
        char buf[16] = { 0 };
        FILE *f = fopen("/run/host-platform", "r");
        cached = 0;
        if (f) {
            if (fgets(buf, sizeof buf, f)) {
                buf[strcspn(buf, "\r\n")] = 0;
                cached = strcasecmp(buf, "mac") == 0;
            }
            fclose(f);
        }
    }
    return cached;
}

/* Is the default binding for KA_* `ka` in context `ctx` suppressed by a user
 * override? The rebind-MOVES rule (§5): an APP registry action with an
 * override (bound OR none) whose ctx intersects this call's ctx suppresses
 * its scheme-default row. readline rows (rl==1) are exempt — the caller
 * passes rl and skips this for them (an idiom bundle governed by the
 * `readline` key, not per-action binds). ctx is a single bit in practice, so
 * at most one registry action (edit.* vs term.*) claims a given KA_*. */
static int ks_default_suppressed(int ka, int ctx) {
    const ks_cfg *cfg = ks_cached();
    for (int i = 0; i < KSA_COUNT; i++) {
        const KsAction *a = &KS_ACTIONS[i];
        if (a->kind != KAK_APP) continue;
        if (a->token != ka) continue;
        if (!(a->ctx & ctx)) continue;
        if (cfg->ovr_state[i] != KOV_DEFAULT) return 1;
    }
    return 0;
}

/* THE dispatch: resolve one chord in one context against the effective
 * scheme, override-aware. key is lowercase ASCII or KK_* (uppercase folds
 * here so callers can pass modifier-applied keysyms verbatim); mods are KM_*
 * bits. Returns KA_NONE when the chord is unbound — the caller's native
 * handling (plain typing, the tty control fold, arrow stepping) proceeds.
 * Resolution order (§5): user overrides first (registry order breaks a
 * hand-edited two-override tie — the earlier action wins), then the scheme
 * default rows minus any overridden action's row (readline rows immune). */
static int key_action(int ctx, int mods, int key) {
    const ks_cfg *cfg = ks_cached();
    if (key >= 'A' && key <= 'Z') key += 32;
    /* 1. user overrides (bound only; `none` just suppresses the default) */
    for (int i = 0; i < KSA_COUNT; i++) {
        const KsAction *a = &KS_ACTIONS[i];
        if (a->kind != KAK_APP) continue;
        if (cfg->ovr_state[i] != KOV_BOUND) continue;
        if (!(a->ctx & ctx)) continue;
        if (ks_chord_match(cfg->ovr_mods[i], cfg->ovr_key[i], mods, key))
            return a->token;                          /* the KA_* it maps to */
    }
    /* 2. scheme defaults, minus overridden actions (readline rows immune) */
    for (size_t i = 0; i < sizeof KS_TABLE / sizeof KS_TABLE[0]; i++) {
        const KeyBinding *b = &KS_TABLE[i];
        if (b->scheme != cfg->scheme) continue;
        if (!(b->ctx & ctx)) continue;
        if (b->key != key) continue;
        if (b->rl) { if (!cfg->readline) continue; }
        else if (ks_default_suppressed(b->action, ctx)) continue;
        if (!ks_chord_match(b->mods, b->key, mods, key)) continue;
        return b->action;
    }
    /* 3. the implicit host-native paste row (ticket #96 / todos/0432): on a
     * Mac HOST the native paste chord is ⌘V, so it resolves as EDIT|LIST
     * KA_PASTE regardless of the in-OS scheme — this is what makes ⌘V paste
     * on a stale windows-scheme root volume (pre-v138: never seeded macos).
     * POLICY-ALIGNED with todos/KEYMAP.md's CLOSED DECISION: the row is
     * GUI-modifier only and exists only when the host verdict is 'mac' — it
     * never adds a Ctrl binding anywhere (on a non-Mac host the host-native
     * chord is Ctrl+V, which the windows scheme already binds and the macos
     * scheme deliberately reserves — no implicit row there). Checked LAST
     * (overrides and scheme rows win) and suppressed by an explicit
     * edit.paste override, like any default row. */
    if ((ctx & (KCTX_EDIT | KCTX_LIST)) && key == 'v' &&
        ks_chord_match(KM_GUI, 'v', mods, key) &&
        ks_host_mac() && !ks_default_suppressed(KA_PASTE, ctx))
        return KA_PASTE;
    return KA_NONE;
}

/* The scheme default chord(s) for a registry action (no override applied):
 * SYSTEM actions carry them in KS_ACTIONS; APP action defaults ARE the
 * KS_TABLE rows, found by (scheme, KA_*, ctx) — the first non-readline row.
 * Writes up to 2 chords into out[], returns the count (0 = no default in
 * this scheme, still bindable). */
static int ks_action_default(int idx, int scheme, KsChord out[2]) {
    const KsAction *a = &KS_ACTIONS[idx];
    if (a->kind == KAK_SYS) {
        int n = 0;
        for (int s = 0; s < 2; s++)
            if (a->def[scheme][s].key) out[n++] = a->def[scheme][s];
        return n;
    }
    for (size_t i = 0; i < sizeof KS_TABLE / sizeof KS_TABLE[0]; i++) {
        const KeyBinding *b = &KS_TABLE[i];
        if (b->scheme != scheme || b->rl) continue;
        if (b->action != a->token || !(b->ctx & a->ctx)) continue;
        out[0].mods = b->mods; out[0].key = b->key;
        return 1;
    }
    return 0;
}

/* The EFFECTIVE chord(s) for a registry action under the cached config:
 * override wins (1 chord, or 0 for `none`); else the scheme default(s). This
 * is the resolution wm.c (chunk iii) uses to build the kernel grab table for
 * SYSTEM actions, and the ctlpanel applet (chunk iv) uses for its display.
 * Writes up to 2 chords into out[], returns the count. */
static int ks_action_binding(int idx, KsChord out[2]) {
    const ks_cfg *cfg = ks_cached();
    if (cfg->ovr_state[idx] == KOV_NONE) return 0;
    if (cfg->ovr_state[idx] == KOV_BOUND) {
        out[0].mods = cfg->ovr_mods[idx]; out[0].key = cfg->ovr_key[idx];
        return 1;
    }
    return ks_action_default(idx, cfg->scheme, out);
}

/* Set one key in the USER layer only (cfgstore.h delta-write — the
 * admin/baked layers keep serving every other key through the overlay).
 * Returns 0, or -1. */
static int ks_set(const char *key, const char *value) {
    return cfg_set("keys", key, value);
}

#endif /* KEYS_H */
