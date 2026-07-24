/*
 * Copyright 2008 Vincent Sanders <vince@simtec.co.uk>
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

/**
 * \file
 * gucOS implementation of the generic bitmap interface (the
 * framebuffer frontend's bitmap.c: bitmaps ARE libnsfb RAM surfaces,
 * so plot_bitmap and thumbnail render reuse the nsfb copy/plot
 * machinery directly).
 */

#include <inttypes.h>
#include <sys/types.h>
#include <stdbool.h>
#include <assert.h>
#include <libnsfb.h>
#include <libnsfb_plot.h>

#include "utils/log.h"
#include "utils/utils.h"
#include "netsurf/bitmap.h"
#include "netsurf/plotters.h"
#include "netsurf/content.h"

#include "gucos/plot.h"
#include "gucos/bitmap.h"

/**
 * Create a bitmap.
 */
static void *bitmap_create(int width, int height, enum gui_bitmap_flags flags)
{
	nsfb_t *bm;

	bm = nsfb_new(NSFB_SURFACE_RAM);
	if (bm == NULL) {
		return NULL;
	}

	if ((flags & BITMAP_OPAQUE) == 0) {
		nsfb_set_geometry(bm, width, height, NSFB_FMT_ABGR8888);
	} else {
		nsfb_set_geometry(bm, width, height, NSFB_FMT_XBGR8888);
	}

	if (nsfb_init(bm) == -1) {
		nsfb_free(bm);
		return NULL;
	}

	return bm;
}

/**
 * Return a pointer to the pixel data in a bitmap.
 */
static unsigned char *bitmap_get_buffer(void *bitmap)
{
	nsfb_t *bm = bitmap;
	unsigned char *bmpptr;

	assert(bm != NULL);

	nsfb_get_buffer(bm, &bmpptr, NULL);

	return bmpptr;
}

/**
 * Find the width of a pixel row in bytes.
 */
static size_t bitmap_get_rowstride(void *bitmap)
{
	nsfb_t *bm = bitmap;
	int bmpstride;

	assert(bm != NULL);

	nsfb_get_buffer(bm, NULL, &bmpstride);

	return bmpstride;
}

/**
 * Free a bitmap.
 */
static void bitmap_destroy(void *bitmap)
{
	nsfb_t *bm = bitmap;

	assert(bm != NULL);

	nsfb_free(bm);
}

/**
 * The bitmap image has changed, so flush any persistant cache.
 */
static void bitmap_modified(void *bitmap)
{
}

/**
 * Sets whether a bitmap should be plotted opaque
 */
static void bitmap_set_opaque(void *bitmap, bool opaque)
{
	nsfb_t *bm = bitmap;

	assert(bm != NULL);

	if (opaque) {
		nsfb_set_geometry(bm, 0, 0, NSFB_FMT_XBGR8888);
	} else {
		nsfb_set_geometry(bm, 0, 0, NSFB_FMT_ABGR8888);
	}
}

/**
 * Gets whether a bitmap should be plotted opaque
 */
bool gucos_bitmap_get_opaque(void *bitmap)
{
	nsfb_t *bm = bitmap;
	enum nsfb_format_e format;

	assert(bm != NULL);

	nsfb_get_geometry(bm, NULL, NULL, &format);

	if (format == NSFB_FMT_ABGR8888)
		return false;

	return true;
}

static int bitmap_get_width(void *bitmap)
{
	nsfb_t *bm = bitmap;
	int width;

	assert(bm != NULL);

	nsfb_get_geometry(bm, &width, NULL, NULL);

	return width;
}

static int bitmap_get_height(void *bitmap)
{
	nsfb_t *bm = bitmap;
	int height;

	assert(bm != NULL);

	nsfb_get_geometry(bm, NULL, &height, NULL);

	return height;
}

/**
 * Render content into a bitmap (thumbnails for the url db / history).
 */
static nserror
bitmap_render(struct bitmap *bitmap, struct hlcache_handle *content)
{
	nsfb_t *tbm = (nsfb_t *)bitmap; /* target bitmap */
	nsfb_t *bm; /* temporary bitmap */
	nsfb_t *current; /* current plot target */
	int width, height; /* target bitmap width height */
	int cwidth, cheight;/* content width /height */
	nsfb_bbox_t loc;

	struct redraw_context ctx = {
		.interactive = false,
		.background_images = true,
		.plot = &gucos_plotters
	};

	nsfb_get_geometry(tbm, &width, &height, NULL);

	/* Calculate size of buffer to render the content into: the
	 * width from the largest of bitmap and content width capped at
	 * 1024 (no excessive render buffers for huge contents), height
	 * in proportion with the thumbnail aspect ratio. */
	cwidth = max(width, min(content_get_width(content), 1024));
	cheight = ((cwidth * height) + (width / 2)) / width;

	/* create temporary surface */
	bm = nsfb_new(NSFB_SURFACE_RAM);
	if (bm == NULL) {
		return NSERROR_NOMEM;
	}

	nsfb_set_geometry(bm, cwidth, cheight, NSFB_FMT_XBGR8888);

	if (nsfb_init(bm) == -1) {
		nsfb_free(bm);
		return NSERROR_NOMEM;
	}

	current = gucos_plot_set_target(bm);

	/* render the content into temporary surface */
	content_scaled_redraw(content, cwidth, cheight, &ctx);

	gucos_plot_set_target(current);

	loc.x0 = 0;
	loc.y0 = 0;
	loc.x1 = width;
	loc.y1 = height;

	nsfb_plot_copy(bm, NULL, tbm, &loc);

	nsfb_free(bm);

	return NSERROR_OK;
}

static struct gui_bitmap_table bitmap_table = {
	.create = bitmap_create,
	.destroy = bitmap_destroy,
	.set_opaque = bitmap_set_opaque,
	.get_opaque = gucos_bitmap_get_opaque,
	.get_buffer = bitmap_get_buffer,
	.get_rowstride = bitmap_get_rowstride,
	.get_width = bitmap_get_width,
	.get_height = bitmap_get_height,
	.modified = bitmap_modified,
	.render = bitmap_render,
};

struct gui_bitmap_table *gucos_bitmap_table = &bitmap_table;
