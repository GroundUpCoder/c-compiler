/* raster.h — /bin/deck's CPU rasterizer (todos/0284, design
 * ~/git/meta/gucos/notes/slide-tool-design.md §1.3).
 *
 * Pure C over libc+math — NO SDL, NO freetype, NO cJSON — so the layer is
 * reusable as-is by a future litehtml document_container (design §2.2) and
 * testable standalone.
 *
 * The AA model (design §1.3 + §6 unknown #1): every shape rasterizes HARD
 * (0/255) coverage into an RMask at DECK_SS x the output resolution; the
 * mask composites src-over onto the supersampled canvas ONCE per
 * fill/stroke, and one box-filter downsample at the end turns the
 * supersampling into anti-aliasing for every primitive uniformly. Routing
 * a shape through a mask (instead of blending pixels as they rasterize)
 * is what makes a translucent stroke correct: the quad+joint-dot+arrowhead
 * pieces of one path overlap freely, coverage is idempotent, and the
 * color blends exactly once per pixel.
 *
 * Smooth shapes (ellipse, rounded-rect corners) are flattened to
 * sagitta-bounded polylines, so strokes are constant-width by
 * construction (no inner/outer-ellipse width drift) and fills reuse the
 * one even-odd scanline polygon filler.
 *
 * Coordinates are floats in SUPERSAMPLED device space (the caller scales
 * logical -> fit-rect -> xSS); pixel centers sample at +0.5. */
#ifndef DECK_RASTER_H
#define DECK_RASTER_H

#include <stdint.h>

/* The supersample factor — the ONE constant the AA gate tuned (design §6
 * unknown #1). Gate result (Lane 1, 2026-07-24): 2x passes at natural
 * size but shallow thin diagonals keep a visible ~5-level edge ("ropey"
 * under zoom — marginal for on-camera video scaling); 4x (~17 levels) is
 * clean. Renders happen only on nav/resize/reload (the presenter parks
 * between states), so 4x is the default; deck's --ss flag overrides at
 * runtime for A/B shots and goldens. */
#define DECK_SS 4

typedef struct {            /* RGBA8, row-major, no row padding */
    int w, h;
    uint8_t *px;
} RCanvas;

typedef struct {            /* one shape's hard coverage + dirty bbox */
    int w, h;
    uint8_t *cov;
    int dx0, dy0, dx1, dy1; /* dirty rect, half-open; empty when dx0>=dx1 */
} RMask;

int  rc_init(RCanvas *c, int w, int h);
void rc_free(RCanvas *c);
void rc_clear(RCanvas *c, uint8_t r, uint8_t g, uint8_t b);

int  rm_init(RMask *m, int w, int h);
void rm_free(RMask *m);
void rm_reset(RMask *m);

/* Primitives (into the mask). Ellipse/rect take the bounding box. */
void rm_poly(RMask *m, float (*pts)[2], int n);      /* even-odd fill */
void rm_disc(RMask *m, float cx, float cy, float r);
void rm_fill_rrect(RMask *m, float x, float y, float w, float h, float rad);
void rm_stroke_rrect(RMask *m, float x, float y, float w, float h,
                     float rad, float sw);
void rm_fill_ellipse(RMask *m, float x, float y, float w, float h);
void rm_stroke_ellipse(RMask *m, float x, float y, float w, float h, float sw);

/* Open path: quads per segment + round joints; dash = {on, off} in device
 * px (NULL/<=0 = solid); arrowheads are filled triangles at the end
 * tangents, sized from `width`, always solid, shaft trimmed under them. */
void rm_stroke_path(RMask *m, float (*pts)[2], int n, float width,
                    const float *dash, int startArrow, int endArrow);

/* src-over the mask's coverage in one color (straight alpha). */
void rm_composite(RCanvas *c, const RMask *m,
                  uint8_t r, uint8_t g, uint8_t b, uint8_t a);

/* ss x ss box filter; dst must be exactly src/ss in both dims. */
void rc_downsample(RCanvas *dst, const RCanvas *src, int ss);

/* Bilinear-sampled src-over blit of the SOURCE RECT [sx,sy,sw,sh] (source
 * px; pass 0,0,iw,ih for the whole image) into the dest rect — the source
 * rect is what implements `fit: cover` as a true crop. */
void rc_blit_image(RCanvas *c, const uint8_t *rgba, int iw, int ih,
                   float sx, float sy, float sw, float sh,
                   float dx, float dy, float dw, float dh);

/* src-over an external coverage bitmap (a freetype glyph) in one color —
 * the post-downsample text compositor's pixel op. */
void rc_blend_cov(RCanvas *c, const uint8_t *cov, int cw, int ch,
                  int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a);

#endif /* DECK_RASTER_H */
