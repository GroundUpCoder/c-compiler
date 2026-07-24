/*
 * Copyright 2008 Vincent Sanders <vince@simtec.co.uk>
 *
 * gucOS plotter interface (the framebuffer frontend's framebuffer.c,
 * retargeted: per-window RAM surfaces instead of one global nsfb, and
 * text through gucos/font.c's rendered-glyph cache).
 *
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
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include <libnsfb.h>
#include <libnsfb_plot.h>

#include "utils/utils.h"
#include "utils/log.h"
#include "utils/utf8.h"
#include "netsurf/browser_window.h"
#include "netsurf/plotters.h"
#include "netsurf/bitmap.h"

#include "gucos/plot.h"
#include "gucos/font.h"
#include "gucos/bitmap.h"

/** the current plot target (one per window; bitmap render swaps) */
static nsfb_t *nsfb;

nsfb_t *gucos_plot_set_target(nsfb_t *fb)
{
	nsfb_t *old = nsfb;
	nsfb = fb;
	return old;
}

nsfb_t *gucos_fb_create(int width, int height)
{
	nsfb_t *fb;

	fb = nsfb_new(NSFB_SURFACE_RAM);
	if (fb == NULL) {
		return NULL;
	}
	if (nsfb_set_geometry(fb, width, height, NSFB_FMT_XBGR8888) == -1) {
		nsfb_free(fb);
		return NULL;
	}
	if (nsfb_init(fb) == -1) {
		nsfb_free(fb);
		return NULL;
	}
	return fb;
}

bool gucos_fb_resize(nsfb_t *fb, int width, int height)
{
	return nsfb_set_geometry(fb, width, height, NSFB_FMT_XBGR8888) != -1;
}

void gucos_fb_free(nsfb_t *fb)
{
	nsfb_free(fb);
}

/**
 * \brief Sets a clip rectangle for subsequent plot operations.
 */
static nserror
gucos_plot_clip(const struct redraw_context *ctx, const struct rect *clip)
{
	nsfb_bbox_t nsfb_clip;
	nsfb_clip.x0 = clip->x0;
	nsfb_clip.y0 = clip->y0;
	nsfb_clip.x1 = clip->x1;
	nsfb_clip.y1 = clip->y1;

	if (!nsfb_plot_set_clip(nsfb, &nsfb_clip)) {
		return NSERROR_INVALID;
	}
	return NSERROR_OK;
}

/**
 * Plots an arc segment around (x,y), anticlockwise from angle1 to
 * angle2, measured anticlockwise from horizontal, in degrees.
 */
static nserror
gucos_plot_arc(const struct redraw_context *ctx,
	       const plot_style_t *style,
	       int x, int y, int radius, int angle1, int angle2)
{
	if (!nsfb_plot_arc(nsfb, x, y, radius, angle1, angle2,
			   style->fill_colour)) {
		return NSERROR_INVALID;
	}
	return NSERROR_OK;
}

/**
 * Plots a circle centered on (x,y), optionally filled.
 */
static nserror
gucos_plot_disc(const struct redraw_context *ctx,
		const plot_style_t *style,
		int x, int y, int radius)
{
	nsfb_bbox_t ellipse;
	ellipse.x0 = x - radius;
	ellipse.y0 = y - radius;
	ellipse.x1 = x + radius;
	ellipse.y1 = y + radius;

	if (style->fill_type != PLOT_OP_TYPE_NONE) {
		nsfb_plot_ellipse_fill(nsfb, &ellipse, style->fill_colour);
	}

	if (style->stroke_type != PLOT_OP_TYPE_NONE) {
		nsfb_plot_ellipse(nsfb, &ellipse, style->stroke_colour);
	}
	return NSERROR_OK;
}

/**
 * Plots a line from (x0,y0) to (x1,y1), coordinates at the centre of
 * the line width/thickness.
 */
static nserror
gucos_plot_line(const struct redraw_context *ctx,
		const plot_style_t *style,
		const struct rect *line)
{
	nsfb_bbox_t rect;
	nsfb_plot_pen_t pen;

	rect.x0 = line->x0;
	rect.y0 = line->y0;
	rect.x1 = line->x1;
	rect.y1 = line->y1;

	if (style->stroke_type != PLOT_OP_TYPE_NONE) {

		if (style->stroke_type == PLOT_OP_TYPE_DOT) {
			pen.stroke_type = NFSB_PLOT_OPTYPE_PATTERN;
			pen.stroke_pattern = 0xAAAAAAAA;
		} else if (style->stroke_type == PLOT_OP_TYPE_DASH) {
			pen.stroke_type = NFSB_PLOT_OPTYPE_PATTERN;
			pen.stroke_pattern = 0xF0F0F0F0;
		} else {
			pen.stroke_type = NFSB_PLOT_OPTYPE_SOLID;
		}

		pen.stroke_colour = style->stroke_colour;
		pen.stroke_width = plot_style_fixed_to_int(style->stroke_width);
		nsfb_plot_line(nsfb, &rect, &pen);
	}

	return NSERROR_OK;
}

/**
 * Plots a rectangle, filled and/or outlined per the plot style.
 */
static nserror
gucos_plot_rectangle(const struct redraw_context *ctx,
		     const plot_style_t *style,
		     const struct rect *nsrect)
{
	nsfb_bbox_t rect;
	bool dotted = false;
	bool dashed = false;

	rect.x0 = nsrect->x0;
	rect.y0 = nsrect->y0;
	rect.x1 = nsrect->x1;
	rect.y1 = nsrect->y1;

	if (style->fill_type != PLOT_OP_TYPE_NONE) {
		nsfb_plot_rectangle_fill(nsfb, &rect, style->fill_colour);
	}

	if (style->stroke_type != PLOT_OP_TYPE_NONE) {
		if (style->stroke_type == PLOT_OP_TYPE_DOT) {
			dotted = true;
		}

		if (style->stroke_type == PLOT_OP_TYPE_DASH) {
			dashed = true;
		}

		nsfb_plot_rectangle(nsfb, &rect,
				plot_style_fixed_to_int(style->stroke_width),
				style->stroke_colour, dotted, dashed);
	}
	return NSERROR_OK;
}

/**
 * Plot a filled polygon with straight lines between points, using the
 * non-zero winding rule.
 */
static nserror
gucos_plot_polygon(const struct redraw_context *ctx,
		   const plot_style_t *style,
		   const int *p,
		   unsigned int n)
{
	if (!nsfb_plot_polygon(nsfb, p, n, style->fill_colour)) {
		return NSERROR_INVALID;
	}
	return NSERROR_OK;
}

/**
 * Plots a path of cubic Bezier curves.
 *
 * libnsfb has no bezier-path rasteriser; upstream's framebuffer
 * frontend leaves this unimplemented too (no SVG handler is built, so
 * nothing emits paths in this configuration).
 */
static nserror
gucos_plot_path(const struct redraw_context *ctx,
		const plot_style_t *pstyle,
		const float *p,
		unsigned int n,
		const float transform[6])
{
	NSLOG(netsurf, INFO, "path unimplemented");
	return NSERROR_OK;
}

/**
 * Tiled plot of a bitmap image (upstream framebuffer logic verbatim).
 */
static nserror
gucos_plot_bitmap(const struct redraw_context *ctx,
		  struct bitmap *bitmap,
		  int x, int y,
		  int width,
		  int height,
		  colour bg,
		  bitmap_flags_t flags)
{
	nsfb_bbox_t loc;
	nsfb_bbox_t clipbox;
	bool repeat_x = (flags & BITMAPF_REPEAT_X);
	bool repeat_y = (flags & BITMAPF_REPEAT_Y);
	int bmwidth;
	int bmheight;
	int bmstride;
	enum nsfb_format_e bmformat;
	unsigned char *bmptr;
	nsfb_t *bm = (nsfb_t *)bitmap;

	/* x and y define the coordinate of the top left of the initial
	 * explicitly placed tile.  width/height are the image scaling
	 * and the bounding box defines the extent of the repeat. */

	if (!(repeat_x || repeat_y)) {
		/* Not repeating at all, so just plot it */
		loc.x0 = x;
		loc.y0 = y;
		loc.x1 = loc.x0 + width;
		loc.y1 = loc.y0 + height;

		if (!nsfb_plot_copy(bm, NULL, nsfb, &loc)) {
			return NSERROR_INVALID;
		}
		return NSERROR_OK;
	}

	nsfb_plot_get_clip(nsfb, &clipbox);
	nsfb_get_geometry(bm, &bmwidth, &bmheight, &bmformat);
	nsfb_get_buffer(bm, &bmptr, &bmstride);

	/* Optimise tiled plots of 1x1 bitmaps by replacing with a flat
	 * fill of the area.  Can only be done when image is fully
	 * opaque. */
	if ((bmwidth == 1) && (bmheight == 1)) {
		if ((*(nsfb_colour_t *)(void *)bmptr & 0xff000000) != 0) {
			if (!nsfb_plot_rectangle_fill(nsfb, &clipbox,
					*(nsfb_colour_t *)(void *)bmptr)) {
				return NSERROR_INVALID;
			}
			return NSERROR_OK;
		}
	}

	/* Optimise tiled plots of bitmaps scaled to 1x1 by replacing
	 * with a flat fill of the area.  Can only be done when image
	 * is fully opaque. */
	if ((width == 1) && (height == 1)) {
		if (gucos_bitmap_get_opaque(bm)) {
			if (!nsfb_plot_rectangle_fill(nsfb, &clipbox,
					*(nsfb_colour_t *)(void *)bmptr)) {
				return NSERROR_INVALID;
			}
			return NSERROR_OK;
		}
	}

	/* get left most tile position */
	if (repeat_x) {
		for (; x > clipbox.x0; x -= width);
	}

	/* get top most tile position */
	if (repeat_y) {
		for (; y > clipbox.y0; y -= height);
	}

	/* set up top left tile location */
	loc.x0 = x;
	loc.y0 = y;
	loc.x1 = loc.x0 + width;
	loc.y1 = loc.y0 + height;

	/* plot tiling across and down to extents */
	nsfb_plot_bitmap_tiles(nsfb, &loc,
			repeat_x ? ((clipbox.x1 - x) + width  - 1) / width  : 1,
			repeat_y ? ((clipbox.y1 - y) + height - 1) / height : 1,
			(nsfb_colour_t *)(void *)bmptr, bmwidth, bmheight,
			bmstride * 8 / 32, bmformat == NSFB_FMT_ABGR8888);

	return NSERROR_OK;
}

/**
 * Text plotting (upstream's FB_USE_FREETYPE path over the gucos glyph
 * cache).
 */
static nserror
gucos_plot_text(const struct redraw_context *ctx,
		const struct plot_font_style *fstyle,
		int x,
		int y,
		const char *text,
		size_t length)
{
	uint32_t ucs4;
	size_t nxtchr = 0;
	const gucos_glyph_t *glyph;
	nsfb_bbox_t loc;

	while (nxtchr < length) {
		ucs4 = utf8_to_ucs4(text + nxtchr, length - nxtchr);
		nxtchr = utf8_next(text, length, nxtchr);

		glyph = gucos_getglyph(fstyle, ucs4);
		if (glyph == NULL)
			continue;

		if (glyph->bitmap != NULL) {
			loc.x0 = x + glyph->left;
			loc.y0 = y - glyph->top;
			loc.x1 = loc.x0 + glyph->width;
			loc.y1 = loc.y0 + glyph->rows;

			if (glyph->mono) {
				nsfb_plot_glyph1(nsfb, &loc,
						 glyph->bitmap,
						 glyph->pitch,
						 fstyle->foreground);
			} else {
				nsfb_plot_glyph8(nsfb, &loc,
						 glyph->bitmap,
						 glyph->pitch,
						 fstyle->foreground);
			}
		}
		x += glyph->advance_x;
	}
	return NSERROR_OK;
}

/** gucOS plot operation table */
const struct plotter_table gucos_plotters = {
	.clip = gucos_plot_clip,
	.arc = gucos_plot_arc,
	.disc = gucos_plot_disc,
	.line = gucos_plot_line,
	.rectangle = gucos_plot_rectangle,
	.polygon = gucos_plot_polygon,
	.path = gucos_plot_path,
	.bitmap = gucos_plot_bitmap,
	.text = gucos_plot_text,
	.option_knockout = true,
};
