/*
 * This file is part of NetSurf, http://www.netsurf-browser.org/
 *
 * NetSurf is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; version 2 of the License.
 *
 * NetSurf is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

/**
 * \file
 * gucOS frontend: freetype text — the framebuffer frontend's
 * font_freetype.c ported onto the vendored freetype build.  The
 * vendored build has no FTC cache subsystem (srclib/ carries no
 * src/cache/), so the FTC manager/cmap/image caches are replaced by a
 * frontend-owned rendered-glyph cache with the same behaviour
 * (per-(face,size,codepoint) rendered bitmaps, byte-bounded by the
 * fb_font_cachesize option).
 */

#ifndef NETSURF_GUCOS_FONT_H
#define NETSURF_GUCOS_FONT_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

struct plot_font_style;

/**
 * A rendered glyph: the subset of FT_BitmapGlyph the plotters and
 * layout ops consume.  Owned by the glyph cache — valid until the
 * next gucos_getglyph call (a cache flush may reclaim it).
 */
typedef struct gucos_glyph {
	int advance_x;		/* horizontal advance, px */
	int left;		/* bitmap left bearing, px */
	int top;		/* bitmap top bearing, px (above baseline) */
	unsigned int width;	/* bitmap width, px */
	unsigned int rows;	/* bitmap height, px */
	int pitch;		/* bitmap row stride, bytes */
	bool mono;		/* true: 1bpp packed; false: 8bpp gray */
	uint8_t *bitmap;	/* rows*pitch bytes (NULL for empty glyphs) */
} gucos_glyph_t;

/** initialise freetype + the generic faces; false = fatal (no fonts) */
bool gucos_font_init(void);
void gucos_font_fini(void);

/** look up (render or fetch cached) the glyph for ucs4 in fstyle */
const gucos_glyph_t *gucos_getglyph(const struct plot_font_style *fstyle,
				    uint32_t ucs4);

extern struct gui_layout_table *gucos_layout_table;

#endif
