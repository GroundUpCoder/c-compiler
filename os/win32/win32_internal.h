/* win32_internal.h — the private seam between gdi32.c and user32.c
 * (todos/0058). Not on the app include path; both sources include it by
 * relative name.
 *
 * gdi32 owns DCs and drawing; user32 owns HWNDs and presenting. A "screen"
 * DC is just a wrap of a raw RGBA span (the window surface, offset to the
 * target window's client origin) — SelectObject(bitmap) refuses on it and
 * DeleteDC refuses (unwrap frees it), exactly like a real GetDC DC.
 */
#pragma once

/* A veneer-INTERNAL TU must never be the one that fires windows.h's §4.1
 * require block: in a subset link (menucore.json — wm.c/term) the dep TUs
 * compile BEFORE the front-end's sources, and an unguarded include here
 * would pull the full veneer into an engine-only binary. Every build that
 * legitimately wants the block has an app TU including <windows.h> first
 * (in-OS input TUs compile before required TUs) or lists the veneer
 * explicitly (host lib.json builds — path-identity dedup). */
#ifndef WIN32_NO_REQUIRE_SOURCES
#define WIN32_NO_REQUIRE_SOURCES
#endif
#include <windows.h>
#include <stdint.h>

/* Wrap a raw RGBA pixel span as a screen-kind DC. `bits` points at the
 * DC's (0,0); stride is in PIXELS. Counted in __gdi_dc_count. */
HDC __gdi_dc_wrap(void *bits, int w, int h, int stridePx);

/* Free a wrapped DC (no present — that is user32's job). */
void __gdi_dc_unwrap(HDC dc);

/* The baked font FAMILY list (C2, #282): *names gets gdi32's authoritative
 * family-name table (index == the GF_* enum; "mono"/"sans"/"serif" today),
 * returns the count. ChooseFontW's face LISTBOX enumerates THIS — never a
 * parallel hardcoded list, so a new family reaches the dialog for free. */
int __gdi_font_families(const char *const **names);

/* Is this GDI object a font? (#291) — gdi32w.c's GetObjectW needs the
 * type to know when to translate LOGFONT -> LOGFONTW; the internal
 * OBJ_* enum stays private to gdi32.c. */
int __gdi_obj_is_font(HGDIOBJ obj);

/* ---- AQM: the agent seam at the user32 <-> any-control boundary
 * (todos/0370). Real common controls hold ITEMS internally, not as child
 * HWNDs — which would break the platform pillar that every widget is
 * addressable through the queryable tree (`wmctl click "OK"`, TOOLKIT.md).
 * These two veneer-internal messages let ANY item-bearing control expose
 * its items to the agent machinery without user32 knowing the control's
 * internals — the menu_dump precedent (0171) generalized, and what
 * Windows itself does (MSAA exposes listview rows as accessibility
 * children). Consumers today: LISTBOX (user32.c), SysListView32 +
 * SysHeader32 (listview.c); a future SysTreeView32 slots in with ZERO
 * user32 change. A control that does not answer returns 0 via
 * DefWindowProc — non-item controls need no code at all.
 *
 * Message numbers sit in the unassigned system range (below WM_USER, so
 * no class-private message can collide; the WM_GETOBJECT spirit). */
#define AQM_DUMPCHILDREN 0x03DE
#define AQM_FINDLABEL    0x03DF

/* AQM_DUMPCHILDREN — wp: unused; lp: AqmDump*. tree_dump sends it to every
 * window after that window's own `win` line; a control that answers fills
 * `out` with a malloc'd block of '\n'-terminated lines, each pre-indented
 * `depth * 2` spaces (the caller frees). Return nonzero when answered. */
typedef struct {
    int depth;                  /* in: indent depth for the emitted lines */
    char *out;                  /* out: malloc'd lines, caller frees */
} AqmDump;

/* AQM_FINDLABEL — wp: unused; lp: AqmFind*. Offered by the agent resolver
 * AFTER window text and menu items both miss. A control that owns an item
 * whose label matches `label` exactly ('&'-stripped) answers nonzero and
 * fills `text` with the item's agent text (malloc'd, caller frees). With
 * `act` set it also performs the item's click semantics (select + notify);
 * act=0 MUST be side-effect-free — `wmctl wait label/text` polls it. */
typedef struct {
    const char *label;          /* in: the target label, verbatim */
    int act;                    /* in: 1 = perform click semantics */
    char *text;                 /* out: malloc'd item text, caller frees */
} AqmFind;

/* comctl32 class registration (listview.c): idempotent, called by
 * InitCommonControls / InitCommonControlsEx(ICC_LISTVIEW_CLASSES). */
void __comctl_register_listview(void);

/* ---- fail-loud (todos/0211) ----------------------------------------
 * The veneer never silently no-ops: an unimplemented API, window message,
 * or style flag reports ONCE per call site to stderr as
 *     win32: unsupported <what>
 * so a missing feature reads as a missing feature, not a mystery app bug.
 * WIN32_STRICT=1 in the environment turns the report into an abort()
 * (the "assert in debug builds" tier). Implementation in kernel32.c. */
void __win32_unsupported(const char *fmt, ...);

#define WIN32_UNSUPPORTED(...) do {                                     \
        static int __w32_once;                                          \
        if (!__w32_once) { __w32_once = 1; __win32_unsupported(__VA_ARGS__); } \
    } while (0)

/* ---- UTF-8 stepping (todos/0211) -----------------------------------
 * The veneer's ANSI charset is UTF-8 (kernel32's CP_UTF8 boundary); text
 * draw/measure/edit steps by CODE POINT while all indices stay BYTES.
 * Malformed bytes decode as U+FFFD advancing past the bad lead byte only,
 * so byte-indexed callers (EDIT selection math) never desync.
 * Plain-static by textual inclusion (the openwith.h precedent). */

static unsigned __u8_next(const char *s, int len, int *i) {
    unsigned char c = (unsigned char)s[(*i)++];
    if (c < 0x80) return c;
    int cont = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : -1;
    if (cont < 0) return 0xFFFD;                 /* stray continuation byte */
    unsigned cp = c & (unsigned)(0x3F >> cont);
    for (int k = 0; k < cont; k++) {
        if (*i >= len || ((unsigned char)s[*i] & 0xC0) != 0x80)
            return 0xFFFD;                       /* truncated sequence */
        cp = (cp << 6) | ((unsigned char)s[(*i)++] & 0x3Fu);
    }
    return cp;
}

/* Byte index of the code point that ENDS at pos (caret-left step). */
static int __u8_prev(const char *s, int pos) {
    if (pos <= 0) return 0;
    pos--;
    while (pos > 0 && ((unsigned char)s[pos] & 0xC0) == 0x80) pos--;
    return pos;
}

/* Byte index just past the code point starting at pos (caret-right step). */
static int __u8_fwd(const char *s, int len, int pos) {
    if (pos < len) __u8_next(s, len, &pos);
    return pos;
}

/* Snap a byte index back onto a code-point boundary. */
static int __u8_snap(const char *s, int pos) {
    while (pos > 0 && ((unsigned char)s[pos] & 0xC0) == 0x80) pos--;
    return pos;
}
