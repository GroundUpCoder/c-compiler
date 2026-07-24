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
 * gucOS frontend: the gui_window — one SDL window (one kernel shm
 * surface) per browsing context, CPU-rendered by libnsfb's 32bpp
 * software plotters into a window-sized RAM surface that is blitted
 * to the SDL window surface on present.
 */

#ifndef NETSURF_GUCOS_GUI_H
#define NETSURF_GUCOS_GUI_H

#include <stdbool.h>

#include <SDL.h>
#include <libnsfb.h>

#include "netsurf/mouse.h"

struct browser_window;
struct rect;

struct gui_window {
	struct gui_window *next;
	struct browser_window *bw;

	SDL_Window *win;
	SDL_Surface *surf;	/* re-fetched after every RESIZED event */
	SDL_WindowID wid;

	nsfb_t *fb;		/* XBGR8888 render target, window-sized */

	int scrollx, scrolly;	/* window origin in content coords */

	/* accumulated damage, window coords (x1/y1 exclusive) */
	bool dirty;
	nsfb_bbox_t dirty_box;

	/* text caret (drawn over the redraw, fb-frontend style) */
	bool caret_on;
	int caret_x, caret_y, caret_h;	/* content coords */

	/* pointer button state machine */
	browser_mouse_state mouse_pressed;	/* PRESS_1 / PRESS_2 / 0 */
	int press_x, press_y;			/* content coords of press */
	bool dragging;

	bool throbbing;
};

/** resource search path vector (fetch.c get_resource_url, fonts) */
extern char **respaths;

/** set once the last browser window is destroyed / QUIT arrives */
extern bool gucos_done;

extern struct gui_window_table *gucos_window_table;

struct gui_window *gucos_window_from_id(SDL_WindowID id);
struct gui_window *gucos_window_list(void);

/** union a window-coord rect into the window's damage box */
void gucos_damage(struct gui_window *gw, int x0, int y0, int x1, int y1);

/** drain the SDL event queue into browser core events */
void gucos_process_events(void);

/** redraw + present every window with pending damage */
void gucos_redraw_all(void);

#endif
