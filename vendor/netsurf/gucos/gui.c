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
 * gucOS frontend gui_window implementation.
 *
 * One SDL window (one kernel shm surface) per browsing context.  The
 * content renders through libnsfb's 32bpp software plotters into a
 * window-sized XBGR8888 RAM surface; presenting blits the damaged
 * rows into the SDL window surface (forcing the alpha byte opaque —
 * netsurf colours leave it zero) and calls SDL_UpdateWindowSurface,
 * which is also what acknowledges a drag-resize configure to the
 * kernel.  Input arrives on the SDL event queue (the kernel input
 * ring) and maps to browser_window_* core calls; the window is
 * created SDL_WINDOW_RESIZABLE and reformats on every RESIZED event.
 *
 * The bottom STATUS_H rows are the status bar (gui_window_set_status:
 * loading progress / the hovered link URL) — the only chrome; the
 * content viewport is the window minus that strip.  Alt+Left /
 * Alt+Right (and unclaimed Backspace) walk the local history.
 *
 * The page console (gui_window_console_log) writes to stderr, which is
 * the shell's tty when the browser runs as `netsurf page.html &`.
 */

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

#include <SDL.h>
#include <libnsfb.h>
#include <libnsfb_plot.h>

#include "utils/log.h"
#include "utils/utils.h"
#include "utils/nsoption.h"
#include "utils/nsurl.h"
#include "netsurf/browser_window.h"
#include "netsurf/plotters.h"
#include "netsurf/plot_style.h"
#include "netsurf/window.h"
#include "netsurf/keypress.h"
#include "netsurf/content.h"
#include "desktop/browser_history.h"

#include "gucos/gui.h"
#include "gucos/plot.h"

/** window fallback geometry (the core window_width/height options win) */
#define GUCOS_DEFAULT_WIDTH 800
#define GUCOS_DEFAULT_HEIGHT 600

/** movement past this many px turns a press into a drag */
#define DRAG_SLOP 5

/** scroll step for wheel ticks and arrow keys, px */
#define SCROLL_STEP 100

/** status bar height, px (content viewport = window minus this strip) */
#define STATUS_H 18

/** status bar text inset, px */
#define STATUS_PAD 4

static struct gui_window *window_list;

/** height of the content viewport (the window minus the status bar) */
static int gucos_content_h(const struct gui_window *gw)
{
	return (gw->surf->h > STATUS_H) ? (gw->surf->h - STATUS_H) : 0;
}

bool gucos_done;

struct gui_window *gucos_window_list(void)
{
	return window_list;
}

struct gui_window *gucos_window_from_id(SDL_WindowID id)
{
	struct gui_window *gw;
	for (gw = window_list; gw != NULL; gw = gw->next) {
		if (gw->wid == id) {
			return gw;
		}
	}
	return NULL;
}

/* exported interface documented in gucos/gui.h */
void gucos_damage(struct gui_window *gw, int x0, int y0, int x1, int y1)
{
	if (x0 < 0) x0 = 0;
	if (y0 < 0) y0 = 0;
	if (x1 > gw->surf->w) x1 = gw->surf->w;
	if (y1 > gw->surf->h) y1 = gw->surf->h;
	if ((x0 >= x1) || (y0 >= y1)) {
		return;
	}

	if (!gw->dirty) {
		gw->dirty = true;
		gw->dirty_box.x0 = x0;
		gw->dirty_box.y0 = y0;
		gw->dirty_box.x1 = x1;
		gw->dirty_box.y1 = y1;
	} else {
		if (x0 < gw->dirty_box.x0) gw->dirty_box.x0 = x0;
		if (y0 < gw->dirty_box.y0) gw->dirty_box.y0 = y0;
		if (x1 > gw->dirty_box.x1) gw->dirty_box.x1 = x1;
		if (y1 > gw->dirty_box.y1) gw->dirty_box.y1 = y1;
	}
}

static void gucos_damage_all(struct gui_window *gw)
{
	gucos_damage(gw, 0, 0, gw->surf->w, gw->surf->h);
}

/* ---------------------------------------------------------------- */
/* scrolling                                                        */
/* ---------------------------------------------------------------- */

/** move the viewport origin, clamped to the content extents */
static void gucos_scroll_to(struct gui_window *gw, int sx, int sy)
{
	int cw = 0, ch = 0;

	if (browser_window_get_extents(gw->bw, true, &cw, &ch) != NSERROR_OK) {
		cw = ch = 0;
	}

	if (sx > cw - gw->surf->w) sx = cw - gw->surf->w;
	if (sy > ch - gucos_content_h(gw)) sy = ch - gucos_content_h(gw);
	if (sx < 0) sx = 0;
	if (sy < 0) sy = 0;

	if ((sx != gw->scrollx) || (sy != gw->scrolly)) {
		gw->scrollx = sx;
		gw->scrolly = sy;
		gucos_damage_all(gw);
	}
}

/* ---------------------------------------------------------------- */
/* redraw + present                                                 */
/* ---------------------------------------------------------------- */

/**
 * Blit a damaged region of the render surface into the SDL window
 * surface, forcing the alpha byte opaque, and present it.
 */
static void gucos_present(struct gui_window *gw, const nsfb_bbox_t *box)
{
	uint8_t *fbptr;
	int fbstride;
	int y, x;
	int w;

	nsfb_get_buffer(gw->fb, &fbptr, &fbstride);

	w = box->x1 - box->x0;
	for (y = box->y0; y < box->y1; y++) {
		const uint32_t *src = (const uint32_t *)
			(void *)(fbptr + y * fbstride) + box->x0;
		uint32_t *dst = (uint32_t *)
			(void *)((uint8_t *)gw->surf->pixels +
				 y * gw->surf->pitch) + box->x0;
		for (x = 0; x < w; x++) {
			dst[x] = src[x] | 0xFF000000u;
		}
	}

	SDL_UpdateWindowSurface(gw->win);
}

/**
 * Paint the status bar strip (below the content viewport) into the
 * render surface: silver ground, hairline top edge, the status text.
 * The plot target must already be gw->fb.
 */
static void gucos_draw_status(struct gui_window *gw)
{
	int ch = gucos_content_h(gw);
	nsfb_bbox_t bar = { 0, ch, gw->surf->w, gw->surf->h };
	nsfb_bbox_t edge = { 0, ch, gw->surf->w, ch + 1 };

	nsfb_plot_set_clip(gw->fb, &bar);
	nsfb_plot_rectangle_fill(gw->fb, &bar, 0xFFC0C0C0);
	nsfb_plot_rectangle_fill(gw->fb, &edge, 0xFF808080);

	if ((gw->status != NULL) && (gw->status[0] != '\0')) {
		struct redraw_context ctx = {
			.interactive = true,
			.plot = &gucos_plotters,
		};
		plot_font_style_t fstyle = {
			.family = PLOT_FONT_FAMILY_SANS_SERIF,
			.size = 11 * PLOT_STYLE_SCALE,
			.weight = 400,
			.foreground = 0xFF000000,
			.background = 0xFFC0C0C0,
		};
		nsfb_bbox_t tclip = { STATUS_PAD, ch + 1,
				      gw->surf->w - STATUS_PAD, gw->surf->h };

		nsfb_plot_set_clip(gw->fb, &tclip);
		gucos_plotters.text(&ctx, &fstyle,
				    STATUS_PAD, gw->surf->h - 5,
				    gw->status, strlen(gw->status));
	}
}

/** redraw the damaged region of one window and present it */
static void gucos_redraw_window(struct gui_window *gw)
{
	struct rect clip;
	nsfb_bbox_t box;
	nsfb_t *prev;
	int content_h = gucos_content_h(gw);
	struct redraw_context ctx = {
		.interactive = true,
		.background_images = true,
		.plot = &gucos_plotters,
	};

	box = gw->dirty_box;
	gw->dirty = false;

	/* content redraw is clipped to the viewport above the bar */
	clip.x0 = box.x0;
	clip.y0 = box.y0;
	clip.x1 = box.x1;
	clip.y1 = (box.y1 < content_h) ? box.y1 : content_h;

	prev = gucos_plot_set_target(gw->fb);

	nsfb_claim(gw->fb, &box);

	if ((clip.x0 < clip.x1) && (clip.y0 < clip.y1)) {
		browser_window_redraw(gw->bw,
				      -gw->scrollx,
				      -gw->scrolly,
				      &clip, &ctx);
	}

	if (gw->caret_on) {
		/* draw the caret over the redraw (fb frontend style) */
		nsfb_bbox_t line;
		nsfb_plot_pen_t pen;

		line.x0 = gw->caret_x - gw->scrollx;
		line.y0 = gw->caret_y - gw->scrolly;
		line.x1 = line.x0;
		line.y1 = line.y0 + gw->caret_h;

		pen.stroke_type = NFSB_PLOT_OPTYPE_SOLID;
		pen.stroke_width = 1;
		pen.stroke_colour = 0xFF0000FF;

		nsfb_plot_line(gw->fb, &line, &pen);
	}

	if (box.y1 > content_h) {
		gucos_draw_status(gw);
	}

	nsfb_update(gw->fb, &box);

	gucos_plot_set_target(prev);

	gucos_present(gw, &box);
}

/* exported interface documented in gucos/gui.h */
void gucos_redraw_all(void)
{
	struct gui_window *gw;

	for (gw = window_list; gw != NULL; gw = gw->next) {
		if (gw->dirty) {
			gucos_redraw_window(gw);
		}
	}
}

/* ---------------------------------------------------------------- */
/* the gui_window table                                             */
/* ---------------------------------------------------------------- */

static struct gui_window *
gui_window_create(struct browser_window *bw,
		  struct gui_window *existing,
		  gui_window_create_flags flags)
{
	struct gui_window *gw;
	int width, height;

	/* every create is a top-level window (GW_CREATE_TAB gets a
	 * window too — gucOS has no tab strip) */
	gw = calloc(1, sizeof(struct gui_window));
	if (gw == NULL) {
		return NULL;
	}

	width = nsoption_int(window_width);
	height = nsoption_int(window_height);
	if (width <= 0) width = GUCOS_DEFAULT_WIDTH;
	if (height <= 0) height = GUCOS_DEFAULT_HEIGHT;

	gw->win = SDL_CreateWindow("NetSurf", width, height,
				   SDL_WINDOW_RESIZABLE);
	if (gw->win == NULL) {
		free(gw);
		return NULL;
	}
	gw->surf = SDL_GetWindowSurface(gw->win);
	gw->wid = SDL_GetWindowID(gw->win);

	gw->fb = gucos_fb_create(gw->surf->w, gw->surf->h);
	if (gw->fb == NULL) {
		SDL_DestroyWindow(gw->win);
		free(gw);
		return NULL;
	}

	gw->bw = bw;

	gw->next = window_list;
	window_list = gw;

	gucos_damage_all(gw);

	return gw;
}

static void gui_window_destroy(struct gui_window *gw)
{
	struct gui_window **link;

	for (link = &window_list; *link != NULL; link = &(*link)->next) {
		if (*link == gw) {
			*link = gw->next;
			break;
		}
	}

	gucos_fb_free(gw->fb);
	SDL_DestroyWindow(gw->win);
	free(gw->status);
	free(gw);

	if (window_list == NULL) {
		gucos_done = true;
	}
}

/**
 * Invalidate an area of the window (content coordinates; NULL = all).
 */
static nserror
gucos_window_invalidate_area(struct gui_window *gw, const struct rect *rect)
{
	if (rect != NULL) {
		gucos_damage(gw,
			     rect->x0 - gw->scrollx,
			     rect->y0 - gw->scrolly,
			     rect->x1 - gw->scrollx,
			     rect->y1 - gw->scrolly);
	} else {
		gucos_damage_all(gw);
	}
	return NSERROR_OK;
}

static bool gui_window_get_scroll(struct gui_window *gw, int *sx, int *sy)
{
	*sx = gw->scrollx;
	*sy = gw->scrolly;
	return true;
}

static nserror
gui_window_set_scroll(struct gui_window *gw, const struct rect *rect)
{
	gucos_scroll_to(gw, rect->x0, rect->y0);
	return NSERROR_OK;
}

static nserror
gui_window_get_dimensions(struct gui_window *gw, int *width, int *height)
{
	*width = gw->surf->w;
	*height = gucos_content_h(gw);
	return NSERROR_OK;
}

static nserror
gui_window_event(struct gui_window *gw, enum gui_window_event event)
{
	switch (event) {
	case GW_EVENT_UPDATE_EXTENT:
		/* content extents changed: re-clamp the viewport */
		gucos_scroll_to(gw, gw->scrollx, gw->scrolly);
		break;

	case GW_EVENT_REMOVE_CARET:
		if (gw->caret_on) {
			gw->caret_on = false;
			gucos_damage(gw,
				     gw->caret_x - gw->scrollx,
				     gw->caret_y - gw->scrolly,
				     gw->caret_x - gw->scrollx + 1,
				     gw->caret_y + gw->caret_h - gw->scrolly);
		}
		break;

	case GW_EVENT_NEW_CONTENT:
		gw->scrollx = 0;
		gw->scrolly = 0;
		gucos_damage_all(gw);
		break;

	case GW_EVENT_START_THROBBER:
		gw->throbbing = true;
		break;

	case GW_EVENT_STOP_THROBBER:
		gw->throbbing = false;
		break;

	default:
		break;
	}
	return NSERROR_OK;
}

static void gui_window_set_title(struct gui_window *gw, const char *title)
{
	SDL_SetWindowTitle(gw->win,
			   ((title != NULL) && (title[0] != '\0')) ?
			   title : "NetSurf");
}

static void gui_window_set_status(struct gui_window *gw, const char *text)
{
	if (text == NULL) {
		text = "";
	}
	if ((gw->status != NULL) && (strcmp(gw->status, text) == 0)) {
		return;
	}

	free(gw->status);
	gw->status = strdup(text);

	gucos_damage(gw, 0, gucos_content_h(gw), gw->surf->w, gw->surf->h);
}

static void
gui_window_set_pointer(struct gui_window *gw, enum gui_pointer_shape shape)
{
	static SDL_Cursor *cursors[SDL_SYSTEM_CURSOR_COUNT];
	SDL_SystemCursor id;

	switch (shape) {
	case GUI_POINTER_POINT:
		id = SDL_SYSTEM_CURSOR_POINTER;
		break;
	case GUI_POINTER_CARET:
		id = SDL_SYSTEM_CURSOR_TEXT;
		break;
	case GUI_POINTER_CROSS:
		id = SDL_SYSTEM_CURSOR_CROSSHAIR;
		break;
	case GUI_POINTER_MOVE:
		id = SDL_SYSTEM_CURSOR_MOVE;
		break;
	case GUI_POINTER_WAIT:
	case GUI_POINTER_PROGRESS:
		id = SDL_SYSTEM_CURSOR_PROGRESS;
		break;
	case GUI_POINTER_NO_DROP:
	case GUI_POINTER_NOT_ALLOWED:
		id = SDL_SYSTEM_CURSOR_NOT_ALLOWED;
		break;
	case GUI_POINTER_UP:
	case GUI_POINTER_DOWN:
		id = SDL_SYSTEM_CURSOR_NS_RESIZE;
		break;
	case GUI_POINTER_LEFT:
	case GUI_POINTER_RIGHT:
		id = SDL_SYSTEM_CURSOR_EW_RESIZE;
		break;
	case GUI_POINTER_RU:
	case GUI_POINTER_LD:
		id = SDL_SYSTEM_CURSOR_NESW_RESIZE;
		break;
	case GUI_POINTER_LU:
	case GUI_POINTER_RD:
		id = SDL_SYSTEM_CURSOR_NWSE_RESIZE;
		break;
	default:
		id = SDL_SYSTEM_CURSOR_DEFAULT;
		break;
	}

	if (cursors[id] == NULL) {
		cursors[id] = SDL_CreateSystemCursor(id);
	}
	if (cursors[id] != NULL) {
		SDL_SetCursor(cursors[id]);
	}
}

static void
gui_window_place_caret(struct gui_window *gw, int x, int y, int height,
		       const struct rect *clip)
{
	/* damage the old location */
	if (gw->caret_on) {
		gucos_damage(gw,
			     gw->caret_x - gw->scrollx,
			     gw->caret_y - gw->scrolly,
			     gw->caret_x - gw->scrollx + 1,
			     gw->caret_y + gw->caret_h - gw->scrolly);
	}

	gw->caret_on = true;
	gw->caret_x = x;
	gw->caret_y = y;
	gw->caret_h = height;

	gucos_damage(gw,
		     x - gw->scrollx, y - gw->scrolly,
		     x - gw->scrollx + 1, y + height - gw->scrolly);
}

/* ---------------------------------------------------------------- */
/* the page console                                                 */
/* ---------------------------------------------------------------- */

/**
 * Report one console entry on stderr — the shell's tty when the browser
 * runs as `netsurf page.html &`.
 *
 * This is the ONLY channel a page author inside gucOS has.  NSLOG is not
 * one: it compiles at INFO, it says nothing at all without the `-v` first
 * argument, and under `-v` it is every category at once.  So the console
 * is deliberately always on.  `2>/dev/null` is the off-switch and it
 * costs no option surface.
 *
 * The line is `js: SOURCE: LEVEL: TEXT`.  Both classifications are on the
 * line because both change what the reader does: the LEVEL is the page's
 * own severity (console.warn against console.log), and the SOURCE says
 * who spoke — the page's console, an uncaught exception, or the client.
 *
 * The text is counted, not NUL terminated, and it may hold newlines (the
 * core sets BW_CS_FLAG_FOLDABLE when it does; a stack trace is the usual
 * case).  Every line therefore carries the full prefix.  One grep finds
 * all of a multi-line entry, and no continuation line can pass for the
 * page's own output on the same tty.
 *
 * The entry is not tagged with its window.  gucOS makes one window per
 * browsing context, and this seam has no window name the reader can
 * correlate: the SDL window id is not the kernel surface id that `wmctl
 * list` prints, and the title is unbounded and changes under the page.
 * A tag that cannot be matched to a window is noise, so there is none.
 */
static void
gui_window_console_log(struct gui_window *gw,
		       browser_window_console_source src,
		       const char *msg,
		       size_t msglen,
		       browser_window_console_flags flags)
{
	const char *src_text;
	const char *level_text;
	size_t pos = 0;

	(void) gw;

	switch (src) {
	case BW_CS_INPUT:
		src_text = "input";
		break;
	case BW_CS_SCRIPT_ERROR:
		src_text = "exception";
		break;
	case BW_CS_SCRIPT_CONSOLE:
		src_text = "console";
		break;
	default:
		src_text = "unknown";
		break;
	}

	switch (flags & BW_CS_FLAG_LEVEL_MASK) {
	case BW_CS_FLAG_LEVEL_DEBUG:
		level_text = "debug";
		break;
	case BW_CS_FLAG_LEVEL_LOG:
		level_text = "log";
		break;
	case BW_CS_FLAG_LEVEL_INFO:
		level_text = "info";
		break;
	case BW_CS_FLAG_LEVEL_WARN:
		level_text = "warn";
		break;
	case BW_CS_FLAG_LEVEL_ERROR:
		level_text = "error";
		break;
	default:
		level_text = "unknown";
		break;
	}

	/* one trailing newline ends the writer's last line; it does not
	 * add an empty one */
	if ((msglen > 0) && (msg[msglen - 1] == '\n')) {
		msglen--;
	}

	do {
		size_t end = pos;
		size_t stop;

		while ((end < msglen) && (msg[end] != '\n')) {
			end++;
		}

		/* a CRLF text must not drive the terminal's carriage back
		 * over the line it just wrote */
		stop = end;
		if ((stop > pos) && (msg[stop - 1] == '\r')) {
			stop--;
		}

		fprintf(stderr, "js: %s: %s: ", src_text, level_text);
		if (stop > pos) {
			fwrite(msg + pos, 1, stop - pos, stderr);
		}
		fputc('\n', stderr);

		pos = end + 1;
	} while (pos <= msglen);

	/* the reader is watching a live tty: do not hold the entry in a
	 * buffer until the browser exits */
	fflush(stderr);
}

static struct gui_window_table window_table = {
	.create = gui_window_create,
	.destroy = gui_window_destroy,
	.invalidate = gucos_window_invalidate_area,
	.get_scroll = gui_window_get_scroll,
	.set_scroll = gui_window_set_scroll,
	.get_dimensions = gui_window_get_dimensions,
	.event = gui_window_event,

	.set_title = gui_window_set_title,
	.set_status = gui_window_set_status,
	.set_pointer = gui_window_set_pointer,
	.place_caret = gui_window_place_caret,

	/* Only BW_CS_SCRIPT_CONSOLE ever arrives here today.  Nothing in
	 * the tree emits BW_CS_SCRIPT_ERROR, so an uncaught exception
	 * reaches no tty and no log: dukky reports its four error sites
	 * itself, three at NSLOG DEBUG (compiled out at the INFO build
	 * level) and one at WARNING (silent without `-v`).  Routing them
	 * through this table is todos/0424 — it belongs at dukky's error
	 * sites, in the vendored upstream tree. */
	.console_log = gui_window_console_log,
};

struct gui_window_table *gucos_window_table = &window_table;

/* ---------------------------------------------------------------- */
/* input                                                            */
/* ---------------------------------------------------------------- */

/** current modifier-independent mouse state for track calls */
static browser_mouse_state gucos_mouse_state(struct gui_window *gw)
{
	browser_mouse_state st = 0;

	if (gw->dragging) {
		st |= BROWSER_MOUSE_DRAG_ON;
		if (gw->mouse_pressed & BROWSER_MOUSE_PRESS_1) {
			st |= BROWSER_MOUSE_HOLDING_1;
		}
		if (gw->mouse_pressed & BROWSER_MOUSE_PRESS_2) {
			st |= BROWSER_MOUSE_HOLDING_2;
		}
	}
	return st;
}

static void
gucos_mouse_motion(struct gui_window *gw, const SDL_MouseMotionEvent *m)
{
	int my = (int)m->y;
	int cx, cy;

	/* the status bar is chrome: clamp motion to the viewport */
	if (my >= gucos_content_h(gw)) {
		my = gucos_content_h(gw) - 1;
		if (my < 0) {
			return;
		}
	}
	cx = (int)m->x + gw->scrollx;
	cy = my + gw->scrolly;

	if ((gw->mouse_pressed != 0) && !gw->dragging &&
	    ((abs(cx - gw->press_x) > DRAG_SLOP) ||
	     (abs(cy - gw->press_y) > DRAG_SLOP))) {
		/* the press became a drag: tell the core where the
		 * drag started (selection anchors there) */
		browser_window_mouse_click(gw->bw,
			(gw->mouse_pressed & BROWSER_MOUSE_PRESS_1) ?
				BROWSER_MOUSE_DRAG_1 : BROWSER_MOUSE_DRAG_2,
			gw->press_x, gw->press_y);
		gw->dragging = true;
	}

	browser_window_mouse_track(gw->bw, gucos_mouse_state(gw), cx, cy);
}

static void
gucos_mouse_button(struct gui_window *gw, const SDL_MouseButtonEvent *b)
{
	int cx = (int)b->x + gw->scrollx;
	int cy = (int)b->y + gw->scrolly;
	browser_mouse_state mouse;

	if ((b->button != SDL_BUTTON_LEFT) &&
	    (b->button != SDL_BUTTON_RIGHT)) {
		return;
	}

	/* presses on the status bar are chrome, not content (releases
	 * still flow so an in-content drag can end anywhere) */
	if (b->down && ((int)b->y >= gucos_content_h(gw))) {
		return;
	}

	if (b->down) {
		mouse = (b->button == SDL_BUTTON_LEFT) ?
			BROWSER_MOUSE_PRESS_1 : BROWSER_MOUSE_PRESS_2;
		gw->mouse_pressed = mouse;
		gw->press_x = cx;
		gw->press_y = cy;
		gw->dragging = false;
		browser_window_mouse_click(gw->bw, mouse, cx, cy);
		return;
	}

	/* release */
	if (gw->dragging) {
		/* end of drag: no click */
		browser_window_mouse_track(gw->bw, 0, cx, cy);
	} else if (gw->mouse_pressed != 0) {
		mouse = (b->button == SDL_BUTTON_LEFT) ?
			BROWSER_MOUSE_CLICK_1 : BROWSER_MOUSE_CLICK_2;
		if (b->clicks == 2) {
			mouse |= BROWSER_MOUSE_DOUBLE_CLICK;
		} else if (b->clicks >= 3) {
			mouse |= BROWSER_MOUSE_TRIPLE_CLICK;
		}
		browser_window_mouse_click(gw->bw, mouse, cx, cy);
	}
	gw->mouse_pressed = 0;
	gw->dragging = false;
}

static void
gucos_mouse_wheel(struct gui_window *gw, const SDL_MouseWheelEvent *w)
{
	int dx = (int)(-w->x * SCROLL_STEP);
	int dy = (int)(-w->y * SCROLL_STEP);
	int my = (int)w->mouse_y;
	int cx, cy;

	/* a wheel over the status bar scrolls the viewport proper */
	if (my >= gucos_content_h(gw)) {
		my = gucos_content_h(gw) - 1;
		if (my < 0) {
			return;
		}
	}
	cx = (int)w->mouse_x + gw->scrollx;
	cy = my + gw->scrolly;

	if ((dx == 0) && (dy == 0)) {
		return;
	}

	/* inner scrollable elements (frames, textareas, overflow
	 * boxes) get first claim on the wheel */
	if (browser_window_scroll_at_point(gw->bw, cx, cy, dx, dy) == false) {
		gucos_scroll_to(gw, gw->scrollx + dx, gw->scrolly + dy);
	}
}

/**
 * Map an SDL keycode to the core's NS_KEY_* / UCS4 value.
 *
 * Shared by the press and release paths so `keyup` reports exactly the
 * same `event.key` as `keydown` did — a keyup whose name disagreed with
 * its keydown would be worse than no keyup at all.
 *
 * \return 0 if the key has no core representation
 */
static uint32_t gucos_nskey(uint32_t key, uint16_t mod)
{
	switch (key) {
	case SDLK_BACKSPACE: return NS_KEY_DELETE_LEFT;
	case SDLK_TAB:
		return (mod & SDL_KMOD_SHIFT) ? NS_KEY_SHIFT_TAB : NS_KEY_TAB;
	case SDLK_RETURN: return NS_KEY_NL;
	case SDLK_ESCAPE: return NS_KEY_ESCAPE;
	case SDLK_DELETE: return NS_KEY_DELETE_RIGHT;
	case SDLK_LEFT: return NS_KEY_LEFT;
	case SDLK_RIGHT: return NS_KEY_RIGHT;
	case SDLK_UP: return NS_KEY_UP;
	case SDLK_DOWN: return NS_KEY_DOWN;
	case SDLK_HOME: return NS_KEY_LINE_START;
	case SDLK_END: return NS_KEY_LINE_END;
	case SDLK_PAGEUP: return NS_KEY_PAGE_UP;
	case SDLK_PAGEDOWN: return NS_KEY_PAGE_DOWN;
	default:
		/* the veneer delivers modifier-applied unicode keycodes;
		 * non-character keys live above 0x40000000 */
		if ((key >= 0x20) && (key < 0x40000000)) {
			return key;
		}
		return 0;
	}
}

/**
 * A key came up.  The core has nothing to DO with a release; it is
 * forwarded purely so the DOM can fire `keyup` (todos/0289).
 */
static void
gucos_key_up(struct gui_window *gw, const SDL_KeyboardEvent *k)
{
	uint32_t nskey;

	/* The chord paths below swallow their keys on the way down, so a
	 * release of one is not a keyup the page should see either. */
	if (k->mod & (SDL_KMOD_ALT | SDL_KMOD_CTRL)) {
		return;
	}

	nskey = gucos_nskey(k->key, k->mod);
	if (nskey != 0) {
		browser_window_key_release(gw->bw, nskey);
	}
}

static void
gucos_key(struct gui_window *gw, const SDL_KeyboardEvent *k)
{
	uint32_t key = k->key;
	uint32_t nskey = 0;

	/* Alt+Left / Alt+Right walk the local history (the gucOS
	 * browser navigation chord — there is no toolbar chrome) */
	if (k->mod & SDL_KMOD_ALT) {
		switch (key) {
		case SDLK_LEFT:
			if (browser_window_history_back_available(gw->bw)) {
				browser_window_history_back(gw->bw, false);
			}
			break;
		case SDLK_RIGHT:
			if (browser_window_history_forward_available(gw->bw)) {
				browser_window_history_forward(gw->bw, false);
			}
			break;
		default:
			break;
		}
		return;
	}

	if (k->mod & SDL_KMOD_CTRL) {
		switch (key) {
		case 'a': nskey = NS_KEY_SELECT_ALL; break;
		case 'c': nskey = NS_KEY_COPY_SELECTION; break;
		case 'v': nskey = NS_KEY_PASTE; break;
		case 'x': nskey = NS_KEY_CUT_SELECTION; break;
		case 'z': nskey = NS_KEY_UNDO; break;
		case 'y': nskey = NS_KEY_REDO; break;
		default: return;
		}
		browser_window_key_press(gw->bw, nskey);
		return;
	}

	nskey = gucos_nskey(key, k->mod);
	if (nskey == 0) {
		return;
	}

	if (browser_window_key_press(gw->bw, nskey)) {
		return;
	}

	/* unclaimed navigation keys scroll the viewport */
	switch (key) {
	case SDLK_BACKSPACE:
		/* the classic browser chord: Backspace outside a text
		 * input goes back in history */
		if (browser_window_history_back_available(gw->bw)) {
			browser_window_history_back(gw->bw, false);
		}
		break;
	case SDLK_LEFT:
		gucos_scroll_to(gw, gw->scrollx - SCROLL_STEP, gw->scrolly);
		break;
	case SDLK_RIGHT:
		gucos_scroll_to(gw, gw->scrollx + SCROLL_STEP, gw->scrolly);
		break;
	case SDLK_UP:
		gucos_scroll_to(gw, gw->scrollx, gw->scrolly - SCROLL_STEP);
		break;
	case SDLK_DOWN:
		gucos_scroll_to(gw, gw->scrollx, gw->scrolly + SCROLL_STEP);
		break;
	case SDLK_PAGEUP:
		gucos_scroll_to(gw, gw->scrollx,
				gw->scrolly - gucos_content_h(gw));
		break;
	case SDLK_PAGEDOWN:
		gucos_scroll_to(gw, gw->scrollx,
				gw->scrolly + gucos_content_h(gw));
		break;
	case SDLK_HOME:
		gucos_scroll_to(gw, gw->scrollx, 0);
		break;
	case SDLK_END:
		gucos_scroll_to(gw, gw->scrollx, INT_MAX);
		break;
	default:
		break;
	}
}

static void gucos_resized(struct gui_window *gw)
{
	/* SDL3 contract: re-fetch the window surface after RESIZED */
	gw->surf = SDL_GetWindowSurface(gw->win);

	if (!gucos_fb_resize(gw->fb, gw->surf->w, gw->surf->h)) {
		NSLOG(netsurf, ERROR, "render surface resize failed");
		return;
	}

	/* re-lay the content out at the new size SYNCHRONOUSLY (the
	 * event drain is a safe top-level context — term's apply_resize
	 * precedent): the first present at the new geometry, which is
	 * also the kernel's configure ack, already carries the
	 * reflowed layout — no stale-crop frame is ever shown */
	browser_window_reformat(gw->bw, false, gw->surf->w,
				gucos_content_h(gw));
	gucos_scroll_to(gw, gw->scrollx, gw->scrolly);
	gw->dirty = false;
	gucos_damage_all(gw);
}

/* exported interface documented in gucos/gui.h */
void gucos_process_events(void)
{
	SDL_Event e;
	struct gui_window *gw;

	while (SDL_PollEvent(&e)) {
		switch (e.type) {
		case SDL_EVENT_QUIT:
			/* destroy every browsing context; the last
			 * window destroy flags gucos_done */
			while (window_list != NULL) {
				browser_window_destroy(window_list->bw);
			}
			return;

		case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
			gw = gucos_window_from_id(e.window.windowID);
			if (gw != NULL) {
				browser_window_destroy(gw->bw);
			}
			break;

		case SDL_EVENT_WINDOW_RESIZED:
			gw = gucos_window_from_id(e.window.windowID);
			if (gw != NULL) {
				gucos_resized(gw);
			}
			break;

		case SDL_EVENT_MOUSE_MOTION:
			gw = gucos_window_from_id(e.motion.windowID);
			if (gw != NULL) {
				gucos_mouse_motion(gw, &e.motion);
			}
			break;

		case SDL_EVENT_MOUSE_BUTTON_DOWN:
		case SDL_EVENT_MOUSE_BUTTON_UP:
			gw = gucos_window_from_id(e.button.windowID);
			if (gw != NULL) {
				gucos_mouse_button(gw, &e.button);
			}
			break;

		case SDL_EVENT_MOUSE_WHEEL:
			gw = gucos_window_from_id(e.wheel.windowID);
			if (gw != NULL) {
				gucos_mouse_wheel(gw, &e.wheel);
			}
			break;

		case SDL_EVENT_KEY_DOWN:
			gw = gucos_window_from_id(e.key.windowID);
			if (gw != NULL) {
				gucos_key(gw, &e.key);
			}
			break;

		case SDL_EVENT_KEY_UP:
			gw = gucos_window_from_id(e.key.windowID);
			if (gw != NULL) {
				gucos_key_up(gw, &e.key);
			}
			break;

		default:
			break;
		}
	}
}
