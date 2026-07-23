/* text.h — /bin/deck's text layer (todos/0284, design §1.3): the shared
 * fontcore.h glyph pipeline (todos/0277 — face 0 = baked Noto Sans Mono,
 * fallback chain, tofu) behind a greedy word-wrap + align/valign layout.
 *
 * Text renders at FINAL pixel size straight onto the 1x (post-downsample)
 * canvas — freetype coverage is already anti-aliased; supersampling
 * glyphs would only blur them (design §1.3). Consequence, documented as
 * v1 semantics: within a slide, text (and shape labels) composites ABOVE
 * all shapes/images; order among text elements still follows the array. */
#ifndef DECK_TEXT_H
#define DECK_TEXT_H

#include "model.h"
#include "raster.h"

/* FT init + fontchain config + eager face 0. A presenter that cannot
 * render text must fail AT LOAD, loudly (the ksvc discipline): < 0 means
 * no usable face. */
int dtext_init(void);

/* Lay out `utf8` in the box (device px), wrap by greedy word-wrap when
 * `wrap` (overlong single words hard-break at glyph granularity; text
 * never silently disappears), align/valign per the DALIGN/DVALIGN enums,
 * and composite onto the canvas. Overflow past the box stays VISIBLE — a
 * WYSIWYG tool shows the author their overflow instead of eating it. */
void dtext_draw(RCanvas *c, const char *utf8, int px,
                float bx, float by, float bw, float bh,
                int align, int valign, int wrap, DColor col);

#endif /* DECK_TEXT_H */
