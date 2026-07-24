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
 * gucOS frontend: libnsfb 32bpp software plotters behind NetSurf's
 * 9-op plotter table.  Plots target an XBGR8888 RAM surface — the
 * byte layout (R,G,B,A) of the SDL3 veneer's RGBA32 window surfaces,
 * so presenting is a straight row blit (plus forcing the alpha byte
 * opaque, which netsurf colour values leave zero).
 */

#ifndef NETSURF_GUCOS_PLOT_H
#define NETSURF_GUCOS_PLOT_H

#include <libnsfb.h>

extern const struct plotter_table gucos_plotters;

/** create / resize / free an XBGR8888 RAM render target */
nsfb_t *gucos_fb_create(int width, int height);
bool gucos_fb_resize(nsfb_t *fb, int width, int height);
void gucos_fb_free(nsfb_t *fb);

/**
 * Retarget the plotters (browser windows own one surface each;
 * bitmap render swaps a temporary one in).  Returns the old target.
 */
nsfb_t *gucos_plot_set_target(nsfb_t *fb);

#endif
