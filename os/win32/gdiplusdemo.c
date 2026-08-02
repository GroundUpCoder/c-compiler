/* gdiplusdemo.c — the gdiplus-mini acceptance app (ticket #94 / 0453).
 *
 * `gdiplusdemo selftest` is a HEADLESS self-check, the os/win32/gdidemo.c
 * pattern: no window, no message loop, just memory DCs and printf. It is
 * what tests/kernel/test_gdiplus_e2e.js drives in-OS.
 *
 * It covers the ticket's acceptance arms directly:
 *
 *   arm 3 — DECODE PROVEN PER FORMAT, WITH A CAN-FAIL CONTROL. Each of
 *     PNG / GIF / BMP / JPEG decodes from an EMBEDDED fixture and its
 *     pixels are asserted; then a corrupted copy of the SAME bytes must
 *     be REJECTED. The controls are what make the passes mean something:
 *     a decoder that returned Ok for everything would fail them.
 *
 *     The fixtures were written by INDEPENDENT encoders (Pillow 12.2.0),
 *     not by this tree's own encode path, so a decode assert cannot be
 *     satisfied by a self-consistent round trip. Reproduce them with the
 *     generator recorded in logs/2026-08-02/0453-gdiplus-mini.md.
 *
 *   arm 4 — DRAW PROVEN AT A NON-1:1 SCALE. A 4x2 image is drawn into an
 *     8x4 destination rect and every one of the 32 destination pixels is
 *     asserted. THE MODE UNDER TEST IS NEAREST NEIGHBOUR: at exactly 2x
 *     each source pixel becomes a 2x2 block, which is correct-by-
 *     definition for nearest and would NOT hold for bilinear.
 *
 *   arm 2 — EVERY SYMBOL IMPLEMENTED OR FAILS LOUD. The `fail-loud` block
 *     asks the shim for things it cannot do (a JPEG encoder, a non-pixel
 *     unit, the wrong frame dimension, a call before GdiplusStartup) and
 *     asserts each one returns a real error status rather than Ok.
 *
 * All 29 derived entry points are exercised here.
 */

#include <windows.h>
#include <objbase.h>
#include <gdiplusflat.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================ harness */

static int g_fails, g_checks;

static void check(const char *name, int cond) {
    g_checks++;
    if (cond) printf("ok %s\n", name);
    else { printf("FAIL %s\n", name); g_fails++; }
}

/* GDI/gdiplus pixel word: R | G<<8 | B<<16 | A<<24. */
#define PX(r, g, b, a) \
    ((uint32_t)(r) | ((uint32_t)(g) << 8) | ((uint32_t)(b) << 16) | ((uint32_t)(a) << 24))

/* ============================================================ fixtures */

/* 4x2 RGBA PNG. Row 0 carries alpha (one 50% pixel, one fully
 * transparent) so the ImageFlags asserts have something to find. */
static const BYTE k_png[] = {
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x7F, 0xA8, 0x7D, 0x63, 0x00, 0x00, 0x00,
    0x21, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0,
    0x9F, 0xE1, 0x3F, 0x43, 0x03, 0x03, 0xC3, 0x7F, 0x10, 0x60, 0x60, 0xE4,
    0x12, 0x91, 0xFB, 0x2F, 0x27, 0x27, 0xC7, 0x00, 0xC3, 0x00, 0xE8, 0x34,
    0x0A, 0xC3, 0x71, 0xF2, 0x1D, 0xE6, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
};
static const uint32_t k_pngPixels[8] = {
    PX(255, 0, 0, 255), PX(0, 255, 0, 128), PX(0, 0, 255, 255), PX(255, 255, 255, 0),
    PX(10, 20, 30, 255), PX(40, 50, 60, 255), PX(70, 80, 90, 255), PX(100, 110, 120, 255),
};

/* 4x2 24bpp BMP, bottom-up (the ordinary on-disk layout — proving the
 * decoder flips it is half the point of this fixture). */
static const BYTE k_bmp[] = {
    0x42, 0x4D, 0x4E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00,
    0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x00,
    0x00, 0x00, 0xC4, 0x0E, 0x00, 0x00, 0xC4, 0x0E, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x02, 0x01, 0x06, 0x05, 0x04,
    0x09, 0x08, 0x07, 0xE6, 0xF0, 0xFA, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00,
    0xFF, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
};
static const uint32_t k_bmpPixels[8] = {
    PX(255, 0, 0, 255), PX(0, 255, 0, 255), PX(0, 0, 255, 255), PX(255, 255, 255, 255),
    PX(1, 2, 3, 255), PX(4, 5, 6, 255), PX(7, 8, 9, 255), PX(250, 240, 230, 255),
};

/* 4x2 GIF89a, TWO frames, delays 10cs and 20cs, NETSCAPE loop count 3 —
 * exactly the metadata shimgvw's anime.c reads through the property-item
 * calls. Frame 1 carries a LOCAL palette, which the frame-2 assert also
 * exercises. */
static const BYTE k_gif[] = {
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x04, 0x00, 0x02, 0x00, 0x81, 0x00,
    0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
    0xFF, 0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45,
    0x32, 0x2E, 0x30, 0x03, 0x01, 0x03, 0x00, 0x00, 0x21, 0xF9, 0x04, 0x08,
    0x0A, 0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x02,
    0x00, 0x00, 0x08, 0x0C, 0x00, 0x01, 0x04, 0x10, 0x30, 0x60, 0x80, 0x80,
    0x00, 0x00, 0x02, 0x02, 0x00, 0x21, 0xF9, 0x04, 0x08, 0x14, 0x00, 0x00,
    0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x02, 0x00, 0x81, 0x00,
    0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08,
    0x09, 0x00, 0x01, 0x08, 0x04, 0x10, 0xA0, 0x60, 0x80, 0x80, 0x00, 0x3B,
};
static const uint32_t k_gifFrame0[8] = {
    PX(255, 0, 0, 255), PX(0, 255, 0, 255), PX(0, 0, 255, 255), PX(255, 255, 255, 255),
    PX(255, 255, 255, 255), PX(0, 0, 255, 255), PX(0, 255, 0, 255), PX(255, 0, 0, 255),
};
static const uint32_t k_gifFrame1[8] = {
    PX(0, 255, 0, 255), PX(0, 255, 0, 255), PX(0, 255, 0, 255), PX(0, 255, 0, 255),
    PX(0, 0, 255, 255), PX(0, 0, 255, 255), PX(0, 0, 255, 255), PX(0, 0, 255, 255),
};

/* 8x8 JPEG, quality 100, no chroma subsampling: rows 0-3 (200,30,40),
 * rows 4-7 (20,180,90). JPEG is lossy, so the asserts below carry a
 * tolerance — flat blocks at q100 land within a couple of levels. */
static const BYTE k_jpg[] = {
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0xFF, 0xDB, 0x00, 0x43, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x08, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xC4, 0x00,
    0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
    0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00,
    0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00,
    0x00, 0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21,
    0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81,
    0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24,
    0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25,
    0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56,
    0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A,
    0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
    0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3,
    0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6,
    0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9,
    0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1,
    0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xC4, 0x00,
    0x1F, 0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
    0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x11, 0x00,
    0x02, 0x01, 0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00,
    0x01, 0x02, 0x77, 0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31,
    0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08,
    0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0, 0x15,
    0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18,
    0x19, 0x1A, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84,
    0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
    0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA,
    0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4,
    0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
    0xD8, 0xD9, 0xDA, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA,
    0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA, 0x00,
    0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0xF8,
    0xBF, 0xFE, 0x19, 0xBB, 0xFE, 0xA7, 0x3F, 0xFC, 0xB7, 0x7F, 0xFB, 0xFB,
    0x5F, 0xCA, 0xFF, 0x00, 0xD9, 0x3F, 0xF5, 0x11, 0xFF, 0x00, 0x94, 0xBF,
    0xFB, 0xA1, 0xF5, 0x9F, 0xF1, 0x71, 0xCF, 0xFD, 0x61, 0xBF, 0xFE, 0x7C,
    0x37, 0xFF, 0x00, 0x90, 0xE3, 0xFF, 0xD9,
};

/* ============================================================ helpers */

static IStream *stream_of(const BYTE *data, size_t n) {
    HGLOBAL h = GlobalAlloc(0, n);
    if (!h) return NULL;
    memcpy(GlobalLock(h), data, n);
    GlobalUnlock(h);
    IStream *s = NULL;
    if (FAILED(CreateStreamOnHGlobal(h, TRUE, &s))) { GlobalFree(h); return NULL; }
    ULARGE_INTEGER sz;
    sz.QuadPart = n;
    IStream_SetSize(s, sz);
    return s;
}

static GpStatus load_mem(const BYTE *data, size_t n, GpImage **out) {
    IStream *s = stream_of(data, n);
    if (!s) return OutOfMemory;
    GpStatus st = GdipLoadImageFromStream(s, out);
    IStream_Release(s);
    return st;
}

static int write_file(const char *path, const BYTE *data, size_t n) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    size_t w = fwrite(data, 1, n, f);
    return fclose(f) == 0 && w == n;
}

/* Read the image's active frame back out as pixel words, through the same
 * memory-DC path the draw uses. */
static void read_frame(GpImage *img, UINT w, UINT h, uint32_t *out) {
    HDC dc = CreateCompatibleDC(NULL);
    HBITMAP bm = CreateCompatibleBitmap(NULL, (int)w, (int)h);
    HGDIOBJ old = SelectObject(dc, (HGDIOBJ)bm);
    GpGraphics *g = NULL;
    GdipCreateFromHDC(dc, &g);
    GdipSetInterpolationMode(g, InterpolationModeNearestNeighbor);
    GdipDrawImageRectRect(g, img, 0, 0, (REAL)w, (REAL)h,
                          0, 0, (REAL)w, (REAL)h, UnitPixel, NULL, NULL, NULL);
    GdipDeleteGraphics(g);
    for (UINT y = 0; y < h; y++)
        for (UINT x = 0; x < w; x++)
            out[y * w + x] = (uint32_t)GetPixel(dc, (int)x, (int)y);
    SelectObject(dc, old);
    DeleteDC(dc);
    DeleteObject((HGDIOBJ)bm);
}

/* The draw path is SRCCOPY, so alpha never reaches the destination —
 * compare the RGB triple only. */
#define RGB_OF(p) ((p) & 0x00FFFFFFu)

static int near_u8(int a, int b, int tol) {
    int d = a - b;
    if (d < 0) d = -d;
    return d <= tol;
}

/* ============================================================ legs */

static void leg_startup_discipline(void) {
    /* Before GdiplusStartup, GDI+ refuses. Proving it here also proves
     * REQUIRE_STARTED is not decorative. */
    UINT w = 0;
    check("pre_startup_refused",
          GdipGetImageWidth(NULL, &w) == GdiplusNotInitialized);
}

static void leg_png(void) {
    GpImage *img = NULL;
    check("png_load", load_mem(k_png, sizeof k_png, &img) == Ok && img != NULL);
    if (!img) return;

    UINT w = 0, h = 0, flags = 0, frames = 0, dims = 0;
    GUID raw;
    check("png_width", GdipGetImageWidth(img, &w) == Ok && w == 4);
    check("png_height", GdipGetImageHeight(img, &h) == Ok && h == 2);
    check("png_rawformat", GdipGetImageRawFormat(img, &raw) == Ok &&
                           IsEqualGUID(&raw, &ImageFormatPNG));
    check("png_flags_alpha", GdipGetImageFlags(img, &flags) == Ok &&
                             (flags & ImageFlagsHasAlpha) &&
                             (flags & ImageFlagsHasTranslucent));
    check("png_dimcount", GdipImageGetFrameDimensionsCount(img, &dims) == Ok &&
                          dims == 1);
    GUID dim;
    check("png_dim_is_page",
          GdipImageGetFrameDimensionsList(img, &dim, 1) == Ok &&
          IsEqualGUID(&dim, &FrameDimensionPage));
    check("png_framecount",
          GdipImageGetFrameCount(img, &dim, &frames) == Ok && frames == 1);

    uint32_t got[8];
    read_frame(img, 4, 2, got);
    int all = 1;
    for (int i = 0; i < 8; i++)
        if (RGB_OF(got[i]) != RGB_OF(k_pngPixels[i])) all = 0;
    check("png_pixels", all);

    /* No property items on a still PNG — GDI+ says PropertyNotFound, and
     * so must we (shimgvw's anime.c depends on the distinction). */
    UINT sz = 0;
    check("png_no_framedelay",
          GdipGetPropertyItemSize(img, PropertyTagFrameDelay, &sz) ==
              PropertyNotFound);

    GdipDisposeImage(img);

    /* CAN-FAIL CONTROL: corrupt the compressed data. */
    BYTE bad[sizeof k_png];
    memcpy(bad, k_png, sizeof bad);
    bad[50] ^= 0xFF;
    bad[51] ^= 0xFF;
    GpImage *nope = (GpImage *)1;
    check("png_corrupt_rejected",
          load_mem(bad, sizeof bad, &nope) != Ok && nope == NULL);
}

static void leg_bmp(void) {
    GpImage *img = NULL;
    check("bmp_load", load_mem(k_bmp, sizeof k_bmp, &img) == Ok && img != NULL);
    if (!img) return;

    UINT w = 0, h = 0;
    GUID raw;
    check("bmp_width", GdipGetImageWidth(img, &w) == Ok && w == 4);
    check("bmp_height", GdipGetImageHeight(img, &h) == Ok && h == 2);
    check("bmp_rawformat", GdipGetImageRawFormat(img, &raw) == Ok &&
                           IsEqualGUID(&raw, &ImageFormatBMP));
    /* A 24bpp BMP has no alpha mask and CANNOT carry alpha. Claiming it
     * does is not cosmetic: a viewer reads exactly these bits to decide
     * whether to paint a transparency checkerboard behind the image, so a
     * blanket HasAlpha puts a checkerboard behind every ordinary bitmap. */
    UINT flags = 0;
    check("bmp24_reports_no_alpha", GdipGetImageFlags(img, &flags) == Ok &&
                                    !(flags & ImageFlagsHasAlpha) &&
                                    !(flags & ImageFlagsHasTranslucent));

    uint32_t got[8];
    read_frame(img, 4, 2, got);
    int all = 1;
    for (int i = 0; i < 8; i++)
        if (RGB_OF(got[i]) != RGB_OF(k_bmpPixels[i])) all = 0;
    check("bmp_pixels_bottom_up_flipped", all);
    GdipDisposeImage(img);

    /* CAN-FAIL CONTROL: truncate mid-pixel-data. */
    GpImage *nope = (GpImage *)1;
    check("bmp_truncated_rejected",
          load_mem(k_bmp, 60, &nope) != Ok && nope == NULL);
}

static void leg_jpeg(void) {
    GpImage *img = NULL;
    check("jpeg_load", load_mem(k_jpg, sizeof k_jpg, &img) == Ok && img != NULL);
    if (!img) return;

    UINT w = 0, h = 0;
    GUID raw;
    check("jpeg_width", GdipGetImageWidth(img, &w) == Ok && w == 8);
    check("jpeg_height", GdipGetImageHeight(img, &h) == Ok && h == 8);
    check("jpeg_rawformat", GdipGetImageRawFormat(img, &raw) == Ok &&
                            IsEqualGUID(&raw, &ImageFormatJPEG));
    UINT flags = 0;
    check("jpeg_flags_opaque", GdipGetImageFlags(img, &flags) == Ok &&
                               !(flags & ImageFlagsHasAlpha));

    uint32_t got[64];
    read_frame(img, 8, 8, got);
    uint32_t top = got[8 * 1 + 4], bot = got[8 * 6 + 4];
    check("jpeg_top_block",
          near_u8((int)(top & 0xFF), 200, 6) &&
          near_u8((int)((top >> 8) & 0xFF), 30, 6) &&
          near_u8((int)((top >> 16) & 0xFF), 40, 6));
    check("jpeg_bottom_block",
          near_u8((int)(bot & 0xFF), 20, 6) &&
          near_u8((int)((bot >> 8) & 0xFF), 180, 6) &&
          near_u8((int)((bot >> 16) & 0xFF), 90, 6));
    GdipDisposeImage(img);

    /* CAN-FAIL CONTROL: truncate to a third and garble what is left — the
     * same recipe as tests/kernel/test_cc_libjpeg_e2e.js, chosen because
     * libjpeg treats a merely-garbled tail as a WARNING and still returns
     * pixels. This cuts inside the Huffman tables, which is a real error.
     * A libjpeg that called exit() here instead of longjmp would take the
     * process with it, so this also pins the error manager. */
    size_t badN = sizeof k_jpg / 3;
    BYTE *bad = (BYTE *)malloc(badN);
    memcpy(bad, k_jpg, badN);
    for (size_t i = 30; i < badN; i += 7) bad[i] ^= 0xA5;
    GpImage *nope = (GpImage *)1;
    check("jpeg_corrupt_rejected",
          load_mem(bad, badN, &nope) != Ok && nope == NULL);
    free(bad);
}

static void leg_gif(void) {
    GpImage *img = NULL;
    check("gif_load", load_mem(k_gif, sizeof k_gif, &img) == Ok && img != NULL);
    if (!img) return;

    UINT w = 0, h = 0, frames = 0, dims = 0;
    GUID raw, dim;
    check("gif_width", GdipGetImageWidth(img, &w) == Ok && w == 4);
    check("gif_height", GdipGetImageHeight(img, &h) == Ok && h == 2);
    check("gif_rawformat", GdipGetImageRawFormat(img, &raw) == Ok &&
                           IsEqualGUID(&raw, &ImageFormatGIF));
    check("gif_dimcount", GdipImageGetFrameDimensionsCount(img, &dims) == Ok &&
                          dims == 1);
    check("gif_dim_is_time",
          GdipImageGetFrameDimensionsList(img, &dim, 1) == Ok &&
          IsEqualGUID(&dim, &FrameDimensionTime));
    check("gif_framecount",
          GdipImageGetFrameCount(img, &dim, &frames) == Ok && frames == 2);

    uint32_t got[8];
    int all = 1;
    read_frame(img, 4, 2, got);
    for (int i = 0; i < 8; i++)
        if (RGB_OF(got[i]) != RGB_OF(k_gifFrame0[i])) all = 0;
    check("gif_frame0_pixels", all);

    check("gif_select_frame1",
          GdipImageSelectActiveFrame(img, &FrameDimensionTime, 1) == Ok);
    all = 1;
    read_frame(img, 4, 2, got);
    for (int i = 0; i < 8; i++)
        if (RGB_OF(got[i]) != RGB_OF(k_gifFrame1[i])) all = 0;
    check("gif_frame1_pixels", all);

    /* The wrong dimension MUST fail — anime.c falls back on exactly this. */
    /* RotateFlip is ALL-OR-NOTHING across frames: turn the animation and
     * BOTH frames must come back at the new extent with the right pixels.
     * A per-frame commit that gave up partway would leave frame 1 at the
     * old size while the image reported the new one. */
    check("gif_rotate90", GdipImageRotateFlip(img, Rotate90FlipNone) == Ok);
    check("gif_rotate90_dims", GdipGetImageWidth(img, &w) == Ok && w == 2 &&
                               GdipGetImageHeight(img, &h) == Ok && h == 4);
    uint32_t turned[8];
    for (UINT f = 0; f < 2; f++) {
        const uint32_t *want = f ? k_gifFrame1 : k_gifFrame0;
        GdipImageSelectActiveFrame(img, &FrameDimensionTime, f);
        read_frame(img, 2, 4, turned);
        int rot = 1;
        for (int y = 0; y < 2; y++)
            for (int x = 0; x < 4; x++)
                if (RGB_OF(turned[x * 2 + (2 - 1 - y)]) != RGB_OF(want[y * 4 + x]))
                    rot = 0;
        check(f ? "gif_rotate90_frame1_pixels" : "gif_rotate90_frame0_pixels", rot);
    }
    check("gif_rotate_back", GdipImageRotateFlip(img, Rotate270FlipNone) == Ok);
    GdipImageSelectActiveFrame(img, &FrameDimensionTime, 0);

    check("gif_wrong_dimension_refused",
          GdipImageSelectActiveFrame(img, &FrameDimensionPage, 0) != Ok);
    check("gif_frame_out_of_range_refused",
          GdipImageSelectActiveFrame(img, &FrameDimensionTime, 2) != Ok);
    GdipImageSelectActiveFrame(img, &FrameDimensionTime, 0);

    /* Property items: frame delays (centiseconds) and the loop count. */
    UINT sz = 0;
    check("gif_framedelay_size",
          GdipGetPropertyItemSize(img, PropertyTagFrameDelay, &sz) == Ok &&
          sz == sizeof(PropertyItem) + 2 * sizeof(LONG));
    PropertyItem *pi = (PropertyItem *)malloc(sz);
    check("gif_framedelay_item",
          GdipGetPropertyItem(img, PropertyTagFrameDelay, sz, pi) == Ok &&
          pi->type == PropertyTagTypeLong &&
          pi->length == 2 * sizeof(LONG) &&
          ((LONG *)pi->value)[0] == 10 && ((LONG *)pi->value)[1] == 20);
    check("gif_framedelay_short_buffer_refused",
          GdipGetPropertyItem(img, PropertyTagFrameDelay, sz - 1, pi) ==
              InsufficientBuffer);
    free(pi);

    sz = 0;
    check("gif_loopcount_size",
          GdipGetPropertyItemSize(img, PropertyTagLoopCount, &sz) == Ok &&
          sz == sizeof(PropertyItem) + sizeof(WORD));
    pi = (PropertyItem *)malloc(sz);
    check("gif_loopcount_item",
          GdipGetPropertyItem(img, PropertyTagLoopCount, sz, pi) == Ok &&
          pi->type == PropertyTagTypeShort &&
          *(WORD *)pi->value == 3);
    free(pi);
    GdipDisposeImage(img);

    /* CAN-FAIL CONTROL: the header never lands. */
    GpImage *nope = (GpImage *)1;
    check("gif_truncated_header_rejected",
          load_mem(k_gif, 12, &nope) != Ok && nope == NULL);
}

/* arm 4: the draw path at a non-1:1 scale. NEAREST NEIGHBOUR is the mode
 * under test — at exactly 2x every source pixel becomes a 2x2 block, and
 * NO interpolated value may appear anywhere in the destination. */
static void leg_draw_scaled(void) {
    GpImage *img = NULL;
    if (load_mem(k_bmp, sizeof k_bmp, &img) != Ok || !img) {
        check("draw2x_setup", 0);
        return;
    }
    HDC dc = CreateCompatibleDC(NULL);
    HBITMAP bm = CreateCompatibleBitmap(NULL, 8, 4);
    HGDIOBJ old = SelectObject(dc, (HGDIOBJ)bm);
    PatBlt(dc, 0, 0, 8, 4, BLACKNESS);

    GpGraphics *g = NULL;
    check("draw2x_creategraphics", GdipCreateFromHDC(dc, &g) == Ok && g != NULL);
    check("draw2x_smoothing", GdipSetSmoothingMode(g, SmoothingModeNone) == Ok);
    check("draw2x_interp",
          GdipSetInterpolationMode(g, InterpolationModeNearestNeighbor) == Ok);

    GpImageAttributes *attr = NULL;
    check("draw2x_attrs", GdipCreateImageAttributes(&attr) == Ok && attr != NULL);
    check("draw2x_wrapmode",
          GdipSetImageAttributesWrapMode(attr, WrapModeTile, 0xFF000000, TRUE) == Ok);

    check("draw2x_draw",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, 0, 0, 4, 2,
                                UnitPixel, attr, NULL, NULL) == Ok);

    int all = 1;
    for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 8; x++) {
            uint32_t want = k_bmpPixels[(y / 2) * 4 + (x / 2)];
            if (RGB_OF((uint32_t)GetPixel(dc, x, y)) != RGB_OF(want)) all = 0;
        }
    }
    check("draw2x_nearest_blocks_exact", all);

    /* A source rect that is a SUB-rectangle, still at 2x: proves the
     * source origin is honoured, not just the extent. */
    PatBlt(dc, 0, 0, 8, 4, BLACKNESS);
    check("draw2x_subrect_draw",
          GdipDrawImageRectRect(g, img, 0, 0, 4, 2, 2, 0, 2, 1,
                                UnitPixel, attr, NULL, NULL) == Ok);
    all = 1;
    for (int y = 0; y < 2; y++)
        for (int x = 0; x < 4; x++)
            if (RGB_OF((uint32_t)GetPixel(dc, x, y)) !=
                RGB_OF(k_bmpPixels[2 + x / 2])) all = 0;
    check("draw2x_subrect_exact", all);

    /* shimgvw draws with a -0.5f source origin (its interpolation nudge);
     * rounding must land it back on pixel 0, not off the image. */
    PatBlt(dc, 0, 0, 8, 4, BLACKNESS);
    check("draw_halfpixel_origin_draw",
          GdipDrawImageRectRect(g, img, 0, 0, 4, 2, -0.5f, -0.5f, 4, 2,
                                UnitPixel, attr, NULL, NULL) == Ok);
    check("draw_halfpixel_origin_exact",
          RGB_OF((uint32_t)GetPixel(dc, 0, 0)) == RGB_OF(k_bmpPixels[0]) &&
          RGB_OF((uint32_t)GetPixel(dc, 3, 1)) == RGB_OF(k_bmpPixels[7]));

    /* A non-nearest mode is ACCEPTED (a GDI+ setter's whole contract is to
     * record the state) and the draw still succeeds — but it is drawn
     * NEAREST, and the shim says so on stderr. Assert both halves here:
     * the status is Ok, and the result is bit-identical to the nearest
     * draw above, i.e. the substitution is exactly the documented one and
     * not some third behaviour.
     * The stderr line itself is asserted by tests/kernel/test_gdiplus_e2e.js
     * (in-process there is nothing to read it back from). */
    check("interp_bilinear_accepted",
          GdipSetInterpolationMode(g, InterpolationModeHighQualityBilinear) == Ok);
    PatBlt(dc, 0, 0, 8, 4, BLACKNESS);
    check("interp_bilinear_draw_ok",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, 0, 0, 4, 2,
                                UnitPixel, attr, NULL, NULL) == Ok);
    all = 1;
    for (int y = 0; y < 4; y++)
        for (int x = 0; x < 8; x++)
            if (RGB_OF((uint32_t)GetPixel(dc, x, y)) !=
                RGB_OF(k_bmpPixels[(y / 2) * 4 + (x / 2)])) all = 0;
    check("interp_bilinear_is_really_nearest", all);
    GdipSetInterpolationMode(g, InterpolationModeNearestNeighbor);

    GdipDisposeImageAttributes(attr);
    GdipDeleteGraphics(g);
    GdipDisposeImage(img);
    SelectObject(dc, old);
    DeleteDC(dc);
    DeleteObject((HGDIOBJ)bm);
}

static void leg_rotate_flip(void) {
    GpImage *img = NULL;
    if (load_mem(k_bmp, sizeof k_bmp, &img) != Ok || !img) {
        check("rotate_setup", 0);
        return;
    }
    UINT w = 0, h = 0;
    check("rotate_noop", GdipImageRotateFlip(img, RotateNoneFlipNone) == Ok);

    check("rotate90", GdipImageRotateFlip(img, Rotate90FlipNone) == Ok);
    check("rotate90_dims", GdipGetImageWidth(img, &w) == Ok && w == 2 &&
                           GdipGetImageHeight(img, &h) == Ok && h == 4);
    uint32_t got[8];
    read_frame(img, 2, 4, got);
    /* 90 CW: source (x,y) -> dest (h-1-y, x) with dest width h=2. */
    int all = 1;
    for (int y = 0; y < 2; y++)
        for (int x = 0; x < 4; x++) {
            int dx = 2 - 1 - y, dy = x;
            if (RGB_OF(got[dy * 2 + dx]) != RGB_OF(k_bmpPixels[y * 4 + x])) all = 0;
        }
    check("rotate90_pixels", all);

    /* Back round: three more quarter-turns restores the original. */
    check("rotate270_back", GdipImageRotateFlip(img, Rotate270FlipNone) == Ok);
    check("rotate_roundtrip_dims", GdipGetImageWidth(img, &w) == Ok && w == 4 &&
                                   GdipGetImageHeight(img, &h) == Ok && h == 2);
    read_frame(img, 4, 2, got);
    all = 1;
    for (int i = 0; i < 8; i++)
        if (RGB_OF(got[i]) != RGB_OF(k_bmpPixels[i])) all = 0;
    check("rotate_roundtrip_pixels", all);

    /* Horizontal flip — the case that CANNOT be a negative-extent blit,
     * because gdi32's StretchBlt refuses those (it has no mirroring
     * path). This is why RotateFlip is a pixel loop. */
    check("flipx", GdipImageRotateFlip(img, RotateNoneFlipX) == Ok);
    read_frame(img, 4, 2, got);
    all = 1;
    for (int y = 0; y < 2; y++)
        for (int x = 0; x < 4; x++)
            if (RGB_OF(got[y * 4 + x]) != RGB_OF(k_bmpPixels[y * 4 + (3 - x)]))
                all = 0;
    check("flipx_pixels", all);

    check("rotate_bad_type_refused",
          GdipImageRotateFlip(img, (RotateFlipType)99) == InvalidParameter);
    GdipDisposeImage(img);
}

static void leg_codec_tables(void) {
    UINT num = 0, size = 0;
    check("encoders_size", GdipGetImageEncodersSize(&num, &size) == Ok &&
                           num == 2 && size > num * sizeof(ImageCodecInfo));
    ImageCodecInfo *enc = (ImageCodecInfo *)malloc(size);
    check("encoders_fill", GdipGetImageEncoders(num, size, enc) == Ok);
    int haveBmp = 0, havePng = 0, strsOk = 1;
    for (UINT i = 0; i < num; i++) {
        if (IsEqualGUID(&enc[i].FormatID, &ImageFormatBMP)) haveBmp = 1;
        if (IsEqualGUID(&enc[i].FormatID, &ImageFormatPNG)) havePng = 1;
        if (!enc[i].FormatDescription || !enc[i].FilenameExtension ||
            !enc[i].MimeType || !enc[i].FormatDescription[0]) strsOk = 0;
        if (!(enc[i].Flags & ImageCodecFlagsEncoder)) strsOk = 0;
    }
    check("encoders_bmp_and_png", haveBmp && havePng);
    check("encoders_strings_packed", strsOk);
    check("encoders_short_buffer_refused",
          GdipGetImageEncoders(num, size - 1, enc) == InvalidParameter);
    free(enc);

    num = 0; size = 0;
    check("decoders_size", GdipGetImageDecodersSize(&num, &size) == Ok &&
                           num == 4 && size > num * sizeof(ImageCodecInfo));
    ImageCodecInfo *dec = (ImageCodecInfo *)malloc(size);
    check("decoders_fill", GdipGetImageDecoders(num, size, dec) == Ok);
    int seen = 0;
    for (UINT i = 0; i < num; i++) {
        if (IsEqualGUID(&dec[i].FormatID, &ImageFormatBMP)) seen |= 1;
        if (IsEqualGUID(&dec[i].FormatID, &ImageFormatJPEG)) seen |= 2;
        if (IsEqualGUID(&dec[i].FormatID, &ImageFormatGIF)) seen |= 4;
        if (IsEqualGUID(&dec[i].FormatID, &ImageFormatPNG)) seen |= 8;
    }
    check("decoders_all_four_formats", seen == 15);
    free(dec);
}

static void leg_save_roundtrip(void) {
    GpImage *img = NULL;
    if (load_mem(k_png, sizeof k_png, &img) != Ok || !img) {
        check("save_setup", 0);
        return;
    }
    UINT num = 0, size = 0;
    GdipGetImageEncodersSize(&num, &size);
    ImageCodecInfo *enc = (ImageCodecInfo *)malloc(size);
    GdipGetImageEncoders(num, size, enc);
    CLSID bmpClsid, pngClsid;
    memset(&bmpClsid, 0, sizeof bmpClsid);
    memset(&pngClsid, 0, sizeof pngClsid);
    for (UINT i = 0; i < num; i++) {
        if (IsEqualGUID(&enc[i].FormatID, &ImageFormatBMP)) bmpClsid = enc[i].Clsid;
        if (IsEqualGUID(&enc[i].FormatID, &ImageFormatPNG)) pngClsid = enc[i].Clsid;
    }
    free(enc);

    /* PNG out, PNG back in: pixels AND alpha must survive. */
    check("save_png", GdipSaveImageToFile(img, u"gdiplus-rt.png",
                                          &pngClsid, NULL) == Ok);
    GpImage *back = NULL;
    check("save_png_reload",
          GdipLoadImageFromFile(u"gdiplus-rt.png", &back) == Ok && back);
    if (back) {
        UINT w = 0, h = 0, flags = 0;
        check("save_png_dims", GdipGetImageWidth(back, &w) == Ok && w == 4 &&
                               GdipGetImageHeight(back, &h) == Ok && h == 2);
        check("save_png_alpha_survived",
              GdipGetImageFlags(back, &flags) == Ok &&
              (flags & ImageFlagsHasTranslucent));
        uint32_t got[8];
        read_frame(back, 4, 2, got);
        int all = 1;
        for (int i = 0; i < 8; i++)
            if (RGB_OF(got[i]) != RGB_OF(k_pngPixels[i])) all = 0;
        check("save_png_pixels", all);
        GdipDisposeImage(back);
    }

    /* BMP out, BMP back in. */
    check("save_bmp", GdipSaveImageToFile(img, u"gdiplus-rt.bmp",
                                          &bmpClsid, NULL) == Ok);
    back = NULL;
    check("save_bmp_reload",
          GdipLoadImageFromFile(u"gdiplus-rt.bmp", &back) == Ok && back);
    if (back) {
        GUID raw;
        check("save_bmp_rawformat", GdipGetImageRawFormat(back, &raw) == Ok &&
                                    IsEqualGUID(&raw, &ImageFormatBMP));
        uint32_t got[8];
        read_frame(back, 4, 2, got);
        int all = 1;
        for (int i = 0; i < 8; i++)
            if (RGB_OF(got[i]) != RGB_OF(k_pngPixels[i])) all = 0;
        check("save_bmp_pixels", all);
        GdipDisposeImage(back);
    }
    GdipDisposeImage(img);
}

static void leg_load_from_file(void) {
    check("file_write_png", write_file("gdiplus-in.png", k_png, sizeof k_png));
    GpImage *img = NULL;
    check("loadfromfile_png",
          GdipLoadImageFromFile(u"gdiplus-in.png", &img) == Ok && img);
    if (img) {
        UINT w = 0;
        check("loadfromfile_png_width", GdipGetImageWidth(img, &w) == Ok && w == 4);
        GdipDisposeImage(img);
    }
    GpImage *nope = (GpImage *)1;
    check("loadfromfile_missing_refused",
          GdipLoadImageFromFile(u"no-such-image.png", &nope) == FileNotFound &&
          nope == NULL);
}

/* arm 2: nothing here may quietly succeed. */
static void leg_fail_loud(void) {
    GpImage *img = NULL;
    if (load_mem(k_bmp, sizeof k_bmp, &img) != Ok || !img) {
        check("failloud_setup", 0);
        return;
    }
    /* An encoder we do not have. The JPEG CLSID is a REAL Windows codec
     * id, so this is a caller asking for something plausible. */
    CLSID jpegClsid =
        { 0x557cf401, 0x1a04, 0x11d3, { 0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
    check("save_jpeg_refused",
          GdipSaveImageToFile(img, u"nope.jpg", &jpegClsid, NULL) ==
              UnknownImageFormat);

    /* Encoder parameters are not honoured, so they are not accepted. */
    EncoderParameters ep;
    memset(&ep, 0, sizeof ep);
    CLSID bmpClsid =
        { 0x557cf400, 0x1a04, 0x11d3, { 0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e } };
    check("save_encoderparams_refused",
          GdipSaveImageToFile(img, u"nope.bmp", &bmpClsid, &ep) ==
              NotImplemented);

    HDC dc = CreateCompatibleDC(NULL);
    HBITMAP bm = CreateCompatibleBitmap(NULL, 8, 4);
    HGDIOBJ old = SelectObject(dc, (HGDIOBJ)bm);
    GpGraphics *g = NULL;
    GdipCreateFromHDC(dc, &g);
    check("draw_nonpixel_unit_refused",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, 0, 0, 4, 2,
                                UnitInch, NULL, NULL, NULL) == InvalidParameter);
    check("draw_abort_callback_refused",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, 0, 0, 4, 2,
                                UnitPixel, NULL, NULL, (void *)1) == NotImplemented);
    check("draw_zero_extent_refused",
          GdipDrawImageRectRect(g, img, 0, 0, 0, 4, 0, 0, 4, 2,
                                UnitPixel, NULL, NULL, NULL) == InvalidParameter);
    /* A source rect that leaves the image would need a wrap-mode fill,
     * which does not exist here. StretchBlt would simply skip those
     * pixels and this call would return Ok having drawn a partial image —
     * the silent-wrong-answer shape. It must refuse instead, with OR
     * without an attributes object, since the attributes only choose
     * WHICH fill would have been used. */
    GpImageAttributes *tile = NULL;
    GdipCreateImageAttributes(&tile);
    GdipSetImageAttributesWrapMode(tile, WrapModeTile, 0xFF000000, FALSE);
    check("draw_src_overruns_image_refused",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, 0, 0, 8, 2,
                                UnitPixel, tile, NULL, NULL) == InvalidParameter);
    check("draw_src_negative_origin_refused",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, -2, 0, 4, 2,
                                UnitPixel, tile, NULL, NULL) == InvalidParameter);
    check("draw_src_out_of_bounds_refused_without_attrs",
          GdipDrawImageRectRect(g, img, 0, 0, 8, 4, 0, 0, 4, 3,
                                UnitPixel, NULL, NULL, NULL) == InvalidParameter);
    GdipDisposeImageAttributes(tile);
    check("interp_bad_mode_refused",
          GdipSetInterpolationMode(g, (InterpolationMode)77) == InvalidParameter);
    check("smoothing_bad_mode_refused",
          GdipSetSmoothingMode(g, (SmoothingMode)77) == InvalidParameter);
    check("null_args_refused",
          GdipGetImageWidth(NULL, NULL) == InvalidParameter &&
          GdipCreateFromHDC(NULL, &g) == InvalidParameter);
    GdipDeleteGraphics(g);
    SelectObject(dc, old);
    DeleteDC(dc);
    DeleteObject((HGDIOBJ)bm);

    /* Unrecognised container: not guessed at. */
    static const BYTE junk[16] = { 'N','O','T','A','N','I','M','A',
                                   'G','E','!','!','!','!','!','!' };
    GpImage *nope = (GpImage *)1;
    check("unknown_signature_refused",
          load_mem(junk, sizeof junk, &nope) == UnknownImageFormat && nope == NULL);

    GdipDisposeImage(img);
}

/* The ole32 memory stream the loader path rides on (plan step 7). */
static void leg_stream(void) {
    check("oleinit_first", OleInitialize(NULL) == S_OK);
    check("oleinit_nested", OleInitialize(NULL) == S_FALSE);
    OleUninitialize();
    OleUninitialize();

    IStream *s = stream_of(k_bmp, sizeof k_bmp);
    check("stream_created", s != NULL);
    if (!s) return;
    STATSTG st;
    check("stream_stat", SUCCEEDED(IStream_Stat(s, &st, STATFLAG_NONAME)) &&
                         st.cbSize.QuadPart == sizeof k_bmp &&
                         st.type == STGTY_STREAM);
    BYTE head[2] = { 0, 0 };
    ULONG got = 0;
    check("stream_read", SUCCEEDED(IStream_Read(s, head, 2, &got)) && got == 2 &&
                         head[0] == 'B' && head[1] == 'M');
    LARGE_INTEGER mv;
    ULARGE_INTEGER pos;
    mv.QuadPart = -2;
    check("stream_seek_end",
          SUCCEEDED(IStream_Seek(s, mv, STREAM_SEEK_END, &pos)) &&
          pos.QuadPart == sizeof k_bmp - 2);
    /* A short read at EOF is S_OK with a short count, not an error. */
    BYTE tail[8];
    got = 0;
    check("stream_short_read_ok",
          SUCCEEDED(IStream_Read(s, tail, 8, &got)) && got == 2);
    /* SIZE_T is 32 bits and the IStream API speaks 64-bit offsets. Every
     * crossing must REFUSE, never truncate: a wrapped offset or length is
     * a write outside the HGLOBAL, and a truncated SetSize is an S_OK
     * whose logical size is not the one that was asked for. */
    ULARGE_INTEGER huge;
    huge.QuadPart = 0x1FFFFFFFFULL;               /* > 2^32 - 1 */
    check("stream_setsize_beyond_address_range_refused",
          FAILED(IStream_SetSize(s, huge)));
    mv.QuadPart = 0x1FFFFFFFFLL;
    check("stream_seek_beyond_address_range_refused",
          FAILED(IStream_Seek(s, mv, STREAM_SEEK_SET, &pos)));
    /* pos + cb must not wrap either: seek to a LEGAL offset near the top
     * of the range, then write past it. Unguarded, the reservation wraps
     * to a small number, succeeds, and the memcpy lands outside the
     * allocation. */
    mv.QuadPart = (long long)0xFFFFFFF0ULL;
    check("stream_seek_near_top_ok",
          SUCCEEDED(IStream_Seek(s, mv, STREAM_SEEK_SET, &pos)) &&
          pos.QuadPart == 0xFFFFFFF0ULL);
    BYTE spill[64];
    memset(spill, 0xAB, sizeof spill);
    got = 0;
    check("stream_write_offset_overflow_refused",
          FAILED(IStream_Write(s, spill, sizeof spill, &got)) && got == 0);
    mv.QuadPart = 0;
    IStream_Seek(s, mv, STREAM_SEEK_SET, &pos);

    HGLOBAL h = NULL;
    check("stream_gethglobal", SUCCEEDED(GetHGlobalFromStream(s, &h)) && h);
    void *unwanted = (void *)1;
    check("stream_wrong_iid_refused",
          IStream_QueryInterface(s, &ImageFormatBMP, &unwanted) != S_OK &&
          unwanted == NULL);
    check("stream_release", IStream_Release(s) == 0);
}

/* ============================================================ main */

static void selftest(void) {
    leg_startup_discipline();

    struct GdiplusStartupInput in;
    ULONG_PTR token = 0;
    memset(&in, 0, sizeof in);
    in.GdiplusVersion = 1;
    check("startup", GdiplusStartup(&token, &in, NULL) == Ok && token != 0);

    struct GdiplusStartupInput bad;
    ULONG_PTR t2 = 0;
    memset(&bad, 0, sizeof bad);
    bad.GdiplusVersion = 99;
    check("startup_bad_version_refused",
          GdiplusStartup(&t2, &bad, NULL) == UnsupportedGdiplusVersion);

    leg_stream();
    leg_png();
    leg_bmp();
    leg_jpeg();
    leg_gif();
    leg_draw_scaled();
    leg_rotate_flip();
    leg_codec_tables();
    leg_save_roundtrip();
    leg_load_from_file();
    leg_fail_loud();

    GdiplusShutdown(token);

    if (g_fails) {
        printf("GDIPLUS-SELFTEST: %d/%d FAILED\n", g_fails, g_checks);
        exit(1);
    }
    printf("GDIPLUS-SELFTEST: %d/%d PASS\n", g_checks, g_checks);
    exit(0);
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "selftest") == 0) selftest();
    printf("usage: gdiplusdemo selftest\n");
    return 2;
}
