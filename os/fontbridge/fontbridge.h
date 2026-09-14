#ifndef GUCOS_FONTBRIDGE_H
#define GUCOS_FONTBRIDGE_H
/* Custom process-local ABI v1. Same c namespace imports are callable from
 * Small with scalar int arguments. Font/result handles are not pointers.
 * Pixel output is caller-owned RGBA8, straight alpha. See README.md. */
enum {
    GUCOS_FONT_ASCENT, GUCOS_FONT_DESCENT, GUCOS_FONT_LINE_HEIGHT,
    GUCOS_FONT_CELL_ADVANCE, GUCOS_FONT_CACHE_BYTES, GUCOS_FONT_FACE_COUNT
};
enum {
    GUCOS_FONT_WIDTH, GUCOS_FONT_HEIGHT, GUCOS_FONT_LEFT,
    GUCOS_FONT_TOP, GUCOS_FONT_ADVANCE, GUCOS_FONT_RGBA_BYTES
};
enum { GUCOS_FONT_BOLD = 1, GUCOS_FONT_ITALIC = 2 };
__import int __font_abi(void);
__import int __font_open(const char *path, int pixels, int flags);
__import int __font_add_fallback(int font, const char *path);
__import int __font_close(int font);
__import int __font_metric(int font, int field);
__import int __font_glyph(int font, unsigned codepoint);
__import int __font_codepoint_run(int font, const char *utf8, int bytes);
__import int __font_result_field(int result, int field);
__import int __font_result_copy(int result, void *pixels, int capacity, unsigned rgba);
__import int __font_result_release(int result);
__import void __font_dispose(void);
#endif
