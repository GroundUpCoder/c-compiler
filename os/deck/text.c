/* text.c — deck's fontcore adapter + wrap layout (todos/0284). The
 * adapter is ksvc's multi-size shape (per-px slots over one shared
 * face 0, resize-on-demand) minus the bold knob; the layout is deck's
 * own: '\n' hard breaks, greedy word wrap, align/valign, overflow
 * visible. */
#include "text.h"

#include "../fontcore.h"   /* pulls ft2build/freetype, fontchain.h, wcwidth.h */

/* ---- faces (the ksvc pattern) -------------------------------------- */

static FT_Library g_ft;
static FT_Face g_face0;
static int g_face0Px;
static char g_fcPaths[FC_MAX_FALLBACKS][FC_PATH_MAX];
static FcChain g_chain;

static FT_Face face_at0(int px) {
    if (g_face0Px != px) {
        if (FT_Set_Pixel_Sizes(g_face0, 0, (FT_UInt)px))
            return NULL;
        g_face0Px = px;
    }
    return g_face0;
}

static FT_Face face_for(unsigned cp, int px, FT_UInt *gi) {
    FT_Face f0 = face_at0(px);
    if (!f0)
        return NULL;
    return fc_probe(f0, &g_chain, px, cp, gi);
}

int dtext_init(void) {
    if (FT_Init_FreeType(&g_ft))
        return -1;
    int n = fc_load(g_fcPaths, FC_MAX_FALLBACKS);
    fc_chain_init(&g_chain, g_ft, g_fcPaths, n, NULL);
    if (FT_New_Face(g_ft, FONTCORE_FACE0_ETC, 0, &g_face0) &&
        FT_New_Face(g_ft, FONTCORE_FACE0_BAKED, 0, &g_face0))
        return -2;
    return 0;
}

/* ---- per-px glyph cache slots --------------------------------------- */

typedef struct {
    int px;
    int ascent, descent, lineH, cell;
    FcCache cache;
} Slot;

static Slot *g_slots;
static int g_nslots, g_slotCap;

static Slot *slot_for(int px) {
    for (int i = 0; i < g_nslots; i++)
        if (g_slots[i].px == px)
            return &g_slots[i];
    FT_Face f0 = face_at0(px);
    if (!f0)
        return NULL;
    if (g_nslots == g_slotCap) {
        int nc = g_slotCap ? g_slotCap * 2 : 8;
        Slot *ns = realloc(g_slots, (size_t)nc * sizeof(Slot));
        if (!ns)
            return NULL;
        g_slots = ns;
        g_slotCap = nc;
    }
    Slot *s = &g_slots[g_nslots++];
    memset(s, 0, sizeof *s);
    s->px = px;
    s->ascent = (int)(f0->size->metrics.ascender >> 6);
    s->descent = (int)(-f0->size->metrics.descender >> 6);
    s->lineH = (int)(f0->size->metrics.height >> 6);
    if (s->lineH <= 0)
        s->lineH = s->ascent + s->descent;
    s->cell = (int)(f0->size->metrics.max_advance >> 6);
    FT_UInt mi = FT_Get_Char_Index(f0, 'M');
    if (mi && !FT_Load_Glyph(f0, mi, fc_load_flags(f0))) {
        int madv = (int)(f0->glyph->advance.x >> 6);
        if (madv > 0)
            s->cell = madv;
    }
    return s;
}

static FcGlyph *slot_render(void *ctx, FcGlyph *g, unsigned cp) {
    Slot *s = (Slot *)ctx;
    g->loaded = 1;
    FT_UInt gi;
    FT_Face face = face_for(cp, s->px, &gi);
    if (!face) {
        fc_tofu(g, s->cell, s->ascent, cp);
        return g;
    }
    FcRenderOpts o = { 0, 0 };
    return fc_render_face(g, face, gi, o);
}

static FcGlyph *glyph(Slot *s, unsigned cp) {
    if (cp < 32)
        cp = '?';                  /* control chars, term's rule */
    return fc_cache_get(&s->cache, cp, slot_render, s);
}

/* ---- layout ---------------------------------------------------------- */

static int measure(Slot *s, const char *t, int i0, int i1) {
    int w = 0;
    for (int i = i0; i < i1; )
        w += glyph(s, fc_u8_next(t, i1, &i))->advance;
    return w;
}

typedef struct { int b0, b1, w; } Line;   /* byte range + measured width */

static void push_line(Line **lines, int *n, int *cap, int b0, int b1, int w) {
    if (*n == *cap) {
        int nc = *cap ? *cap * 2 : 8;
        Line *nl = realloc(*lines, (size_t)nc * sizeof(Line));
        if (!nl)
            return;                /* OOM: drop the tail rather than crash */
        *lines = nl;
        *cap = nc;
    }
    (*lines)[(*n)++] = (Line){ b0, b1, w };
}

static int is_break(char ch) { return ch == ' ' || ch == '\t'; }

/* Split one '\n'-free paragraph [p0, p1) into wrapped lines. */
static void wrap_para(Slot *s, const char *t, int p0, int p1, int boxW,
                      int wrap, Line **lines, int *n, int *cap) {
    if (!wrap || measure(s, t, p0, p1) <= boxW) {
        push_line(lines, n, cap, p0, p1, measure(s, t, p0, p1));
        return;
    }
    int lineStart = p0, lineEnd = p0, lineW = 0;
    int i = p0;
    while (i < p1) {
        /* token = the whitespace run + the word after it */
        int ws = i;
        while (i < p1 && is_break(t[i]))
            i++;
        int w0 = i;
        while (i < p1 && !is_break(t[i]))
            i++;
        int tokW = measure(s, t, ws, i);            /* spaces + word */
        int wordW = measure(s, t, w0, i);
        if (lineEnd == lineStart) {                 /* line still empty */
            if (wordW <= boxW || w0 == i) {
                lineEnd = i;
                lineW = measure(s, t, lineStart, i);
                continue;
            }
            /* overlong word on an empty line: glyph-granularity break */
            int j = w0, acc = 0;
            while (j < i) {
                int k = j;
                int adv = glyph(s, fc_u8_next(t, i, &k))->advance;
                if (acc && acc + adv > boxW)
                    break;
                acc += adv;
                j = k;
            }
            push_line(lines, n, cap, w0, j, acc);
            lineStart = lineEnd = j;
            lineW = 0;
            i = j;
            continue;
        }
        if (lineW + tokW <= boxW) {
            lineEnd = i;
            lineW += tokW;
        } else {                                    /* break before the word */
            push_line(lines, n, cap, lineStart, lineEnd, lineW);
            lineStart = lineEnd = w0;               /* break eats the spaces */
            lineW = 0;
            i = w0;                                 /* re-enter with the word */
        }
    }
    if (lineEnd > lineStart || *n == 0)
        push_line(lines, n, cap, lineStart, lineEnd, lineW);
}

void dtext_draw(RCanvas *c, const char *utf8, int px,
                float bx, float by, float bw, float bh,
                int align, int valign, int wrap, DColor col) {
    if (!utf8 || px < 1)
        return;
    Slot *s = slot_for(px);
    if (!s)
        return;
    int len = (int)strlen(utf8);

    Line *lines = NULL;
    int nlines = 0, cap = 0;
    int p0 = 0;
    for (int i = 0; i <= len; i++)
        if (i == len || utf8[i] == '\n') {
            wrap_para(s, utf8, p0, i, (int)bw, wrap, &lines, &nlines, &cap);
            p0 = i + 1;
        }

    float total = (float)nlines * s->lineH;
    float y = by;
    if (valign == DVALIGN_MIDDLE)
        y += (bh - total) * 0.5f;
    else if (valign == DVALIGN_BOTTOM)
        y += bh - total;

    for (int li = 0; li < nlines; li++) {
        float x = bx;
        if (align == DALIGN_CENTER)
            x += (bw - lines[li].w) * 0.5f;
        else if (align == DALIGN_RIGHT)
            x += bw - lines[li].w;
        int baseline = (int)(y + 0.5f) + li * s->lineH + s->ascent;
        int pen = (int)(x + 0.5f);
        for (int i = lines[li].b0; i < lines[li].b1; ) {
            FcGlyph *g = glyph(s, fc_u8_next(utf8, lines[li].b1, &i));
            rc_blend_cov(c, g->bmp, g->w, g->h,
                         pen + g->left, baseline - g->top,
                         col.r, col.g, col.b, col.a);
            pen += g->advance;
        }
    }
    free(lines);
}
