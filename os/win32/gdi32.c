/* gdi32.c — the GDI drawing subset (todos/0057, design todos/WIN32.md).
 *
 * A CPU rasterizer over 32-bit RGBA pixel buffers — the same pixel format
 * the surface protocol presents (R in byte 0, A in byte 3, tight rows).
 * An HDC wraps either a window's surface span (screen DC — since 0058
 * user32 owns HWNDs and presenting; gdi32 sees only the raw span via
 * __gdi_dc_wrap, win32_internal.h) or a selected HBITMAP (memory DC).
 * This is the DWM redirection model: CPU draw -> shm -> GPU composite
 * (todos/0055) — GDI *is* a CPU rasterizer, on Windows and here.
 *
 * Text goes through freetype (the vendored lib /bin/term uses), font at
 * /etc/fonts/mono.ttf with the baked /usr/share/fonts/mono.ttf fallback;
 * faceName is ignored (the baked face is the one family). Strings are
 * UTF-8 (0211): draw/measure step by code point; a code point face 0
 * lacks probes the FALLBACK CHAIN (fontchain.h — /etc/fonts/fallback
 * face list, populated by gucman font packages; Unicode Phase D) and a
 * code point NO face covers renders the synthesized tofu box (a LOUD
 * gap, never a '?' that reads as data corruption) and reports once via
 * WIN32_UNSUPPORTED. Control chars draw '?' (term's rule). Glyphs cache
 * lazily per HFONT (ASCII flat array + a code-point side cache — the
 * cached bitmap remembers whichever face rendered it, so the chain is
 * probed once per cp, never per paint).
 *
 * Deliberate 0057 simplifications (grow under 0060's missing-symbol log):
 *   - pens: PS_SOLID/PS_NULL honored, other styles draw solid; wide pens
 *     are square nibs centered on the path (no round caps/joins)
 *   - ellipse/roundrect outlines are 1px regardless of pen width
 *   - no CreateDIBSection (GetDIBits/SetDIBits copy+swizzle instead),
 *     no SaveDC/RestoreDC, no palettes, no world transforms, regions
 *     are just the DC clip rect (SelectClipRgn(NULL) resets)
 *   - COLORREF is 0x00BBGGRR (Windows) and the surface is R-low RGBA, so
 *     pen/brush colors pass through with alpha forced; DIBs swizzle B<->R
 *
 * Alpha discipline: every pixel this library writes has A=0xFF (the
 * compositor samples alpha; a 0-alpha pixel would show the desktop).
 */

/* The veneer is implemented ANSI (WIN32.md friction #2: implement W, shim
 * A). Ported apps build -DUNICODE (0060); the implementation must not. */
#undef UNICODE
#undef _UNICODE
/* A veneer-internal TU must not fire windows.h's §4.1 require block in its
 * own TU (macro/once state is per-TU): gdi32.c is the base layer of the
 * menucore.json SUBSET link (wm.c/term), which must never pull user32 and
 * friends. The freetype require block at the END of this file is gdi32's
 * own implementation dependency and stays unconditional. */
#ifndef WIN32_NO_REQUIRE_SOURCES
#define WIN32_NO_REQUIRE_SOURCES
#endif
#include <windows.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include "win32_internal.h"
#include "../fontcore.h"    /* the shared glyph pipeline (todos/0277) — pulls
                            * the fallback-face list (fontchain.h) and wcwidth.h
                            * (wide-cp tofu spans 2 cells) */

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================ fail-loud
 * (todos/0211, declared in win32_internal.h; moved here from kernel32.c
 * by M4/0259 — gdi32 is the base layer every veneer link set shares, so
 * wm.c can link gdi32+menucore without kernel32). One line to stderr per
 * call site — grep for "win32: unsupported" to inventory what's stubbed.
 * WIN32_STRICT=1 escalates to abort() so tests can trap on any hit. */

void __win32_unsupported(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char buf[256];
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    fprintf(stderr, "win32: unsupported %s\n", buf);
    const char *strict = getenv("WIN32_STRICT");
    if (strict && strict[0] == '1') abort();
}

#define FONT_PATH     "/etc/fonts/mono.ttf"
#define FONT_FALLBACK "/usr/share/fonts/mono.ttf"
#define STOCK_FONT_PX 20  /* THE system size (font-20 retune): equals the
                             wm chrome_font, so chrome, menus, controls and
                             the software center all share one 20px-AA face */
#define FT_MONO_THRESHOLD 96   /* NONANTIALIASED coverage cut (tuning knob) */

/* ============================================================ objects */

enum { OBJ_PEN = 1, OBJ_BRUSH, OBJ_FONT, OBJ_BITMAP };

/* one cached glyph == fontcore FcGlyph (todos/0277). */

struct __GDIOBJ {
    int type;
    int stock;                  /* stock objects: never freed, not counted */
    int selCount;               /* bitmaps: number of DCs selecting this */
    COLORREF color;             /* pen / brush */
    int penStyle, penWidth;
    int brushStyle, hatch;
    int bmW, bmH;               /* bitmap */
    uint32_t *bits;             /* RGBA rows, tight stride */
    FT_Face face;               /* font face 0 (NULL until first use) */
    FcChain fbc;                /* fallback chain faces (Phase D; fontcore) */
    int fontPx, fontLoaded, fontFailed;
    int fontMono;               /* NONANTIALIASED_QUALITY: 1-bit rendering */
    int ascent, descent, lineH, maxAdv, monoAdv;
    FcCache fontCache;          /* flat [95] ASCII + linear-scan side (0211) */
};

struct __DC {
    uint32_t *bits;
    int w, h, stride;           /* stride in pixels */
    int isScreen;
    HGDIOBJ pen, brush, font, bitmap, defBitmap;
    COLORREF textColor, bkColor;
    int bkMode, rop2;
    POINT cur;
    RECT clip;                  /* device coords, right/bottom exclusive */
};

static int g_objCount;          /* live non-stock GDI objects */
static int g_dcCount;           /* live DCs */

/* Live-DC registry (0211): DeleteObject on a pen/brush/font still
 * selected into a DC returned TRUE and freed it — a use-after-free on
 * the next draw. Real GDI returns FALSE there; now we can too. */
#define MAX_LIVE_DCS 128
static HDC g_liveDcs[MAX_LIVE_DCS];

static void dc_track(HDC dc) {
    for (int i = 0; i < MAX_LIVE_DCS; i++)
        if (!g_liveDcs[i]) { g_liveDcs[i] = dc; return; }
}

static void dc_untrack(HDC dc) {
    for (int i = 0; i < MAX_LIVE_DCS; i++)
        if (g_liveDcs[i] == dc) { g_liveDcs[i] = NULL; return; }
}

static int obj_selected_somewhere(HGDIOBJ o) {
    for (int i = 0; i < MAX_LIVE_DCS; i++) {
        HDC dc = g_liveDcs[i];
        if (dc && (dc->pen == o || dc->brush == o || dc->font == o))
            return 1;
    }
    return 0;
}

int __gdi_object_count(void) { return g_objCount; }
int __gdi_dc_count(void) { return g_dcCount; }

static HGDIOBJ obj_new(int type) {
    HGDIOBJ o = (HGDIOBJ)calloc(1, sizeof(struct __GDIOBJ));
    if (!o) return NULL;
    o->type = type;
    g_objCount++;
    return o;
}

/* ============================================================ colors */

static uint32_t px_of(COLORREF c) { return (c & 0x00FFFFFFu) | 0xFF000000u; }
static COLORREF cr_of(uint32_t p) { return p & 0x00FFFFFFu; }

/* ============================================================ pens/brushes */

HPEN CreatePen(int style, int width, COLORREF color) {
    if (style != PS_SOLID && style != PS_NULL)
        WIN32_UNSUPPORTED("pen style %d (drawn PS_SOLID)", style);
    HGDIOBJ o = obj_new(OBJ_PEN);
    if (!o) return NULL;
    o->penStyle = style;
    o->penWidth = width < 1 ? 1 : width;
    o->color = color;
    return o;
}

HBRUSH CreateSolidBrush(COLORREF color) {
    HGDIOBJ o = obj_new(OBJ_BRUSH);
    if (!o) return NULL;
    o->brushStyle = BS_SOLID;
    o->color = color;
    return o;
}

HBRUSH CreateHatchBrush(int hatch, COLORREF color) {
    HGDIOBJ o = obj_new(OBJ_BRUSH);
    if (!o) return NULL;
    o->brushStyle = BS_HATCHED;
    o->hatch = hatch;
    o->color = color;
    return o;
}

/* ============================================================ fonts */

static FT_Library g_ft;
static int g_ftInit;   /* 0 = not tried, 1 = ok, -1 = failed */

static int ft_ready(void) {
    if (g_ftInit == 0) g_ftInit = FT_Init_FreeType(&g_ft) ? -1 : 1;
    return g_ftInit == 1;
}

static int font_px_clamped(HGDIOBJ f) {
    int px = f->fontPx;
    if (px < 4) px = 4;
    if (px > 256) px = 256;
    return px;
}

/* ---- the fallback chain (Unicode Phase D, W7; fontcore FcChain) ----
 * The face PATH list loads once per process (fontchain.h); each HFONT
 * opens a chain face lazily at ITS pixel size the first time a code
 * point misses face 0 — apps that never draw exotic text never pay. */
static char g_fcPaths[FC_MAX_FALLBACKS][FC_PATH_MAX];
static int g_fcCount = -1;

static int fc_count(void) {
    if (g_fcCount < 0) g_fcCount = fc_load(g_fcPaths, FC_MAX_FALLBACKS);
    return g_fcCount;
}

/* Chain-face load-failure hook (once-guarded via WIN32_UNSUPPORTED). */
static void gdi_fc_fail(const char *p) {
    WIN32_UNSUPPORTED("fallback face %s (cannot load; skipping)", p);
}

static int font_ensure(HGDIOBJ f) {
    if (!f || f->type != OBJ_FONT) return -1;
    if (f->fontLoaded) return 0;
    if (f->fontFailed || !ft_ready()) return -1;
    if (FT_New_Face(g_ft, FONT_PATH, 0, &f->face) &&
        FT_New_Face(g_ft, FONT_FALLBACK, 0, &f->face)) {
        f->fontFailed = 1;
        return -1;
    }
    FT_Set_Pixel_Sizes(f->face, 0, font_px_clamped(f));
    f->ascent = (int)(f->face->size->metrics.ascender >> 6);
    f->descent = (int)(-(f->face->size->metrics.descender >> 6));
    f->lineH = (int)(f->face->size->metrics.height >> 6);
    f->maxAdv = (int)(f->face->size->metrics.max_advance >> 6);
    /* The mono cell pitch = 'M' advance (term's rule). max_advance is the
     * WIDEST glyph in the face — Noto Sans Mono carries a few wide forms,
     * so tofu geometry keys on the cell pitch, not on maxAdv. */
    f->monoAdv = 0;
    FT_UInt mi = FT_Get_Char_Index(f->face, 'M');
    if (mi && !FT_Load_Glyph(f->face, mi, fc_load_flags(f->face)))
        f->monoAdv = (int)(f->face->glyph->advance.x >> 6);
    if (f->monoAdv <= 0) f->monoAdv = f->maxAdv;
    if (f->descent < 0) f->descent = 0;
    if (f->lineH < f->ascent + f->descent) f->lineH = f->ascent + f->descent;
    fc_chain_init(&f->fbc, g_ft, g_fcPaths, fc_count(), gdi_fc_fail);
    f->fontLoaded = 1;
    return 0;
}

/* Render callback (fontcore cache seam): fill g for cp on this HFONT —
 * the covering face via fc_probe (chain sized to the HFONT's px), else
 * the tofu box. gdi32's only per-render knob is the NONANTIALIASED mono
 * threshold; the 1-bit cut THRESHOLDS the smooth coverage (this
 * freetype registers only the smooth renderer + no hinter, so raster1/
 * MONO would fail — and over the same unhinted outlines it yields
 * equivalent pixels; 96 not 128 keeps 1px stems alive at small ppem —
 * measured: >=128 drops the Roboto Mono 'T' stem at ppem 10). */
static FcGlyph *gdi_render(void *ctx, FcGlyph *g, unsigned cp) {
    HGDIOBJ f = (HGDIOBJ)ctx;
    g->loaded = 1;
    FT_UInt gi;
    FT_Face face = fc_probe(f->face, &f->fbc, font_px_clamped(f), cp, &gi);
    if (!face) {
        WIN32_UNSUPPORTED("font glyph U+%04X (no chain face has it; "
                          "drawing tofu)", cp);
        int cell = f->monoAdv > 0 ? f->monoAdv : f->maxAdv;
        fc_tofu(g, cell, f->ascent, cp);
        return g;
    }
    FcRenderOpts o = { f->fontMono ? FT_MONO_THRESHOLD : 0, 0 };
    return fc_render_face(g, face, gi, o);
}

/* Glyph for one CODE POINT (0211: the text loops decode UTF-8 and pass
 * code points here). ASCII stays the flat [95] array; everything else
 * lands in a linear-scan side cache. NB the returned pointer is only
 * stable until the next font_glyph call (the side cache reallocs). */
static FcGlyph *font_glyph(HGDIOBJ f, unsigned cp) {
    if (cp < 32) cp = '?';                       /* control chars, term's rule */
    return fc_cache_get(&f->fontCache, cp, gdi_render, f);
}

/* lfHeight < 0: character (em) height in px. lfHeight > 0: cell height —
 * scale by the face's font-unit line height so ascent+descent fits. */
static int font_px_for_height(int height) {
    if (height < 0) return -height;
    if (height == 0) return STOCK_FONT_PX;
    return height;   /* refined against real face metrics below */
}

HFONT CreateFont(int height, int width, int escapement, int orientation,
                 int weight, DWORD italic, DWORD underline, DWORD strikeout,
                 DWORD charset, DWORD outPrecision, DWORD clipPrecision,
                 DWORD quality, DWORD pitchAndFamily, LPCSTR faceName) {
    (void)width; (void)escapement; (void)orientation;
    (void)charset; (void)outPrecision; (void)clipPrecision;
    (void)pitchAndFamily; (void)faceName;
    if (weight >= FW_BOLD || italic || underline || strikeout)
        WIN32_UNSUPPORTED("font styles (bold/italic/underline — one face, "
                          "drawn regular)");
    HGDIOBJ o = obj_new(OBJ_FONT);
    if (!o) return NULL;
    o->fontPx = font_px_for_height(height);
    /* NONANTIALIASED_QUALITY = real GDI semantics: 1-bit (aliased) glyph
     * rendering. The wm chrome's Win95-crisp knob (Phase C / D1); any app
     * may ask for it. Other quality values keep the AA default. */
    o->fontMono = quality == NONANTIALIASED_QUALITY;
    /* Positive height means "cell height": load lazily, then shrink the
     * pixel size so ascent+descent <= height. Approximated at ensure time
     * by scaling with units_per_EM / (ascender - descender). */
    if (height > 0 && ft_ready()) {
        FT_Face probe;
        if (!FT_New_Face(g_ft, FONT_PATH, 0, &probe) ||
            !FT_New_Face(g_ft, FONT_FALLBACK, 0, &probe)) {
            long span = (long)probe->ascender - (long)probe->descender;
            if (span > 0)
                o->fontPx = (int)(((long long)height * probe->units_per_EM) / span);
            FT_Done_Face(probe);
            if (o->fontPx < 4) o->fontPx = 4;
        }
    }
    return o;
}

HFONT CreateFontIndirect(const LOGFONT *lf) {
    if (!lf) return NULL;
    return CreateFont(lf->lfHeight, lf->lfWidth, lf->lfEscapement,
                      lf->lfOrientation, lf->lfWeight, lf->lfItalic,
                      lf->lfUnderline, lf->lfStrikeOut, lf->lfCharSet,
                      lf->lfOutPrecision, lf->lfClipPrecision, lf->lfQuality,
                      lf->lfPitchAndFamily, lf->lfFaceName);
}

/* ============================================================ bitmaps */

static HBITMAP bitmap_new(int w, int h, const void *initBits) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    HGDIOBJ o = obj_new(OBJ_BITMAP);
    if (!o) return NULL;
    o->bmW = w;
    o->bmH = h;
    o->bits = (uint32_t *)malloc((size_t)w * h * 4);
    if (!o->bits) { g_objCount--; free(o); return NULL; }
    if (initBits) memcpy(o->bits, initBits, (size_t)w * h * 4);
    else for (int i = 0; i < w * h; i++) o->bits[i] = 0xFF000000u;   /* opaque black */
    return o;
}

HBITMAP CreateBitmap(int w, int h, UINT planes, UINT bpp, const void *bits) {
    if (planes != 1 || (bpp != 32 && bpp != 0)) return NULL;
    return bitmap_new(w, h, bits);
}

HBITMAP CreateCompatibleBitmap(HDC hdc, int w, int h) {
    (void)hdc;
    return bitmap_new(w, h, NULL);
}

/* ============================================================ stock */

static HGDIOBJ g_stock[20];

static HGDIOBJ stock_brush(COLORREF c, int style) {
    HGDIOBJ o = obj_new(OBJ_BRUSH);
    o->brushStyle = style;
    o->color = c;
    o->stock = 1;
    g_objCount--;   /* stock is outside the leak count */
    return o;
}

static HGDIOBJ stock_pen(COLORREF c, int style) {
    HGDIOBJ o = obj_new(OBJ_PEN);
    o->penStyle = style;
    o->penWidth = 1;
    o->color = c;
    o->stock = 1;
    g_objCount--;
    return o;
}

static HGDIOBJ stock_font(void) {
    HGDIOBJ o = obj_new(OBJ_FONT);
    o->fontPx = STOCK_FONT_PX;
    o->stock = 1;
    g_objCount--;
    return o;
}

HGDIOBJ GetStockObject(int which) {
    if (which < 0 || which >= 20) return NULL;
    if (!g_stock[which]) {
        switch (which) {
        case WHITE_BRUSH:  g_stock[which] = stock_brush(RGB(255, 255, 255), BS_SOLID); break;
        case LTGRAY_BRUSH: g_stock[which] = stock_brush(RGB(192, 192, 192), BS_SOLID); break;
        case GRAY_BRUSH:   g_stock[which] = stock_brush(RGB(128, 128, 128), BS_SOLID); break;
        case DKGRAY_BRUSH: g_stock[which] = stock_brush(RGB(64, 64, 64), BS_SOLID); break;
        case BLACK_BRUSH:  g_stock[which] = stock_brush(RGB(0, 0, 0), BS_SOLID); break;
        case NULL_BRUSH:   g_stock[which] = stock_brush(0, BS_NULL); break;
        case WHITE_PEN:    g_stock[which] = stock_pen(RGB(255, 255, 255), PS_SOLID); break;
        case BLACK_PEN:    g_stock[which] = stock_pen(RGB(0, 0, 0), PS_SOLID); break;
        case NULL_PEN:     g_stock[which] = stock_pen(0, PS_NULL); break;
        case SYSTEM_FONT:
        case DEFAULT_GUI_FONT: g_stock[which] = stock_font(); break;
        default: return NULL;
        }
    }
    return g_stock[which];
}

/* ============================================================ select/delete */

HGDIOBJ SelectObject(HDC dc, HGDIOBJ obj) {
    if (!dc || !obj) return NULL;
    HGDIOBJ prev;
    switch (obj->type) {
    case OBJ_PEN:   prev = dc->pen;   dc->pen = obj;   return prev;
    case OBJ_BRUSH: prev = dc->brush; dc->brush = obj; return prev;
    case OBJ_FONT:  prev = dc->font;  dc->font = obj;  return prev;
    case OBJ_BITMAP:
        if (dc->isScreen) return NULL;          /* Windows refuses too */
        prev = dc->bitmap;
        if (prev) prev->selCount--;
        obj->selCount++;
        dc->bitmap = obj;
        dc->bits = obj->bits;
        dc->w = obj->bmW;
        dc->h = obj->bmH;
        dc->stride = obj->bmW;
        SetRect(&dc->clip, 0, 0, dc->w, dc->h);
        return prev;
    default: return NULL;
    }
}

BOOL DeleteObject(HGDIOBJ obj) {
    if (!obj) return FALSE;
    if (obj->stock) return TRUE;                 /* no-op, like Windows */
    if (obj->type == OBJ_BITMAP && obj->selCount > 0) return FALSE;
    if ((obj->type == OBJ_PEN || obj->type == OBJ_BRUSH ||
         obj->type == OBJ_FONT) && obj_selected_somewhere(obj)) {
        /* real DeleteObject refuses while selected into a DC (0211) */
        WIN32_UNSUPPORTED("DeleteObject on a selected pen/brush/font "
                          "(refused — select it out first)");
        return FALSE;
    }
    if (obj->type == OBJ_BITMAP) free(obj->bits);
    if (obj->type == OBJ_FONT) {
        FcCache *fcache = &obj->fontCache;
        for (int i = 0; i < 95; i++) free(fcache->ascii[i].bmp);
        for (int i = 0; i < fcache->xn; i++) free(fcache->xglyphs[i].bmp);
        free(fcache->xglyphs);
        free(fcache->xcps);
        if (obj->face) FT_Done_Face(obj->face);
        for (int i = 0; i < FC_MAX_FALLBACKS; i++)
            if (obj->fbc.state[i] == 1) FT_Done_Face(obj->fbc.face[i]);
    }
    free(obj);
    g_objCount--;
    return TRUE;
}

int GetObject(HGDIOBJ obj, int size, void *out) {
    if (!obj) return 0;
    if (obj->type == OBJ_BITMAP) {
        BITMAP bm;
        bm.bmType = 0;
        bm.bmWidth = obj->bmW;
        bm.bmHeight = obj->bmH;
        bm.bmWidthBytes = obj->bmW * 4;
        bm.bmPlanes = 1;
        bm.bmBitsPixel = 32;
        bm.bmBits = obj->bits;
        if (!out) return (int)sizeof(BITMAP);
        if (size < (int)sizeof(BITMAP)) return 0;
        memcpy(out, &bm, sizeof(BITMAP));
        return (int)sizeof(BITMAP);
    }
    return 0;
}

/* ============================================================ DCs */

static void dc_defaults(HDC dc) {
    dc->pen = GetStockObject(BLACK_PEN);
    dc->brush = GetStockObject(WHITE_BRUSH);
    dc->font = GetStockObject(SYSTEM_FONT);
    dc->textColor = RGB(0, 0, 0);
    dc->bkColor = RGB(255, 255, 255);
    dc->bkMode = OPAQUE;
    dc->rop2 = R2_COPYPEN;
    dc->cur.x = dc->cur.y = 0;
    SetRect(&dc->clip, 0, 0, dc->w, dc->h);
}

/* The user32 seam (0058, win32_internal.h): user32 resolves an HWND to its
 * surface span (client-origin pointer + stride) and wraps it here; GetDC/
 * ReleaseDC/BeginPaint/EndPaint live in user32.c, which also presents. */
HDC __gdi_dc_wrap(void *bits, int w, int h, int stridePx) {
    if (!bits || w < 1 || h < 1 || stridePx < w) return NULL;
    HDC dc = (HDC)calloc(1, sizeof(struct __DC));
    if (!dc) return NULL;
    dc->bits = (uint32_t *)bits;
    dc->w = w;
    dc->h = h;
    dc->stride = stridePx;
    dc->isScreen = 1;
    dc_defaults(dc);
    dc_track(dc);
    g_dcCount++;
    return dc;
}

void __gdi_dc_unwrap(HDC dc) {
    if (!dc || !dc->isScreen) return;
    dc_untrack(dc);
    free(dc);
    g_dcCount--;
}

HDC CreateCompatibleDC(HDC ref) {
    (void)ref;
    HDC dc = (HDC)calloc(1, sizeof(struct __DC));
    if (!dc) return NULL;
    HGDIOBJ def = bitmap_new(1, 1, NULL);        /* Windows: 1x1 default bitmap */
    if (!def) { free(dc); return NULL; }
    g_objCount--;                                /* DC-owned, freed by DeleteDC */
    dc->defBitmap = def;
    dc->bitmap = def;
    def->selCount = 1;
    dc->bits = def->bits;
    dc->w = def->bmW;
    dc->h = def->bmH;
    dc->stride = def->bmW;
    dc_defaults(dc);
    dc_track(dc);
    g_dcCount++;
    return dc;
}

BOOL DeleteDC(HDC dc) {
    if (!dc || dc->isScreen) return FALSE;
    dc_untrack(dc);
    if (dc->bitmap) dc->bitmap->selCount--;
    if (dc->defBitmap) { free(dc->defBitmap->bits); free(dc->defBitmap); }
    free(dc);
    g_dcCount--;
    return TRUE;
}

int GetDeviceCaps(HDC dc, int index) {
    if (!dc) return 0;
    switch (index) {
    case HORZRES:    return dc->w;
    case VERTRES:    return dc->h;
    case BITSPIXEL:  return 32;
    case PLANES:     return 1;
    case NUMCOLORS:  return -1;
    case LOGPIXELSX: return 96;
    case LOGPIXELSY: return 96;
    default:         return 0;
    }
}

/* ============================================================ attributes */

COLORREF SetTextColor(HDC dc, COLORREF c) {
    if (!dc) return CLR_INVALID;
    COLORREF old = dc->textColor;
    dc->textColor = c & 0x00FFFFFFu;
    return old;
}
COLORREF GetTextColor(HDC dc) { return dc ? dc->textColor : CLR_INVALID; }

COLORREF SetBkColor(HDC dc, COLORREF c) {
    if (!dc) return CLR_INVALID;
    COLORREF old = dc->bkColor;
    dc->bkColor = c & 0x00FFFFFFu;
    return old;
}
COLORREF GetBkColor(HDC dc) { return dc ? dc->bkColor : CLR_INVALID; }

int SetBkMode(HDC dc, int mode) {
    if (!dc || (mode != TRANSPARENT && mode != OPAQUE)) return 0;
    int old = dc->bkMode;
    dc->bkMode = mode;
    return old;
}
int GetBkMode(HDC dc) { return dc ? dc->bkMode : 0; }

int SetROP2(HDC dc, int rop2) {
    if (!dc || rop2 < R2_BLACK || rop2 > R2_WHITE) return 0;
    int old = dc->rop2;
    dc->rop2 = rop2;
    return old;
}
int GetROP2(HDC dc) { return dc ? dc->rop2 : 0; }

/* ============================================================ clipping */

int IntersectClipRect(HDC dc, int l, int t, int r, int b) {
    if (!dc) return ERROR;
    RECT n;
    SetRect(&n, l, t, r, b);
    if (!IntersectRect(&dc->clip, &dc->clip, &n)) SetRectEmpty(&dc->clip);
    return IsRectEmpty(&dc->clip) ? NULLREGION : SIMPLEREGION;
}

int SelectClipRgn(HDC dc, HRGN rgn) {
    if (!dc) return ERROR;
    if (rgn) return ERROR;                       /* real regions: not in 0057 */
    SetRect(&dc->clip, 0, 0, dc->w, dc->h);
    return SIMPLEREGION;
}

int GetClipBox(HDC dc, RECT *r) {
    if (!dc || !r) return ERROR;
    *r = dc->clip;
    return IsRectEmpty(&dc->clip) ? NULLREGION : SIMPLEREGION;
}

/* ============================================================ raster core */

static int in_clip(HDC dc, int x, int y) {
    return x >= dc->clip.left && x < dc->clip.right &&
           y >= dc->clip.top && y < dc->clip.bottom &&
           x >= 0 && x < dc->w && y >= 0 && y < dc->h;
}

/* All 16 binary raster ops, on the 24 color bits; alpha forced opaque. */
static uint32_t rop2_mix(int rop2, uint32_t pen, uint32_t dst) {
    uint32_t P = pen & 0x00FFFFFFu, D = dst & 0x00FFFFFFu, v;
    switch (rop2) {
    case R2_BLACK:       v = 0; break;
    case R2_NOTMERGEPEN: v = ~(P | D); break;
    case R2_MASKNOTPEN:  v = ~P & D; break;
    case R2_NOTCOPYPEN:  v = ~P; break;
    case R2_MASKPENNOT:  v = P & ~D; break;
    case R2_NOT:         v = ~D; break;
    case R2_XORPEN:      v = P ^ D; break;
    case R2_NOTMASKPEN:  v = ~(P & D); break;
    case R2_MASKPEN:     v = P & D; break;
    case R2_NOTXORPEN:   v = ~(P ^ D); break;
    case R2_NOP:         v = D; break;
    case R2_MERGENOTPEN: v = ~P | D; break;
    case R2_COPYPEN:     v = P; break;
    case R2_MERGEPENNOT: v = P | ~D; break;
    case R2_MERGEPEN:    v = P | D; break;
    case R2_WHITE:       v = 0x00FFFFFFu; break;
    default:             v = P; break;
    }
    return (v & 0x00FFFFFFu) | 0xFF000000u;
}

static void put_rop2(HDC dc, int x, int y, uint32_t pen) {
    if (!in_clip(dc, x, y)) return;
    uint32_t *p = &dc->bits[y * dc->stride + x];
    *p = rop2_mix(dc->rop2, pen, *p);
}

/* Brush color at (x,y): 0 = leave the pixel (transparent hatch gap). */
static int brush_at(HDC dc, HGDIOBJ br, int x, int y, uint32_t *out) {
    if (!br || br->type != OBJ_BRUSH || br->brushStyle == BS_NULL) return 0;
    if (br->brushStyle == BS_HATCHED) {
        int on;
        switch (br->hatch) {
        case HS_HORIZONTAL: on = (y & 7) == 0; break;
        case HS_VERTICAL:   on = (x & 7) == 0; break;
        case HS_FDIAGONAL:  on = ((x + y) & 7) == 0; break;
        case HS_BDIAGONAL:  on = ((x - y) & 7) == 0; break;
        case HS_CROSS:      on = ((x & 7) == 0) || ((y & 7) == 0); break;
        case HS_DIAGCROSS:  on = (((x + y) & 7) == 0) || (((x - y) & 7) == 0); break;
        default:            on = 1; break;
        }
        if (!on) {
            if (dc->bkMode == OPAQUE) { *out = px_of(dc->bkColor); return 1; }
            return 0;
        }
    }
    *out = px_of(br->color);
    return 1;
}

/* Fill [l,r) x [t,b) with a brush. useRop2: shapes mix via SetROP2;
 * FillRect/PatBlt(PATCOPY) copy directly. */
static void fill_with_brush(HDC dc, int l, int t, int r, int b,
                            HGDIOBJ br, int useRop2) {
    if (!br || br->brushStyle == BS_NULL) return;
    for (int y = t; y < b; y++) {
        for (int x = l; x < r; x++) {
            uint32_t c;
            if (!brush_at(dc, br, x, y, &c)) continue;
            if (!in_clip(dc, x, y)) continue;
            uint32_t *p = &dc->bits[y * dc->stride + x];
            *p = useRop2 ? rop2_mix(dc->rop2, c, *p) : c;
        }
    }
}

/* ============================================================ pixels */

COLORREF SetPixel(HDC dc, int x, int y, COLORREF c) {
    if (!dc || !in_clip(dc, x, y)) return CLR_INVALID;
    dc->bits[y * dc->stride + x] = px_of(c);
    return c & 0x00FFFFFFu;
}

BOOL SetPixelV(HDC dc, int x, int y, COLORREF c) {
    return SetPixel(dc, x, y, c) != CLR_INVALID;
}

COLORREF GetPixel(HDC dc, int x, int y) {
    if (!dc || x < 0 || y < 0 || x >= dc->w || y >= dc->h) return CLR_INVALID;
    if (x < dc->clip.left || x >= dc->clip.right ||
        y < dc->clip.top || y >= dc->clip.bottom) return CLR_INVALID;
    return cr_of(dc->bits[y * dc->stride + x]);
}

/* ============================================================ lines */

/* Square nib centered on the path point (0057 pen model). */
static void pen_dot(HDC dc, int x, int y, uint32_t c, int w) {
    if (w <= 1) { put_rop2(dc, x, y, c); return; }
    int o = (w - 1) / 2;
    for (int dy = 0; dy < w; dy++)
        for (int dx = 0; dx < w; dx++)
            put_rop2(dc, x - o + dx, y - o + dy, c);
}

/* Bresenham, GDI convention: the final point is NOT drawn (LineTo). */
static void draw_line(HDC dc, int x0, int y0, int x1, int y1, int excludeEnd) {
    HGDIOBJ pen = dc->pen;
    if (!pen || pen->type != OBJ_PEN || pen->penStyle == PS_NULL) return;
    uint32_t c = px_of(pen->color);
    int w = pen->penWidth;
    int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        if (x0 == x1 && y0 == y1) {
            if (!excludeEnd) pen_dot(dc, x0, y0, c, w);
            break;
        }
        pen_dot(dc, x0, y0, c, w);
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

BOOL MoveToEx(HDC dc, int x, int y, POINT *old) {
    if (!dc) return FALSE;
    if (old) *old = dc->cur;
    dc->cur.x = x;
    dc->cur.y = y;
    return TRUE;
}

BOOL LineTo(HDC dc, int x, int y) {
    if (!dc) return FALSE;
    draw_line(dc, dc->cur.x, dc->cur.y, x, y, 1);
    dc->cur.x = x;
    dc->cur.y = y;
    return TRUE;
}

BOOL Polyline(HDC dc, const POINT *pts, int n) {
    if (!dc || !pts || n < 2) return FALSE;
    for (int i = 0; i < n - 1; i++)
        draw_line(dc, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y,
                  i < n - 2 ? 1 : 0);   /* last segment keeps its endpoint */
    return TRUE;
}

/* ============================================================ shapes */

/* Convex-ish per-row span shapes (ellipse, roundrect): fill the interior
 * with the brush, band the boundary with the pen — the boundary at row y
 * is span(y) minus the intersection of span(y-1) and span(y+1). */
typedef int (*SpanFn)(void *ctx, int y, int *x0, int *x1);

static void draw_span_shape(HDC dc, int t, int b, SpanFn fn, void *ctx) {
    HGDIOBJ pen = dc->pen, br = dc->brush;
    int penOn = pen && pen->type == OBJ_PEN && pen->penStyle != PS_NULL;
    uint32_t pc = penOn ? px_of(pen->color) : 0;
    for (int y = t; y < b; y++) {
        int s0, s1;
        if (!fn(ctx, y, &s0, &s1)) continue;
        int i0 = s0, i1 = s1, hasInterior = 0;
        if (penOn) {
            int p0, p1, n0, n1;
            if (y > t && fn(ctx, y - 1, &p0, &p1) &&
                y + 1 < b && fn(ctx, y + 1, &n0, &n1)) {
                i0 = p0 > n0 ? p0 : n0;
                i1 = p1 < n1 ? p1 : n1;
                if (i0 < s0) i0 = s0;
                if (i1 > s1) i1 = s1;
                hasInterior = i0 <= i1;
            }
        } else {
            hasInterior = 1;   /* no pen: brush takes the whole span */
        }
        if (hasInterior) fill_with_brush(dc, i0, y, i1 + 1, y + 1, br, 1);
        if (penOn) {
            if (!hasInterior) {
                for (int x = s0; x <= s1; x++) put_rop2(dc, x, y, pc);
            } else {
                for (int x = s0; x < i0; x++) put_rop2(dc, x, y, pc);
                for (int x = i1 + 1; x <= s1; x++) put_rop2(dc, x, y, pc);
            }
        }
    }
}

static void norm2(int *a, int *b) { if (*a > *b) { int t = *a; *a = *b; *b = t; } }

BOOL Rectangle(HDC dc, int l, int t, int r, int b) {
    if (!dc) return FALSE;
    norm2(&l, &r);
    norm2(&t, &b);
    if (r - l < 1 || b - t < 1) return TRUE;
    fill_with_brush(dc, l, t, r, b, dc->brush, 1);
    /* Perimeter of [l, r-1] x [t, b-1]; each edge excludes its endpoint so
     * corners land exactly once. */
    draw_line(dc, l, t, r - 1, t, 1);
    draw_line(dc, r - 1, t, r - 1, b - 1, 1);
    draw_line(dc, r - 1, b - 1, l, b - 1, 1);
    draw_line(dc, l, b - 1, l, t, 1);
    return TRUE;
}

typedef struct { double cx, cy, a, b; } EllipseCtx;

static int ellipse_span(void *vctx, int y, int *x0, int *x1) {
    EllipseCtx *c = (EllipseCtx *)vctx;
    double dy = (y + 0.5) - c->cy;
    double v = 1.0 - (dy * dy) / (c->b * c->b);
    if (v <= 0.0) return 0;
    double half = c->a * sqrt(v);
    *x0 = (int)ceil(c->cx - half - 0.5);
    *x1 = (int)floor(c->cx + half - 0.5);
    return *x1 >= *x0;
}

BOOL Ellipse(HDC dc, int l, int t, int r, int b) {
    if (!dc) return FALSE;
    norm2(&l, &r);
    norm2(&t, &b);
    if (r - l < 1 || b - t < 1) return TRUE;
    EllipseCtx c;
    c.a = (r - l) / 2.0;
    c.b = (b - t) / 2.0;
    c.cx = l + c.a;
    c.cy = t + c.b;
    draw_span_shape(dc, t, b, ellipse_span, &c);
    return TRUE;
}

typedef struct { int l, t, r, b; double a, b_; } RoundCtx;

static int round_span(void *vctx, int y, int *x0, int *x1) {
    RoundCtx *c = (RoundCtx *)vctx;
    if (y < c->t || y >= c->b) return 0;
    double yc = y + 0.5, dy = 0.0;
    if (yc < c->t + c->b_) dy = (c->t + c->b_) - yc;
    else if (yc > c->b - c->b_) dy = yc - (c->b - c->b_);
    double inset = 0.0;
    if (dy > 0.0) {
        double v = 1.0 - (dy * dy) / (c->b_ * c->b_);
        if (v <= 0.0) return 0;
        inset = c->a - c->a * sqrt(v);
    }
    *x0 = (int)ceil(c->l + inset - 0.5);
    *x1 = (int)floor(c->r - inset - 0.5);
    if (*x0 < c->l) *x0 = c->l;
    if (*x1 > c->r - 1) *x1 = c->r - 1;
    return *x1 >= *x0;
}

BOOL RoundRect(HDC dc, int l, int t, int r, int b, int ew, int eh) {
    if (!dc) return FALSE;
    norm2(&l, &r);
    norm2(&t, &b);
    if (r - l < 1 || b - t < 1) return TRUE;
    if (ew < 0) ew = 0;
    if (eh < 0) eh = 0;
    if (ew > r - l) ew = r - l;
    if (eh > b - t) eh = b - t;
    if (ew == 0 || eh == 0) return Rectangle(dc, l, t, r, b);
    RoundCtx c;
    c.l = l; c.t = t; c.r = r; c.b = b;
    c.a = ew / 2.0;
    c.b_ = eh / 2.0;
    draw_span_shape(dc, t, b, round_span, &c);
    return TRUE;
}

BOOL Polygon(HDC dc, const POINT *pts, int n) {
    if (!dc || !pts || n < 2) return FALSE;
    /* Even-odd scanline fill through pixel-row centers. */
    int minY = pts[0].y, maxY = pts[0].y;
    for (int i = 1; i < n; i++) {
        if (pts[i].y < minY) minY = pts[i].y;
        if (pts[i].y > maxY) maxY = pts[i].y;
    }
    double *xs = (double *)malloc((size_t)n * sizeof(double));
    if (!xs) return FALSE;
    for (int y = minY; y < maxY; y++) {
        double yc = y + 0.5;
        int nx = 0;
        for (int i = 0; i < n; i++) {
            POINT p1 = pts[i], p2 = pts[(i + 1) % n];
            if (p1.y == p2.y) continue;
            double lo = p1.y < p2.y ? p1.y : p2.y;
            double hi = p1.y < p2.y ? p2.y : p1.y;
            if (yc < lo || yc >= hi) continue;
            xs[nx++] = p1.x + (yc - p1.y) * (double)(p2.x - p1.x) / (double)(p2.y - p1.y);
        }
        /* insertion sort (nx is tiny) */
        for (int i = 1; i < nx; i++) {
            double v = xs[i];
            int j = i - 1;
            while (j >= 0 && xs[j] > v) { xs[j + 1] = xs[j]; j--; }
            xs[j + 1] = v;
        }
        for (int i = 0; i + 1 < nx; i += 2) {
            int x0 = (int)ceil(xs[i] - 0.5);
            int x1 = (int)floor(xs[i + 1] - 0.5);
            if (x1 >= x0) fill_with_brush(dc, x0, y, x1 + 1, y + 1, dc->brush, 1);
        }
    }
    free(xs);
    /* Outline: every vertex is drawn exactly once (endpoints excluded). */
    for (int i = 0; i < n; i++) {
        POINT p1 = pts[i], p2 = pts[(i + 1) % n];
        draw_line(dc, p1.x, p1.y, p2.x, p2.y, 1);
    }
    return TRUE;
}

int FillRect(HDC dc, const RECT *r, HBRUSH brush) {
    if (!dc || !r || !brush) return 0;
    fill_with_brush(dc, r->left, r->top, r->right, r->bottom, brush, 0);
    return 1;
}

int FrameRect(HDC dc, const RECT *r, HBRUSH brush) {
    if (!dc || !r || !brush) return 0;
    fill_with_brush(dc, r->left, r->top, r->right, r->top + 1, brush, 0);
    fill_with_brush(dc, r->left, r->bottom - 1, r->right, r->bottom, brush, 0);
    fill_with_brush(dc, r->left, r->top, r->left + 1, r->bottom, brush, 0);
    fill_with_brush(dc, r->right - 1, r->top, r->right, r->bottom, brush, 0);
    return 1;
}

BOOL InvertRect(HDC dc, const RECT *r) {
    if (!dc || !r) return FALSE;
    for (int y = r->top; y < r->bottom; y++)
        for (int x = r->left; x < r->right; x++) {
            if (!in_clip(dc, x, y)) continue;
            uint32_t *p = &dc->bits[y * dc->stride + x];
            *p = (~*p & 0x00FFFFFFu) | 0xFF000000u;
        }
    return TRUE;
}

/* ============================================================ text */

static HGDIOBJ dc_font(HDC dc) {
    HGDIOBJ f = dc->font ? dc->font : GetStockObject(SYSTEM_FONT);
    return (f && font_ensure(f) == 0) ? f : NULL;
}

/* Draw one run at (x, y-top-of-cell). extraClip further restricts glyphs
 * (ETO_CLIPPED / DrawText). dx: per-CODE-POINT advance overrides. The
 * byte string decodes as UTF-8 (0211). */
static BOOL text_run(HDC dc, int x, int y, LPCSTR s, int len, const INT *dx,
                     const RECT *extraClip) {
    HGDIOBJ f = dc_font(dc);
    if (!f) return FALSE;
    int cellH = f->ascent + f->descent;
    if (dc->bkMode == OPAQUE) {
        int w = 0;
        for (int i = 0, n = 0; i < len; n++) {
            unsigned cp = __u8_next(s, len, &i);
            w += dx ? dx[n] : font_glyph(f, cp)->advance;
        }
        uint32_t bk = px_of(dc->bkColor);
        int r = x + w, b = y + cellH;
        for (int yy = y; yy < b; yy++)
            for (int xx = x; xx < r; xx++) {
                if (!in_clip(dc, xx, yy)) continue;
                if (extraClip && (xx < extraClip->left || xx >= extraClip->right ||
                                  yy < extraClip->top || yy >= extraClip->bottom)) continue;
                dc->bits[yy * dc->stride + xx] = bk;
            }
    }
    int fr = GetRValue(dc->textColor), fg = GetGValue(dc->textColor),
        fb = GetBValue(dc->textColor);
    int penX = x, baseline = y + f->ascent;
    for (int i = 0, n = 0; i < len; n++) {
        unsigned cp = __u8_next(s, len, &i);
        FcGlyph *g = font_glyph(f, cp);
        if (g->bmp) {
            int gx0 = penX + g->left, gy0 = baseline - g->top;
            for (int gy = 0; gy < g->h; gy++) {
                int yy = gy0 + gy;
                for (int gx = 0; gx < g->w; gx++) {
                    int xx = gx0 + gx;
                    unsigned a = g->bmp[gy * g->w + gx];
                    if (!a) continue;
                    if (!in_clip(dc, xx, yy)) continue;
                    if (extraClip && (xx < extraClip->left || xx >= extraClip->right ||
                                      yy < extraClip->top || yy >= extraClip->bottom)) continue;
                    uint32_t *p = &dc->bits[yy * dc->stride + xx];
                    int br = (int)(*p & 0xFF), bg = (int)((*p >> 8) & 0xFF),
                        bb = (int)((*p >> 16) & 0xFF);
                    /* SIGNED blend: the old (unsigned)(fr - br) wrapped a
                     * negative delta, so full-coverage dark-on-light text
                     * landed at fr+1 per channel ((1,1,1) "black"). */
                    int rr = br + (int)a * (fr - br) / 255;
                    int gg = bg + (int)a * (fg - bg) / 255;
                    int bv = bb + (int)a * (fb - bb) / 255;
                    *p = (uint32_t)rr | ((uint32_t)gg << 8) | ((uint32_t)bv << 16) |
                         0xFF000000u;
                }
            }
        }
        penX += dx ? dx[n] : g->advance;
    }
    return TRUE;
}

BOOL TextOut(HDC dc, int x, int y, LPCSTR str, int len) {
    if (!dc || !str || len < 0) return FALSE;
    return text_run(dc, x, y, str, len, NULL, NULL);
}

BOOL ExtTextOut(HDC dc, int x, int y, UINT options, const RECT *r,
                LPCSTR str, UINT len, const INT *dx) {
    if (!dc) return FALSE;
    if ((options & ETO_OPAQUE) && r) {
        uint32_t bk = px_of(dc->bkColor);
        for (int yy = r->top; yy < r->bottom; yy++)
            for (int xx = r->left; xx < r->right; xx++) {
                if (!in_clip(dc, xx, yy)) continue;
                dc->bits[yy * dc->stride + xx] = bk;
            }
    }
    if (!str || len == 0) return TRUE;
    return text_run(dc, x, y, str, (int)len, dx,
                    (options & ETO_CLIPPED) && r ? r : NULL);
}

BOOL GetTextExtentPoint32(HDC dc, LPCSTR str, int len, SIZE *size) {
    if (!dc || !str || len < 0 || !size) return FALSE;
    HGDIOBJ f = dc_font(dc);
    if (!f) return FALSE;
    int w = 0;
    for (int i = 0; i < len; )
        w += font_glyph(f, __u8_next(str, len, &i))->advance;
    size->cx = w;
    size->cy = f->ascent + f->descent;
    return TRUE;
}

BOOL GetTextMetrics(HDC dc, TEXTMETRIC *tm) {
    if (!dc || !tm) return FALSE;
    HGDIOBJ f = dc_font(dc);
    if (!f) return FALSE;
    memset(tm, 0, sizeof(*tm));
    tm->tmHeight = f->ascent + f->descent;
    tm->tmAscent = f->ascent;
    tm->tmDescent = f->descent;
    tm->tmInternalLeading = tm->tmHeight - f->fontPx;
    if (tm->tmInternalLeading < 0) tm->tmInternalLeading = 0;
    tm->tmExternalLeading = f->lineH - tm->tmHeight;
    if (tm->tmExternalLeading < 0) tm->tmExternalLeading = 0;
    tm->tmAveCharWidth = font_glyph(f, 'x')->advance;
    tm->tmMaxCharWidth = f->maxAdv;
    tm->tmWeight = FW_NORMAL;
    tm->tmFirstChar = 32;
    tm->tmLastChar = 126;
    tm->tmDefaultChar = '?';
    tm->tmBreakChar = ' ';
    /* TEXTMETRIC's TMPF_FIXED_PITCH bit is famously INVERTED: a fixed
     * (mono) font reports the bit CLEAR (0211 audit D11). The old
     * FIXED_PITCH here was the LOGFONT-sense constant — wrong side. */
    tm->tmPitchAndFamily = 0;
    return TRUE;
}

/* DrawText: '\n' splits lines; DT_WORDBREAK wraps at spaces; alignment
 * per DT_* flags; DT_CALCRECT measures without drawing. Line pitch is
 * tmHeight (ascent+descent), like Windows. '&' prefixes strip and
 * underline the next code point unless DT_NOPREFIX (0211 audit D12). */
#define DT_MAX_LINES 128

/* Strip '&' prefixes ("&&" = literal '&'); *ulPos/*ulLen mark the
 * underlined code point in the OUTPUT (byte pos/len; -1 = none). */
static int dt_strip(const char *s, int len, char *out, int cap,
                    int *ulPos, int *ulLen) {
    int o = 0;
    *ulPos = -1;
    *ulLen = 0;
    for (int i = 0; i < len && o < cap - 1; i++) {
        if (s[i] == '&') {
            if (i + 1 < len && s[i + 1] == '&') { out[o++] = '&'; i++; }
            else if (i + 1 < len && *ulPos < 0) {
                int k = i + 1;
                __u8_next(s, len, &k);           /* one code point */
                *ulPos = o;
                *ulLen = k - (i + 1);
            }
            continue;                            /* drop the '&' itself */
        }
        out[o++] = s[i];
    }
    out[o] = 0;
    return o;
}

/* Effective text of one DrawText line: strips prefixes into buf when
 * needed. Returns the length; *txt points at the bytes to draw. */
static int dt_line(const char *s, int len, UINT format, char *buf, int cap,
                   const char **txt, int *ulPos, int *ulLen) {
    *ulPos = -1;
    *ulLen = 0;
    if ((format & DT_NOPREFIX) || !memchr(s, '&', (size_t)len)) {
        *txt = s;
        return len;
    }
    *txt = buf;
    return dt_strip(s, len, buf, cap, ulPos, ulLen);
}

int DrawText(HDC dc, LPCSTR str, int len, RECT *r, UINT format) {
    if (!dc || !str || !r) return 0;
    HGDIOBJ f = dc_font(dc);
    if (!f) return 0;
    if (len < 0) len = (int)strlen(str);
    int lineH = f->ascent + f->descent;
    int rectW = r->right - r->left;

    const char *ls[DT_MAX_LINES];
    int ll[DT_MAX_LINES], nl = 0;
    if (format & DT_SINGLELINE) {
        ls[0] = str;
        ll[0] = len;
        nl = 1;
    } else {
        int i = 0;
        while (i <= len && nl < DT_MAX_LINES) {
            int start = i;
            while (i < len && str[i] != '\n') i++;
            int end = i;                              /* [start, end) */
            if (end > start && str[end - 1] == '\r') end--;
            if (format & DT_WORDBREAK) {
                int s = start;
                while (s < end && nl < DT_MAX_LINES) {
                    int w = 0, lastSp = -1, e = s;
                    while (e < end) {
                        int ne = e;
                        unsigned cp = __u8_next(str, end, &ne);
                        int adv = font_glyph(f, cp)->advance;
                        if (w + adv > rectW && e > s) break;
                        w += adv;
                        if (cp == ' ') lastSp = e;
                        e = ne;
                    }
                    int cut = (e < end && lastSp > s) ? lastSp : e;
                    ls[nl] = &str[s];
                    ll[nl] = cut - s;
                    nl++;
                    s = cut;
                    while (s < end && str[s] == ' ') s++;
                }
            } else {
                ls[nl] = &str[start];
                ll[nl] = end - start;
                nl++;
            }
            i++;                                       /* skip the '\n' */
            if (i > len) break;
        }
        if (nl == 0) { ls[0] = str; ll[0] = 0; nl = 1; }
    }

    char sbuf[256];                              /* one shared strip buffer */
    const char *txt;
    int ulPos, ulLen;

    int maxW = 0;
    for (int i = 0; i < nl; i++) {
        int tl = dt_line(ls[i], ll[i], format, sbuf, sizeof sbuf,
                         &txt, &ulPos, &ulLen);
        int w = 0;
        for (int j = 0; j < tl; )
            w += font_glyph(f, __u8_next(txt, tl, &j))->advance;
        if (w > maxW) maxW = w;
    }
    int totalH = nl * lineH;

    if (format & DT_CALCRECT) {
        if (!(format & DT_WORDBREAK)) r->right = r->left + maxW;
        r->bottom = r->top + totalH;
        return totalH;
    }

    int y;
    if (format & DT_VCENTER) {
        /* FLOOR the centering (0236): when the text is taller than the
         * rect the spare space is negative, and C truncation would keep
         * the cell flush-top — clipping the descender row at the bottom
         * while the blank leading row at the cell top survives. Floor
         * biases the loss upward. Positive space is unaffected. */
        int space = r->bottom - r->top - totalH;
        y = r->top + (space >> 1);
    }
    else if (format & DT_BOTTOM) y = r->bottom - totalH;
    else y = r->top;

    for (int i = 0; i < nl; i++) {
        int tl = dt_line(ls[i], ll[i], format, sbuf, sizeof sbuf,
                         &txt, &ulPos, &ulLen);
        int w = 0;
        for (int j = 0; j < tl; )
            w += font_glyph(f, __u8_next(txt, tl, &j))->advance;
        int x;
        if (format & DT_CENTER) x = r->left + (rectW - w) / 2;
        else if (format & DT_RIGHT) x = r->right - w;
        else x = r->left;
        text_run(dc, x, y, txt, tl, NULL,
                 (format & DT_NOCLIP) ? NULL : r);
        if (ulPos >= 0) {                        /* mnemonic underline */
            int wb = 0, j = 0;
            while (j < ulPos)
                wb += font_glyph(f, __u8_next(txt, ulPos, &j))->advance;
            int wc = 0;
            j = ulPos;
            while (j < ulPos + ulLen)
                wc += font_glyph(f, __u8_next(txt, ulPos + ulLen, &j))->advance;
            int uy = y + f->ascent + 1;
            uint32_t px = px_of(dc->textColor);
            for (int xx = x + wb; xx < x + wb + wc; xx++) {
                if (!in_clip(dc, xx, uy)) continue;
                if (!(format & DT_NOCLIP) &&
                    (xx < r->left || xx >= r->right || uy < r->top ||
                     uy >= r->bottom)) continue;
                dc->bits[uy * dc->stride + xx] = px;
            }
        }
        y += lineH;
    }
    return totalH;
}

/* ============================================================ blits */

static int rop_needs_src(DWORD rop) {
    switch (rop) {
    case SRCCOPY: case SRCPAINT: case SRCAND: case SRCINVERT:
    case SRCERASE: case NOTSRCCOPY: case NOTSRCERASE: case MERGEPAINT:
        return 1;
    default:
        return 0;
    }
}

/* The implemented ROP3 subset — exactly rop3_mix's cases. An unknown rop
 * used to fall through as "copy S", and for a rop rop_needs_src didn't
 * know, S was never fetched: the blit SILENTLY PAINTED BLACK (0211 audit
 * D1). Now it refuses loudly instead of destroying pixels. */
static int rop_known(DWORD rop) {
    switch (rop) {
    case SRCCOPY: case SRCPAINT: case SRCAND: case SRCINVERT:
    case SRCERASE: case NOTSRCCOPY: case NOTSRCERASE: case MERGEPAINT:
    case PATCOPY: case PATINVERT: case DSTINVERT: case BLACKNESS:
    case WHITENESS:
        return 1;
    default:
        WIN32_UNSUPPORTED("ROP3 0x%08X (blit refused)", (unsigned)rop);
        return 0;
    }
}

static uint32_t rop3_mix(DWORD rop, uint32_t src, uint32_t dst, uint32_t pat) {
    uint32_t S = src & 0x00FFFFFFu, D = dst & 0x00FFFFFFu, P = pat & 0x00FFFFFFu, v;
    switch (rop) {
    case SRCCOPY:     v = S; break;
    case SRCPAINT:    v = S | D; break;
    case SRCAND:      v = S & D; break;
    case SRCINVERT:   v = S ^ D; break;
    case SRCERASE:    v = S & ~D; break;
    case NOTSRCCOPY:  v = ~S; break;
    case NOTSRCERASE: v = ~(S | D); break;
    case MERGEPAINT:  v = ~S | D; break;
    case PATCOPY:     v = P; break;
    case PATINVERT:   v = P ^ D; break;
    case DSTINVERT:   v = ~D; break;
    case BLACKNESS:   v = 0; break;
    case WHITENESS:   v = 0x00FFFFFFu; break;
    default:          v = S; break;
    }
    return (v & 0x00FFFFFFu) | 0xFF000000u;
}

BOOL BitBlt(HDC dst, int x, int y, int w, int h, HDC src, int sx, int sy, DWORD rop) {
    if (!dst || w <= 0 || h <= 0 || !rop_known(rop)) return FALSE;
    int needSrc = rop_needs_src(rop);
    if (needSrc && !src) return FALSE;

    /* Overlapping same-buffer blit: stage the source region. A=0 marks
     * out-of-source pixels (ours are always A=0xFF): real GDI leaves the
     * dest untouched there instead of fabricating black (0211 audit D2). */
    uint32_t *staged = NULL;
    int stagedW = 0;
    if (needSrc && src->bits == dst->bits) {
        staged = (uint32_t *)malloc((size_t)w * h * 4);
        if (!staged) return FALSE;
        stagedW = w;
        for (int row = 0; row < h; row++)
            for (int col = 0; col < w; col++) {
                int xx = sx + col, yy = sy + row;
                staged[row * w + col] =
                    (xx >= 0 && xx < src->w && yy >= 0 && yy < src->h)
                        ? src->bits[yy * src->stride + xx] : 0u;
            }
    }

    for (int row = 0; row < h; row++) {
        int dy2 = y + row;
        for (int col = 0; col < w; col++) {
            int dx2 = x + col;
            if (!in_clip(dst, dx2, dy2)) continue;
            uint32_t S = 0xFF000000u;
            if (needSrc) {
                if (staged) {
                    S = staged[row * stagedW + col];
                    if ((S & 0xFF000000u) == 0) continue;    /* no source */
                } else {
                    int xx = sx + col, yy = sy + row;
                    if (xx < 0 || xx >= src->w || yy < 0 || yy >= src->h)
                        continue;                            /* no source */
                    S = src->bits[yy * src->stride + xx];
                }
            }
            uint32_t P = 0xFF000000u;
            if (rop == PATCOPY || rop == PATINVERT) {
                if (!brush_at(dst, dst->brush, dx2, dy2, &P)) continue;
            }
            uint32_t *p = &dst->bits[dy2 * dst->stride + dx2];
            *p = rop3_mix(rop, S, *p, P);
        }
    }
    free(staged);
    return TRUE;
}

BOOL StretchBlt(HDC dst, int x, int y, int w, int h,
                HDC src, int sx, int sy, int sw, int sh, DWORD rop) {
    if (!dst || !rop_known(rop)) return FALSE;
    if (w <= 0 || h <= 0 || sw <= 0 || sh <= 0) {
        /* real GDI mirrors on negative extents — not grown yet (0211) */
        WIN32_UNSUPPORTED("StretchBlt non-positive extents (mirroring)");
        return FALSE;
    }
    int needSrc = rop_needs_src(rop);
    if (needSrc && !src) return FALSE;
    if (needSrc && src->bits == dst->bits) {
        WIN32_UNSUPPORTED("StretchBlt within one surface");
        return FALSE;
    }
    for (int row = 0; row < h; row++) {
        int dy2 = y + row;
        int syy = sy + (int)(((long long)row * sh) / h);
        for (int col = 0; col < w; col++) {
            int dx2 = x + col;
            if (!in_clip(dst, dx2, dy2)) continue;
            uint32_t S = 0xFF000000u;
            if (needSrc) {
                int sxx = sx + (int)(((long long)col * sw) / w);
                if (sxx < 0 || sxx >= src->w || syy < 0 || syy >= src->h)
                    continue;                                /* no source */
                S = src->bits[syy * src->stride + sxx];
            }
            uint32_t P = 0xFF000000u;
            if (rop == PATCOPY || rop == PATINVERT) {
                if (!brush_at(dst, dst->brush, dx2, dy2, &P)) continue;
            }
            uint32_t *p = &dst->bits[dy2 * dst->stride + dx2];
            *p = rop3_mix(rop, S, *p, P);
        }
    }
    return TRUE;
}

BOOL PatBlt(HDC dc, int x, int y, int w, int h, DWORD rop) {
    if (!dc) return FALSE;
    if (w < 0) { x += w; w = -w; }               /* negative extents are */
    if (h < 0) { y += h; h = -h; }               /*   legal: extend left/up */
    if (w == 0 || h == 0) return FALSE;
    switch (rop) {
    case PATCOPY: case PATINVERT: case DSTINVERT: case BLACKNESS: case WHITENESS:
        return BitBlt(dc, x, y, w, h, NULL, 0, 0, rop);
    default:
        WIN32_UNSUPPORTED("PatBlt rop 0x%08X", (unsigned)rop);
        return FALSE;
    }
}

/* ============================================================ DIBs */

/* 32bpp BI_RGB only. DIB pixels are B,G,R,X bytes; ours are R,G,B,A —
 * swizzle both ways. biHeight > 0 = bottom-up (DIB row 0 is the bottom). */

static int dib_check(const BITMAPINFO *bmi) {
    return bmi && bmi->bmiHeader.biBitCount == 32 &&
           bmi->bmiHeader.biCompression == BI_RGB &&
           bmi->bmiHeader.biPlanes == 1;
}

int GetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT lines, void *bits,
              BITMAPINFO *bmi, UINT usage) {
    (void)hdc; (void)usage;
    if (!hbm || hbm->type != OBJ_BITMAP || !bmi) return 0;
    if (!bits) {   /* query: describe the bitmap */
        memset(&bmi->bmiHeader, 0, sizeof(BITMAPINFOHEADER));
        bmi->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi->bmiHeader.biWidth = hbm->bmW;
        bmi->bmiHeader.biHeight = hbm->bmH;
        bmi->bmiHeader.biPlanes = 1;
        bmi->bmiHeader.biBitCount = 32;
        bmi->bmiHeader.biCompression = BI_RGB;
        bmi->bmiHeader.biSizeImage = (DWORD)(hbm->bmW * 4) * (DWORD)hbm->bmH;
        return hbm->bmH;
    }
    if (!dib_check(bmi)) return 0;
    int topDown = bmi->bmiHeader.biHeight < 0;
    int h = hbm->bmH, w = hbm->bmW;
    /* The DIB's row stride is biWidth, NOT the bitmap width (0211 audit
     * D15) — a mismatched caller got skewed rows / a buffer over-read. */
    int stride = bmi->bmiHeader.biWidth > 0 ? bmi->bmiHeader.biWidth : w;
    int cw = w < stride ? w : stride;
    uint32_t *out = (uint32_t *)bits;
    int done = 0;
    for (UINT i = 0; i < lines; i++) {
        int dibRow = (int)(start + i);
        if (dibRow >= h) break;
        int bmRow = topDown ? dibRow : h - 1 - dibRow;
        for (int xcol = 0; xcol < cw; xcol++) {
            uint32_t px = hbm->bits[bmRow * w + xcol];
            uint32_t r = px & 0xFF, g = (px >> 8) & 0xFF, b = (px >> 16) & 0xFF;
            out[i * (UINT)stride + (UINT)xcol] = b | (g << 8) | (r << 16);
        }
        done++;
    }
    return done;
}

int SetDIBits(HDC hdc, HBITMAP hbm, UINT start, UINT lines, const void *bits,
              const BITMAPINFO *bmi, UINT usage) {
    (void)hdc; (void)usage;
    if (!hbm || hbm->type != OBJ_BITMAP || !bits || !dib_check(bmi)) return 0;
    int topDown = bmi->bmiHeader.biHeight < 0;
    int h = hbm->bmH, w = hbm->bmW;
    int stride = bmi->bmiHeader.biWidth > 0 ? bmi->bmiHeader.biWidth : w;
    int cw = w < stride ? w : stride;            /* biWidth stride (0211) */
    const uint32_t *in = (const uint32_t *)bits;
    int done = 0;
    for (UINT i = 0; i < lines; i++) {
        int dibRow = (int)(start + i);
        if (dibRow >= h) break;
        int bmRow = topDown ? dibRow : h - 1 - dibRow;
        for (int xcol = 0; xcol < cw; xcol++) {
            uint32_t d = in[i * (UINT)stride + (UINT)xcol];
            uint32_t b = d & 0xFF, g = (d >> 8) & 0xFF, r = (d >> 16) & 0xFF;
            hbm->bits[bmRow * w + xcol] = r | (g << 8) | (b << 16) | 0xFF000000u;
        }
        done++;
    }
    return done;
}

/* ============================================================ rect utils */

BOOL SetRect(RECT *r, int l, int t, int rr, int b) {
    if (!r) return FALSE;
    r->left = l; r->top = t; r->right = rr; r->bottom = b;
    return TRUE;
}
BOOL SetRectEmpty(RECT *r) { return SetRect(r, 0, 0, 0, 0); }
BOOL IsRectEmpty(const RECT *r) {
    return !r || r->right <= r->left || r->bottom <= r->top;
}
BOOL InflateRect(RECT *r, int dx, int dy) {
    if (!r) return FALSE;
    r->left -= dx; r->right += dx; r->top -= dy; r->bottom += dy;
    return TRUE;
}
BOOL OffsetRect(RECT *r, int dx, int dy) {
    if (!r) return FALSE;
    r->left += dx; r->right += dx; r->top += dy; r->bottom += dy;
    return TRUE;
}
BOOL IntersectRect(RECT *out, const RECT *a, const RECT *b) {
    if (!out || !a || !b) return FALSE;
    RECT t;
    t.left = a->left > b->left ? a->left : b->left;
    t.top = a->top > b->top ? a->top : b->top;
    t.right = a->right < b->right ? a->right : b->right;
    t.bottom = a->bottom < b->bottom ? a->bottom : b->bottom;
    if (t.right <= t.left || t.bottom <= t.top) { SetRectEmpty(out); return FALSE; }
    *out = t;
    return TRUE;
}
BOOL PtInRect(const RECT *r, POINT p) {
    return r && p.x >= r->left && p.x < r->right && p.y >= r->top && p.y < r->bottom;
}
BOOL EqualRect(const RECT *a, const RECT *b) {
    return a && b && a->left == b->left && a->top == b->top &&
           a->right == b->right && a->bottom == b->bottom;
}
BOOL CopyRect(RECT *dst, const RECT *src) {
    if (!dst || !src) return FALSE;
    *dst = *src;
    return TRUE;
}

int MulDiv(int a, int b, int c) {
    if (c == 0) return -1;
    long long v = (long long)a * b;
    if (v >= 0) v += c / 2; else v -= c / 2;
    return (int)(v / c);
}

/* The W text/font wrappers (0068) live in gdi32w.c since M4 (0259):
 * they need kernel32's UTF-16 boundary, and the menucore link set (wm.c)
 * carries gdi32 WITHOUT kernel32 — the W layer is veneer-side. */

/* ============================================================ mapping +
 * printing (0048, notepad's tail). MM_TEXT is the ONLY mapping mode — the
 * rasterizer is 1:1 pixels by construction; other modes fail loud. The
 * StartDoc family are honest failures: there is no printer, and notepad
 * only reaches them past a PrintDlgW that already said "cancelled" (the
 * -p command line). SP_ERROR per the API contract. */

int SetMapMode(HDC hdc, int mode) {
    (void)hdc;
    if (mode != MM_TEXT) {
        fprintf(stderr, "gdi32: SetMapMode(%d) unsupported (MM_TEXT only)\n", mode);
        return 0;
    }
    return MM_TEXT;
}

static int print_stub(const char *name) {
    fprintf(stderr, "gdi32: %s: no printing on this OS (todos/0048)\n", name);
    return -1;                                   /* SP_ERROR */
}

int StartDocW(HDC hdc, const DOCINFOW *di) { (void)hdc; (void)di; return print_stub("StartDocW"); }
int StartPage(HDC hdc) { (void)hdc; return print_stub("StartPage"); }
int EndPage(HDC hdc) { (void)hdc; return print_stub("EndPage"); }
int EndDoc(HDC hdc) { (void)hdc; return print_stub("EndDoc"); }
int AbortDoc(HDC hdc) { (void)hdc; return print_stub("AbortDoc"); }

/* ---------------- freetype requires (source-lib design §4.2) ----
 * Vendor knowledge stays with its consumer: gdi32.c is the TU that uses
 * freetype, so IT names the srclib shims — not windows.h. Host-side these
 * dedup against the freetype lib.json TUs (srcRoots {freetype: srclib});
 * in-OS the transitive require drain pulls them from /usr/src/freetype.
 * The set MUST equal vendor/freetype/lib.json sources — the §4.4 drift
 * gate enforces it. Each shim is a SELF-CONTAINED TU (the three build
 * defines live in-file, §3.4). */
__require_source("freetype/ftbase.c");
__require_source("freetype/ftsystem.c");
__require_source("freetype/ftdebug.c");
__require_source("freetype/ftinit.c");
__require_source("freetype/autofit.c");
__require_source("freetype/ftbitmap.c");
__require_source("freetype/ftmm.c");
__require_source("freetype/ftsynth.c");
__require_source("freetype/sfnt.c");
__require_source("freetype/truetype.c");
__require_source("freetype/smooth.c");
__require_source("freetype/psnames.c");
