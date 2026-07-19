/* wcwidth.h — terminal display width of a code point (gucOS Unicode
 * Phase D, W7/W8). Header-only, OS-side (the openwith.h precedent) —
 * deliberately NOT a libc symbol: the only consumers are the terminal's
 * cell layout (os/term/term.c) and the kernel tty's canonical-mode erase
 * echo (kernel.js has a JS twin of this exact table). Putting it in
 * compiler.js's libc would touch every binary for zero additional
 * customers; promote it there when a real libc consumer appears.
 *
 * MUST MATCH kernel.js `wcwidthCp` (the tty erase-echo twin) — change
 * both together or a wide char erases the wrong number of cells.
 *
 * Returns 2 for East-Asian Wide + Fullwidth code points (condensed
 * Unicode 15.0 EAW W/F blocks — block-granular in the emoji planes,
 * where gucOS renders monochrome tofu anyway (D3) and the tofu box
 * honestly occupies the 2 cells a real emoji would). Returns 1 for
 * EVERYTHING else, including combining marks: the D5 ruling renders a
 * combining mark as its own spacing cell (early-xterm precedent), so
 * for cell layout its width IS 1 — a deliberate divergence from POSIX
 * wcwidth's 0, recorded here rather than discovered in a diff. */
#ifndef WCWIDTH_H
#define WCWIDTH_H

#include <stdint.h>

static int wcwidth_cp(uint32_t cp) {
    static const struct { uint32_t lo, hi; } wide[] = {
        { 0x1100, 0x115F },     /* Hangul Jamo (leading consonants) */
        { 0x2329, 0x232A },     /* angle brackets */
        { 0x2E80, 0x303E },     /* CJK Radicals .. CJK Symbols/Punct */
        { 0x3041, 0x33FF },     /* Hiragana .. CJK Compatibility */
        { 0x3400, 0x4DBF },     /* CJK Ext A */
        { 0x4E00, 0x9FFF },     /* CJK Unified */
        { 0xA000, 0xA4CF },     /* Yi */
        { 0xA960, 0xA97F },     /* Hangul Jamo Ext-A */
        { 0xAC00, 0xD7A3 },     /* Hangul syllables */
        { 0xF900, 0xFAFF },     /* CJK Compatibility Ideographs */
        { 0xFE10, 0xFE19 },     /* Vertical forms */
        { 0xFE30, 0xFE6B },     /* CJK Compatibility Forms + small forms */
        { 0xFF00, 0xFF60 },     /* Fullwidth forms */
        { 0xFFE0, 0xFFE6 },     /* Fullwidth signs */
        { 0x16FE0, 0x16FE4 },   /* Tangut/Khitan marks */
        { 0x17000, 0x187F7 },   /* Tangut */
        { 0x18800, 0x18CD5 },   /* Tangut components / Khitan */
        { 0x1B000, 0x1B2FF },   /* Kana supplements */
        { 0x1F300, 0x1F64F },   /* emoji blocks (EAW W; tofu here, D3) */
        { 0x1F680, 0x1F6FF },
        { 0x1F900, 0x1F9FF },
        { 0x1FA70, 0x1FAFF },
        { 0x20000, 0x2FFFD },   /* CJK Ext B.. */
        { 0x30000, 0x3FFFD },
    };
    if (cp < 0x1100) return 1;
    for (unsigned i = 0; i < sizeof wide / sizeof wide[0]; i++)
        if (cp >= wide[i].lo && cp <= wide[i].hi) return 2;
    return 1;
}

#endif /* WCWIDTH_H */
