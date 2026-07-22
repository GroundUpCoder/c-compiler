/* fontcore.h — ONE header-only glyph pipeline for the estate's freetype
 * text consumers (todos/0277; the fontchain.h / fileops.h / openwith.h
 * precedent). Consolidates the chain-probe / tofu / two-tier-cache /
 * glyph-render discipline that gdi32 (os/win32/gdi32.c), term
 * (os/term/term.c) and ksvc (os/ksvc/ksvc.c) each carried a copy of —
 * so they now agree by CONSTRUCTION, not by convention.
 *
 * The shape (unchanged from the three originals, extracted verbatim):
 *   face 0 = the baked/user mono face (/etc/fonts/mono.ttf >
 *   /usr/share/fonts/mono.ttf); the fallback chain (fontchain.h) is
 *   probed in list order (FT_Get_Char_Index until nonzero) and rendered
 *   from the first covering face, ASCII (<=126) always from face 0 (the
 *   pre-chain contract, glyph 0 included). A code point NO face covers
 *   renders the synthesized tofu box (cell x wcwidth) — a LOUD gap
 *   marker, never a '?' that reads as data corruption. Chain faces open
 *   LAZILY and dead-mark on failure. Glyphs cache in a flat [95] ASCII
 *   array + a lazily-grown linear-scan side cache.
 *
 * The per-consumer differences are parameterized EXPLICITLY, never
 * smuggled: gdi32's NONANTIALIASED mono threshold + per-HFONT sizing,
 * term's fixed cell metrics, ksvc's per-(px,flags) slots + outline
 * embolden. This is a pure refactor: rendering is BYTE-IDENTICAL before
 * and after (the fontpkg + ksvc same-bytes e2es + term's golden shots
 * are the oracles).
 *
 * Each adapter owns its own face-0 lifecycle + metric extraction (too
 * consumer-specific to share: per-HFONT eager-with-metrics vs global
 * eager vs global resize-on-demand) and supplies its render step through
 * the FcRenderFn seam; the core owns the algorithm around it. */
#ifndef FONTCORE_H
#define FONTCORE_H

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include <stdlib.h>
#include <string.h>
#include "fontchain.h"   /* FC_MAX_FALLBACKS, FC_PATH_MAX, fc_load */
#include "wcwidth.h"     /* wcwidth_cp — a wide-cp tofu box spans 2 cells */

/* Face 0 = the mono face pair every consumer shares (the fontchain.h
 * face-0 contract; adapters open it themselves, this just names it). */
#define FONTCORE_FACE0_ETC   "/etc/fonts/mono.ttf"
#define FONTCORE_FACE0_BAKED "/usr/share/fonts/mono.ttf"

/* One cached glyph: a rendered A8 coverage bitmap + placement. `advance`
 * is the pen advance in px (term ignores it — monospace uses its cell
 * pitch — but carries the field for a uniform struct). NB a cache
 * pointer is stable only until the NEXT lookup on the same cache (the
 * side cache reallocs). */
typedef struct {
    int loaded;                  /* 0 = ASCII slot not yet rendered */
    int w, h, left, top;         /* freetype bitmap + placement */
    int advance;                 /* pen advance, px */
    unsigned char *bmp;          /* alpha, w*h (NULL if blank) */
} FcGlyph;

/* Two-tier glyph cache: ASCII 32..126 in a flat array, everything else
 * in a lazily-grown linear-scan side cache. */
typedef struct {
    FcGlyph ascii[95];           /* cp 32..126 */
    unsigned *xcps;              /* side-cache code points, linear scan */
    FcGlyph *xglyphs;            /* paired rendered glyphs */
    int xn, xcap;
} FcCache;

/* Fill glyph `g` for code point `cp` (already >= 32; the caller maps
 * control chars to its substitute) and mark it loaded. Called by
 * fc_cache_get on a cache miss; `ctx` is the adapter's per-lookup state
 * (its HFONT / size slot / global set). */
typedef FcGlyph *(*FcRenderFn)(void *ctx, FcGlyph *g, unsigned cp);

/* Glyph for one CODE POINT: ASCII from the flat array (cached by
 * `loaded`), everything else from the side cache, rendered on first use.
 * `cp` must be >= 32. On side-cache OOM keeps drawing by falling back to
 * '?' (an ASCII slot, no further growth). */
static FcGlyph *fc_cache_get(FcCache *c, unsigned cp, FcRenderFn render, void *ctx) {
    if (cp <= 126) {
        FcGlyph *g = &c->ascii[cp - 32];
        return g->loaded ? g : render(ctx, g, cp);
    }
    for (int i = 0; i < c->xn; i++)
        if (c->xcps[i] == cp) return &c->xglyphs[i];
    if (c->xn == c->xcap) {
        int nc = c->xcap ? c->xcap * 2 : 16;
        FcGlyph *ng = (FcGlyph *)realloc(c->xglyphs, (size_t)nc * sizeof(FcGlyph));
        unsigned *np = (unsigned *)realloc(c->xcps, (size_t)nc * sizeof(unsigned));
        if (ng) c->xglyphs = ng;
        if (np) c->xcps = np;
        if (!ng || !np) return fc_cache_get(c, '?', render, ctx);  /* OOM */
        c->xcap = nc;
    }
    c->xcps[c->xn] = cp;
    FcGlyph *g = &c->xglyphs[c->xn++];
    memset(g, 0, sizeof *g);
    return render(ctx, g, cp);
}

/* ---- UTF-8 stepper -------------------------------------------------
 * Decode the code point at byte `*i`, advancing `*i` past it. Malformed
 * bytes decode as U+FFFD advancing past the bad lead byte only, so
 * byte-indexed callers never desync. (Identical to win32_internal.h's
 * __u8_next, which stays the win32 seam's caret-math copy — folding it
 * here would couple user32's EDIT to freetype; see todos/0277.) */
static unsigned fc_u8_next(const char *s, int len, int *i) {
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

/* ---- tofu ----------------------------------------------------------
 * Synthesized box for a code point NO chain face covers: a LOUD visible
 * gap marker (never '?', and never glyph 0 whose .notdef can be EMPTY).
 * A wide (wcwidth 2) code point gets a 2-cell box — the honest footprint
 * of the missing glyph. `cell` is the mono cell pitch, `ascent` the
 * face-0 ascent at this size. */
static void fc_tofu(FcGlyph *g, int cell, int ascent, unsigned cp) {
    int adv = cell * (wcwidth_cp(cp) == 2 ? 2 : 1);
    int w = adv > 4 ? adv - 2 : 6;
    int h = ascent > 4 ? ascent - 1 : 8;
    g->advance = adv > 0 ? adv : w + 2;
    g->left = 1;
    g->top = ascent - 1;                         /* box base sits on baseline */
    g->bmp = (unsigned char *)calloc((size_t)w * h, 1);
    if (!g->bmp) return;
    g->w = w;
    g->h = h;
    for (int x = 0; x < w; x++)
        g->bmp[x] = g->bmp[(h - 1) * w + x] = 255;
    for (int y = 0; y < h; y++)
        g->bmp[y * w] = g->bmp[y * w + w - 1] = 255;
}

/* ---- fallback chain (lazy open + dead-mark + resize-on-demand) -----
 * The per-owner mutable chain state. `paths`/`n` point at the adapter's
 * fc_load()ed list (face 0 is NOT in it); `on_fail` (NULL = silent)
 * reports a face that won't load. A face is opened once, dead-marked on
 * failure (skipped forever), and re-sized only when the requested px
 * changes — so a fixed-size consumer (gdi32 per-HFONT, term) sets the
 * size once and a multi-size consumer (ksvc) re-sizes the shared face on
 * demand, both from this one accessor. */
typedef struct {
    FT_Library ft;
    const char (*paths)[FC_PATH_MAX];    /* -> adapter's fc paths array */
    int n;                               /* chain length */
    void (*on_fail)(const char *path);   /* load-failure hook, NULL = silent */
    FT_Face face[FC_MAX_FALLBACKS];
    signed char state[FC_MAX_FALLBACKS]; /* 0 untried / 1 open / -1 dead */
    int px[FC_MAX_FALLBACKS];            /* current FT_Set_Pixel_Sizes, 0 = unset */
} FcChain;

static void fc_chain_init(FcChain *ch, FT_Library ft,
                          char paths[][FC_PATH_MAX], int n,
                          void (*on_fail)(const char *)) {
    ch->ft = ft;
    ch->paths = (const char (*)[FC_PATH_MAX])paths;
    ch->n = n;
    ch->on_fail = on_fail;
    for (int i = 0; i < FC_MAX_FALLBACKS; i++) {
        ch->face[i] = NULL;
        ch->state[i] = 0;
        ch->px[i] = 0;
    }
}

/* Chain face `i` sized to `px`, opened lazily & dead-marked on failure;
 * NULL if dead or unloadable (probe skips it). */
static FT_Face fc_chain_face(FcChain *ch, int i, int px) {
    if (ch->state[i] < 0) return NULL;
    if (ch->state[i] == 0) {
        if (FT_New_Face(ch->ft, ch->paths[i], 0, &ch->face[i])) {
            ch->state[i] = -1;                   /* dead: skip forever */
            if (ch->on_fail) ch->on_fail(ch->paths[i]);
            return NULL;
        }
        ch->state[i] = 1;
        ch->px[i] = 0;
    }
    if (ch->px[i] != px) {
        if (FT_Set_Pixel_Sizes(ch->face[i], 0, (FT_UInt)px)) return NULL;
        ch->px[i] = px;
    }
    return ch->face[i];
}

/* ---- probe ---------------------------------------------------------
 * The face covering `cp`: face 0, else the chain in list order, else
 * NULL (tofu). ASCII (<=126) always renders from face 0 (glyph 0
 * included — the pre-chain contract). `face0` is the adapter's ready
 * face 0; `px` sizes the chain faces to match. */
static FT_Face fc_probe(FT_Face face0, FcChain *ch, int px,
                        unsigned cp, FT_UInt *gi) {
    *gi = FT_Get_Char_Index(face0, (FT_ULong)cp);
    if (*gi || cp <= 126) return face0;
    for (int i = 0; i < ch->n; i++) {
        FT_Face ff = fc_chain_face(ch, i, px);
        if (!ff) continue;
        *gi = FT_Get_Char_Index(ff, (FT_ULong)cp);
        if (*gi) return ff;
    }
    return NULL;
}

/* ---- render --------------------------------------------------------
 * Per-render knobs. `mono_threshold` > 0 thresholds the smooth coverage
 * to 1-bit (gdi32 NONANTIALIASED); `bold_xdelta` > 0 outline-emboldens
 * (ksvc title weight, the ftsynth.c x_ppem * delta / 1024 formula) so
 * measure and render agree by construction. 0 disables each. */
typedef struct {
    int mono_threshold;
    int bold_xdelta;
} FcRenderOpts;

/* Load flags for the face's CURRENT ppem (todos/0279). Small sizes get
 * light autohinting (vertical-only stem snapping) — unhinted stems land
 * between pixel boundaries and read as mush below ~16px. The tuned 20px
 * system size stays UNHINTED and must say so EXPLICITLY: with autofit
 * registered and the TT bytecode interpreter compiled out, a plain
 * FT_LOAD_DEFAULT would silently full-autohint (no native hinter, see
 * ftobjs.c), so FT_LOAD_NO_AUTOHINT is what keeps 20px bit-identical to
 * the Phase C/D metrics the ksvc/fontpkg same-bytes e2es pin. Light
 * hinting rounds advances to whole pixels (afloader.c) where unhinted
 * loads truncate — every metric probe ('M'-advance cell sizing) must use
 * THESE flags too, so measure and render agree at every size. */
#define FONTCORE_HINTED_PPEM_EXEMPT 20
static FT_Int32 fc_load_flags(FT_Face face) {
    return face->size->metrics.y_ppem == FONTCORE_HINTED_PPEM_EXEMPT
        ? FT_LOAD_DEFAULT | FT_LOAD_NO_AUTOHINT
        : FT_LOAD_TARGET_LIGHT | FT_LOAD_FORCE_AUTOHINT;
}

/* Load glyph `gi` from `face` into `g` (the caller already resolved the
 * covering face + set g->loaded). The one FT_Load / embolden / advance /
 * FT_Render / copy / threshold sequence the three consumers shared. */
static FcGlyph *fc_render_face(FcGlyph *g, FT_Face face, FT_UInt gi, FcRenderOpts o) {
    if (FT_Load_Glyph(face, gi, fc_load_flags(face))) return g;
    FT_GlyphSlot slot = face->glyph;
    if (o.bold_xdelta) {
        /* embolden affects advances too, so measure and render agree. */
        FT_Pos xstr = (FT_Pos)face->size->metrics.x_ppem * o.bold_xdelta / 1024;
        if (slot->format == FT_GLYPH_FORMAT_OUTLINE && xstr > 0) {
            FT_Outline_EmboldenXY(&slot->outline, xstr, xstr);
            slot->advance.x += xstr;
        }
    }
    g->advance = (int)(slot->advance.x >> 6);
    if (FT_Render_Glyph(slot, FT_RENDER_MODE_NORMAL)) return g;
    FT_Bitmap *bm = &slot->bitmap;
    g->w = (int)bm->width;
    g->h = (int)bm->rows;
    g->left = slot->bitmap_left;
    g->top = slot->bitmap_top;
    if (g->w > 0 && g->h > 0) {
        g->bmp = (unsigned char *)malloc((size_t)g->w * g->h);
        if (!g->bmp) { g->w = g->h = 0; return g; }
        for (int y = 0; y < g->h; y++)
            memcpy(&g->bmp[y * g->w], &bm->buffer[y * bm->pitch], (size_t)g->w);
        if (o.mono_threshold) {
            for (int i = 0; i < g->w * g->h; i++)
                g->bmp[i] = g->bmp[i] >= o.mono_threshold ? 255 : 0;
        }
    }
    return g;
}

#endif /* FONTCORE_H */
