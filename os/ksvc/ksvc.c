/* ksvc.c — the kernel service blob (todos/0275): the kernel's C half.
 *
 * Built at bake time by OUR compiler (buildProject, like every manifest
 * `project` entry), seeded at /usr/lib/ksvc.wasm, instantiated
 * synchronously IN the kernel's thread by os/ksvc.js over a minimal
 * read-only import env — no process, no pcb, no RPC. Capabilities land
 * as new __export'd entries on THIS blob (design:
 * todos/0275-kernel-text-service-design.md; seam doc: KERNEL.md).
 *
 * First capability: label TEXT — FreeType + fontchain.h rasterization
 * for window titles, the close-box 'x' and Exposé captions, replacing
 * the browser compositor's Canvas2D path and giving the headless
 * composite the same text (same blob bytes everywhere => deterministic).
 *
 * Font discipline = the gdi32 font_glyph / term cp_glyph rules (the
 * estate's third copy — consolidation into a header-only core is a
 * recorded follow-up, design §14.4): face 0 is /etc/fonts/mono.ttf >
 * /usr/share/fonts/mono.ttf; fallbacks come from fc_load() in list
 * order, opened LAZILY at first codepoint miss; ASCII <=126 always
 * renders from face 0 (the pre-chain contract); a total miss draws the
 * synthesized tofu box (cell * wcwidth), never '?'. */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include "../fontchain.h"
#include "../wcwidth.h"
#include <stdlib.h>
#include <string.h>

#define KSVC_ABI_VERSION 1

/* Title weight (design §10): browser bold replaced by outline embolden.
 * This freetype's stock FT_GlyphSlot_Embolden is AdjustWeight(0x0AAA)
 * — visibly heavier than browser bold at 20 px (spike result) — so we
 * embolden at HALF that delta, tuned at look-confirm. Units: the delta
 * scales as x_ppem * KSVC_BOLD_XDELTA / 1024, in 26.6 pixels (the exact
 * ftsynth.c formula). Bitmap-only chain faces (unifont) render regular:
 * bitmap emboldening is a different mechanism, deliberately skipped. */
#define KSVC_BOLD_XDELTA 0x0555

#define KSVC_FACE0_ETC   "/etc/fonts/mono.ttf"
#define KSVC_FACE0_BAKED "/usr/share/fonts/mono.ttf"

/* ---- faces (shared across size slots; one pixel size active at a
 * time per face, re-set on demand) ------------------------------- */
static FT_Library g_ft;
static FT_Face g_face0;
static char g_fcPaths[FC_MAX_FALLBACKS][FC_PATH_MAX];
static int g_fcCount;
static FT_Face g_fbFace[FC_MAX_FALLBACKS];
static signed char g_fbState[FC_MAX_FALLBACKS]; /* 0 untried / 1 open / -1 dead */
static int g_facePx[1 + FC_MAX_FALLBACKS];      /* current FT_Set_Pixel_Sizes */

static FT_Face face_at(int idx, int px) {
    FT_Face f;
    if (idx == 0) {
        f = g_face0;
    } else {
        int i = idx - 1;
        if (g_fbState[i] < 0) return NULL;
        if (g_fbState[i] == 0) {
            if (FT_New_Face(g_ft, g_fcPaths[i], 0, &g_fbFace[i])) {
                g_fbState[i] = -1;             /* dead: skip forever */
                return NULL;
            }
            g_fbState[i] = 1;
            g_facePx[idx] = 0;
        }
        f = g_fbFace[i];
    }
    if (g_facePx[idx] != px) {
        if (FT_Set_Pixel_Sizes(f, 0, (FT_UInt)px)) return NULL;
        g_facePx[idx] = px;
    }
    return f;
}

/* The face that covers cp: face 0, else the chain in list order, else
 * NULL (tofu). ASCII always renders from face 0 (glyph 0 included). */
static FT_Face face_for(unsigned cp, int px, FT_UInt *gi) {
    FT_Face f0 = face_at(0, px);
    if (!f0) return NULL;
    *gi = FT_Get_Char_Index(f0, (FT_ULong)cp);
    if (*gi || cp <= 126) return f0;
    for (int i = 0; i < g_fcCount; i++) {
        FT_Face ff = face_at(1 + i, px);
        if (!ff) continue;
        *gi = FT_Get_Char_Index(ff, (FT_ULong)cp);
        if (*gi) return ff;
    }
    return NULL;
}

/* ---- per-(px,flags) glyph caches (the gdi32 cache shape: flat [95]
 * ASCII array + linear-scan side cache of rendered A8 glyphs) ------ */
typedef struct {
    int loaded;
    int advance;                 /* px */
    int left, top;               /* bitmap_left / bitmap_top */
    int w, h;
    unsigned char *bmp;          /* A8 coverage, w*h, cache-owned */
} Glyph;

typedef struct {
    int px, flags;
    int ascent, descent;         /* face-0 metrics at px; strip h = a+d */
    int cell;                    /* mono advance (tofu cell) */
    Glyph ascii[95];             /* cp 32..126 */
    unsigned *xcps;              /* side cache, linear scan */
    Glyph *xglyphs;
    int xn, xcap;
} SizeSlot;

static SizeSlot *g_slots;
static int g_nslots, g_slotCap;

static SizeSlot *slot_for(int px, int flags) {
    flags &= 1;                  /* bit 0 = bold; other bits reserved */
    for (int i = 0; i < g_nslots; i++)
        if (g_slots[i].px == px && g_slots[i].flags == flags)
            return &g_slots[i];
    FT_Face f0 = face_at(0, px);
    if (!f0) return NULL;
    if (g_nslots == g_slotCap) {
        int nc = g_slotCap ? g_slotCap * 2 : 4;
        SizeSlot *ns = realloc(g_slots, (size_t)nc * sizeof(SizeSlot));
        if (!ns) return NULL;
        g_slots = ns;
        g_slotCap = nc;
    }
    SizeSlot *s = &g_slots[g_nslots++];
    memset(s, 0, sizeof *s);
    s->px = px;
    s->flags = flags;
    s->ascent = (int)(f0->size->metrics.ascender >> 6);
    s->descent = (int)(-f0->size->metrics.descender >> 6);
    /* tofu cell = the 'M' advance (the gdi32 monoAdv rule — max_advance
     * overshoots on faces with a few wide glyphs), plain weight so the
     * cell rhythm matches term/gdi32 regardless of the bold flag. */
    s->cell = (int)(f0->size->metrics.max_advance >> 6);
    FT_UInt mi = FT_Get_Char_Index(f0, 'M');
    if (mi && !FT_Load_Glyph(f0, mi, FT_LOAD_DEFAULT)) {
        int madv = (int)(f0->glyph->advance.x >> 6);
        if (madv > 0) s->cell = madv;
    }
    return s;
}

/* Synthesized tofu box (the gdi32 glyph_tofu rule): a LOUD visible gap
 * marker for a code point NO chain face covers — cell * wcwidth wide,
 * never a '?' that reads as data corruption. */
static void glyph_tofu(SizeSlot *s, Glyph *g, unsigned cp) {
    int adv = s->cell * (wcwidth_cp(cp) == 2 ? 2 : 1);
    int w = adv > 4 ? adv - 2 : 6;
    int h = s->ascent > 4 ? s->ascent - 1 : 8;
    g->advance = adv > 0 ? adv : w + 2;
    g->left = 1;
    g->top = s->ascent - 1;                    /* box base sits on baseline */
    g->bmp = calloc((size_t)w * h, 1);
    if (!g->bmp) return;
    g->w = w;
    g->h = h;
    for (int x = 0; x < w; x++)
        g->bmp[x] = g->bmp[(h - 1) * w + x] = 255;
    for (int y = 0; y < h; y++)
        g->bmp[y * w] = g->bmp[y * w + w - 1] = 255;
}

static Glyph *glyph_render(SizeSlot *s, Glyph *g, unsigned cp) {
    g->loaded = 1;
    FT_UInt gi;
    FT_Face face = face_for(cp, s->px, &gi);
    if (!face) {
        glyph_tofu(s, g, cp);
        return g;
    }
    if (FT_Load_Glyph(face, gi, FT_LOAD_DEFAULT)) return g;
    FT_GlyphSlot slot = face->glyph;
    if (s->flags & 1) {
        /* embolden affects advances too, so measure and render agree by
         * construction (both come through this one cache fill). */
        FT_Pos xstr = (FT_Pos)face->size->metrics.x_ppem * KSVC_BOLD_XDELTA / 1024;
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
        g->bmp = malloc((size_t)g->w * g->h);
        if (!g->bmp) { g->w = g->h = 0; return g; }
        for (int y = 0; y < g->h; y++)
            memcpy(&g->bmp[y * g->w], &bm->buffer[y * bm->pitch], (size_t)g->w);
    }
    return g;
}

/* Glyph for one CODE POINT. NB the returned pointer is only stable
 * until the next glyph() call on the same slot (side cache reallocs). */
static Glyph *glyph(SizeSlot *s, unsigned cp) {
    if (cp < 32) cp = '?';                     /* control chars, term's rule */
    if (cp <= 126) {
        Glyph *g = &s->ascii[cp - 32];
        return g->loaded ? g : glyph_render(s, g, cp);
    }
    for (int i = 0; i < s->xn; i++)
        if (s->xcps[i] == cp) return &s->xglyphs[i];
    if (s->xn == s->xcap) {
        int nc = s->xcap ? s->xcap * 2 : 16;
        Glyph *ng = realloc(s->xglyphs, (size_t)nc * sizeof(Glyph));
        unsigned *np = realloc(s->xcps, (size_t)nc * sizeof(unsigned));
        if (ng) s->xglyphs = ng;
        if (np) s->xcps = np;
        if (!ng || !np) return glyph(s, '?');  /* OOM: keep drawing */
        s->xcap = nc;
    }
    s->xcps[s->xn] = cp;
    Glyph *g = &s->xglyphs[s->xn++];
    memset(g, 0, sizeof *g);
    return glyph_render(s, g, cp);
}

/* ---- UTF-8 stepping — the win32_internal.h __u8_next rules verbatim
 * (malformed bytes decode as U+FFFD past the bad lead byte only; the
 * tri-plication is the recorded §14.4 follow-up). ------------------ */
static unsigned u8_next(const char *s, int len, int *i) {
    unsigned char c = (unsigned char)s[(*i)++];
    if (c < 0x80) return c;
    int cont = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : -1;
    if (cont < 0) return 0xFFFD;               /* stray continuation byte */
    unsigned cp = c & (unsigned)(0x3F >> cont);
    for (int k = 0; k < cont; k++) {
        if (*i >= len || ((unsigned char)s[*i] & 0xC0) != 0x80)
            return 0xFFFD;                     /* truncated sequence */
        cp = (cp << 6) | ((unsigned char)s[(*i)++] & 0x3Fu);
    }
    return cp;
}

/* ---- ABI (design §4) --------------------------------------------- */

int ksvc_abi(void) { return KSVC_ABI_VERSION; }

/* FT init + fontchain config + EAGER face 0: a boot that can't render
 * chrome text must fail AT BOOT, not at first title. Chain faces stay
 * lazy. Config is read here, once — font-package installs reach the
 * chrome at next boot (the settled item's per-boot discipline). */
int ksvc_init(void) {
    if (FT_Init_FreeType(&g_ft)) return -1;
    g_fcCount = fc_load(g_fcPaths, FC_MAX_FALLBACKS);
    if (FT_New_Face(g_ft, KSVC_FACE0_ETC, 0, &g_face0) &&
        FT_New_Face(g_ft, KSVC_FACE0_BAKED, 0, &g_face0))
        return -2;
    return 0;
}

/* Blob-owned input staging buffer, grown to >= len, never freed. (Not
 * alloca: the exported alloca never pops outside main, so per-frame use
 * would leak the wasm stack. Not malloc/free exports: one persistent
 * scratch matches the one-text-at-a-time synchronous call pattern.) */
static char *g_in;
static int g_inCap;
char *ksvc_buf(int len) {
    if (len <= 0) len = 1;
    if (len > g_inCap) {
        char *nb = realloc(g_in, (size_t)len);
        if (!nb) return 0;
        g_in = nb;
        g_inCap = len;
    }
    return g_in;
}

/* Advance-sum width of the WHOLE string at px (no maxW, no ellipsis).
 * Same glyph pipeline as render, so the two agree by construction. */
int ksvc_text_measure(const char *utf8, int len, int px, int flags) {
    if (px <= 0 || len < 0) return 0;
    SizeSlot *s = slot_for(px, flags);
    if (!s) return 0;
    int w = 0;
    for (int i = 0; i < len; )
        w += glyph(s, u8_next(utf8, len, &i))->advance;
    return w;
}

/* ---- render -------------------------------------------------------
 * Output: blob-owned buffer, 16-byte header { i32 w,h,stride,reserved }
 * then h rows of stride (= w*4) RGBA bytes, STRAIGHT alpha (rgb =
 * fg.rgb everywhere, a = coverage * fg.a / 255) — exactly what the
 * WebGPU src-alpha blend and the kernel's 0063 integer src-over want.
 * Valid until the NEXT ksvc_text_render call; callers consume
 * immediately. rgba_fg is packed 0xRRGGBBAA. */
static unsigned char *g_out;
static int g_outCap;

static void blit(unsigned char *px0, int outW, int outH, int stride,
                 Glyph *g, int penX, int baseline,
                 unsigned fr, unsigned fg_, unsigned fb, unsigned fa) {
    int x0 = penX + g->left;
    int y0 = baseline - g->top;
    for (int y = 0; y < g->h; y++) {
        int oy = y0 + y;
        if (oy < 0 || oy >= outH) continue;
        for (int x = 0; x < g->w; x++) {
            int ox = x0 + x;
            if (ox < 0 || ox >= outW) continue;
            unsigned cov = g->bmp ? g->bmp[y * g->w + x] : 0;
            if (!cov) continue;
            unsigned a = (cov * fa + 127) / 255;
            unsigned char *p = px0 + oy * stride + ox * 4;
            p[0] = (unsigned char)fr;
            p[1] = (unsigned char)fg_;
            p[2] = (unsigned char)fb;
            if (a > p[3]) p[3] = (unsigned char)a;   /* glyphs never overlap
                                                        meaningfully; max keeps
                                                        AA edges stable */
        }
    }
}

unsigned char *ksvc_text_render(const char *utf8, int len, int px, int maxW,
                                unsigned rgba_fg, int flags) {
    if (px <= 0 || len < 0 || maxW < 0) return 0;
    SizeSlot *s = slot_for(px, flags);
    if (!s) return 0;
    int h = s->ascent + s->descent;

    /* Truncation plan: whole string if it fits, else the longest prefix
     * such that prefix + ellipsis fits maxW (U+2026 chain-probed, "..."
     * if no face covers it), else the raw string hard-clipped at maxW. */
    int total = 0;
    for (int i = 0; i < len; )
        total += glyph(s, u8_next(utf8, len, &i))->advance;
    int endByte = len;          /* bytes of the string we draw */
    int ell = 0;                /* 0 none / 1 U+2026 / 3 "..." */
    int w;
    if (total <= maxW) {
        w = total;
    } else {
        FT_UInt egi;
        ell = face_for(0x2026, s->px, &egi) ? 1 : 3;
        int ellW = ell == 1 ? glyph(s, 0x2026)->advance
                            : 3 * glyph(s, '.')->advance;
        if (ellW > maxW) {
            ell = 0;            /* not even the ellipsis fits: hard clip */
            endByte = len;
            w = maxW;
        } else {
            int acc = 0, i = 0;
            endByte = 0;
            while (i < len) {
                int adv = glyph(s, u8_next(utf8, len, &i))->advance;
                if (acc + adv + ellW > maxW) break;
                acc += adv;
                endByte = i;
            }
            w = acc + ellW;
        }
    }
    if (w > maxW) w = maxW;
    if (w < 0) w = 0;

    int stride = w * 4;
    int need = 16 + h * stride;
    if (need > g_outCap) {
        unsigned char *nb = realloc(g_out, (size_t)need);
        if (!nb) return 0;
        g_out = nb;
        g_outCap = need;
    }
    if (!g_out) return 0;
    ((int *)g_out)[0] = w;
    ((int *)g_out)[1] = h;
    ((int *)g_out)[2] = stride;
    ((int *)g_out)[3] = 0;
    unsigned char *px0 = g_out + 16;
    memset(px0, 0, (size_t)h * stride);

    unsigned fr = (rgba_fg >> 24) & 0xFF, fg_ = (rgba_fg >> 16) & 0xFF;
    unsigned fb = (rgba_fg >> 8) & 0xFF, fa = rgba_fg & 0xFF;
    int pen = 0;
    for (int i = 0; i < endByte; ) {
        Glyph *g = glyph(s, u8_next(utf8, endByte, &i));
        blit(px0, w, h, stride, g, pen, s->ascent, fr, fg_, fb, fa);
        pen += g->advance;
    }
    if (ell == 1) {
        Glyph *g = glyph(s, 0x2026);
        blit(px0, w, h, stride, g, pen, s->ascent, fr, fg_, fb, fa);
    } else if (ell == 3) {
        for (int k = 0; k < 3; k++) {
            Glyph *g = glyph(s, '.');
            blit(px0, w, h, stride, g, pen, s->ascent, fr, fg_, fb, fa);
            pen += g->advance;
        }
    }
    return g_out;
}

/* The compiler requires a main; the blob is never run as a process —
 * kernel JS calls the __export'd entry points directly. */
int main(void) { return 0; }

__export ksvc_abi = ksvc_abi;
__export ksvc_init = ksvc_init;
__export ksvc_buf = ksvc_buf;
__export ksvc_text_measure = ksvc_text_measure;
__export ksvc_text_render = ksvc_text_render;
