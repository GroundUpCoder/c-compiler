/* ksvc.c — kernel service blob (todos/0275) FEASIBILITY SPIKE.
 * Minimal proof: FreeType built by our compiler, instantiated with a
 * minimal same-thread env, rasterizing one glyph to an A8 bitmap. */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_SYNTHESIS_H
#include "../fontchain.h"
#include <stdlib.h>
#include <string.h>

static FT_Library g_ft;
static FT_Face g_face;

int ksvc_init(void) {
    if (FT_Init_FreeType(&g_ft)) return -1;
    return 0;
}

int ksvc_spike_load_face(const char *path) {
    if (FT_New_Face(g_ft, path, 0, &g_face)) return -1;
    if (FT_Set_Pixel_Sizes(g_face, 0, 20)) return -2;
    return 0;
}

/* Rasterize one codepoint; returns malloc'd A8 bitmap, dims via out ptrs. */
static char g_fc[FC_MAX_FALLBACKS][FC_PATH_MAX];
int ksvc_spike_chain(void) { return fc_load(g_fc, FC_MAX_FALLBACKS); }

unsigned char *ksvc_spike_glyph(unsigned cp, int *w, int *h) {
    FT_UInt gi = FT_Get_Char_Index(g_face, cp);
    if (!gi) return 0;
    if (FT_Load_Glyph(g_face, gi, FT_LOAD_DEFAULT)) return 0;
    if (cp == 'B') FT_GlyphSlot_Embolden(g_face->glyph);   /* spike: bold probe */
    if (FT_Render_Glyph(g_face->glyph, FT_RENDER_MODE_NORMAL)) return 0;
    FT_Bitmap *bm = &g_face->glyph->bitmap;
    *w = (int)bm->width; *h = (int)bm->rows;
    unsigned char *out = malloc((size_t)bm->width * bm->rows);
    if (!out) return 0;
    for (unsigned y = 0; y < bm->rows; y++)
        memcpy(out + y * bm->width, bm->buffer + y * bm->pitch, bm->width);
    return out;
}

/* The compiler requires a main; the blob is never run as a process —
 * kernel JS calls the __export'd entry points directly. */
int main(void) { return 0; }

__export ksvc_init = ksvc_init;
__export ksvc_spike_load_face = ksvc_spike_load_face;
__export ksvc_spike_glyph = ksvc_spike_glyph;
__export ksvc_spike_chain = ksvc_spike_chain;
