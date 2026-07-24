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
