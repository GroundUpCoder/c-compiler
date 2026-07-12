/*
 * sdlx.c — the gucOS port's display backend (todos/0119): mgp's Xlib
 * vocabulary implemented over one SDL window. Replaces upstream x11.c
 * (whose init_win/get_color/... entry points are re-implemented here)
 * and image/send.c (imageToXImage/freeXImage/ximageToPixmap, truecolor
 * only). See sdlx.h for the model: every Drawable is a 0x00RRGGBB canvas;
 * XFlush converts the window canvas into the SDL surface and presents.
 */
#include <SDL.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#include "mgp.h"   /* pulls in sdlx.h + image/xloadimage.h + the externs */

/* ---- globals x11.c used to define (mgp.h externs) ---- */
GC gcfore, gcpen, gcred, gcgreen, gcyellow;
GC gc_pl, gc_plrev, gc_pta, gc_ptk;
GC gc_cache;
long xeventmask = ~0L;
int _Xdebug = 0;   /* xloadimage debug flag (image/new.c, misc.c) */
int window_x, window_y;

/* ---- SDL state ---- */
static SDL_Window *sx_win;
static SDL_Surface *sx_surf;
static struct sx_display sx_disp;
static struct sx_drawable sx_windraw;   /* the Window drawable */
static Pixmap sx_bg_pixmap;             /* window background */
static unsigned long sx_bg_pixel;

/* ---- helpers ---- */
static Drawable dnew(int w, int h) {
	Drawable d = calloc(1, sizeof(*d));
	if (!d) { fprintf(stderr, "sdlx: out of memory\n"); exit(1); }
	d->w = w; d->h = h;
	d->px = calloc((size_t)w * h, 4);
	if (!d->px) { fprintf(stderr, "sdlx: out of memory\n"); exit(1); }
	return d;
}

void XFlush(Display *d) {
	int n, i;
	uint32_t *dst, *src;
	(void)d;
	if (!sx_surf || !window) return;
	n = sx_windraw.w * sx_windraw.h;
	if (sx_surf->w != sx_windraw.w || sx_surf->h != sx_windraw.h) return;
	src = sx_windraw.px;
	dst = (uint32_t *)sx_surf->pixels;
	for (i = 0; i < n; i++) {
		uint32_t p = src[i];
		dst[i] = ((p >> 16) & 0xff) | (p & 0x00ff00) |
		         ((p & 0xff) << 16) | 0xff000000u;
	}
	SDL_UpdateWindowSurface(sx_win);
}

void XSync(Display *d, Bool b) { (void)b; XFlush(d); }
void XBell(Display *d, int pct) { (void)d; (void)pct; }
void XFree(void *p) { free(p); }

/* ---- GCs ---- */
GC XCreateGC(Display *d, Drawable dr, unsigned long m, void *v) {
	GC gc = calloc(1, sizeof(*gc));
	(void)d; (void)dr; (void)m; (void)v;
	gc->fore = 0; gc->back = 0xffffff; gc->func = GXcopy;
	return gc;
}
void XFreeGC(Display *d, GC gc) { (void)d; free(gc); }
void XSetForeground(Display *d, GC gc, unsigned long p) { (void)d; gc->fore = p; }
void XSetBackground(Display *d, GC gc, unsigned long p) { (void)d; gc->back = p; }
void XSetFunction(Display *d, GC gc, int f) { (void)d; gc->func = f; }

/* ---- drawing primitives (all clipped against the target) ---- */
static void px_set(Drawable t, int x, int y, unsigned long p) {
	if (x < 0 || y < 0 || x >= t->w || y >= t->h) return;
	t->px[(size_t)y * t->w + x] = (uint32_t)p;
}

void XFillRectangle(Display *d, Drawable t, GC gc, int x, int y, unsigned int w, unsigned int h) {
	int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
	int x1 = x + (int)w, y1 = y + (int)h, xi, yi;
	(void)d;
	if (x1 > t->w) x1 = t->w;
	if (y1 > t->h) y1 = t->h;
	for (yi = y0; yi < y1; yi++)
		for (xi = x0; xi < x1; xi++)
			t->px[(size_t)yi * t->w + xi] = (uint32_t)gc->fore;
}

void XDrawRectangle(Display *d, Drawable t, GC gc, int x, int y, unsigned int w, unsigned int h) {
	unsigned int i;
	(void)d;
	for (i = 0; i <= w; i++) { px_set(t, x + (int)i, y, gc->fore); px_set(t, x + (int)i, y + (int)h, gc->fore); }
	for (i = 0; i <= h; i++) { px_set(t, x, y + (int)i, gc->fore); px_set(t, x + (int)w, y + (int)i, gc->fore); }
}

void XDrawLine(Display *d, Drawable t, GC gc, int x1, int y1, int x2, int y2) {
	int dx = abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
	int dy = -abs(y2 - y1), sy = y1 < y2 ? 1 : -1;
	int err = dx + dy;
	(void)d;
	for (;;) {
		px_set(t, x1, y1, gc->fore);
		if (x1 == x2 && y1 == y2) break;
		{ int e2 = 2 * err;
		  if (e2 >= dy) { err += dy; x1 += sx; }
		  if (e2 <= dx) { err += dx; y1 += sy; } }
	}
}

void XFillArc(Display *d, Drawable t, GC gc, int x, int y, unsigned int w, unsigned int h, int a1, int a2) {
	/* mgp only fills whole circles (%icon arc) — render the ellipse */
	double cx = x + w / 2.0, cy = y + h / 2.0;
	double rx = w / 2.0, ry = h / 2.0;
	int yi, xi;
	(void)d; (void)a1; (void)a2;
	if (rx <= 0 || ry <= 0) return;
	for (yi = y; yi < y + (int)h; yi++)
		for (xi = x; xi < x + (int)w; xi++) {
			double nx = (xi + 0.5 - cx) / rx, ny = (yi + 0.5 - cy) / ry;
			if (nx * nx + ny * ny <= 1.0)
				px_set(t, xi, yi, gc->fore);
		}
}

void XFillPolygon(Display *d, Drawable t, GC gc, XPoint *pts, int n, int shape, int mode) {
	int ymin = 0x7fffffff, ymax = -0x7fffffff, i, y;
	double xs[64];
	(void)d; (void)shape; (void)mode;
	if (n < 3 || n > 64) return;
	for (i = 0; i < n; i++) {
		if (pts[i].y < ymin) ymin = pts[i].y;
		if (pts[i].y > ymax) ymax = pts[i].y;
	}
	for (y = ymin; y <= ymax; y++) {
		int cnt = 0, j;
		for (i = 0, j = n - 1; i < n; j = i++) {
			double y0 = pts[j].y, y1 = pts[i].y;
			if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
				double frac = (y - y0) / (y1 - y0);
				xs[cnt++] = pts[j].x + frac * (pts[i].x - pts[j].x);
			}
		}
		/* insertion sort + fill pairs */
		for (i = 1; i < cnt; i++) {
			double v = xs[i]; int k = i - 1;
			while (k >= 0 && xs[k] > v) { xs[k + 1] = xs[k]; k--; }
			xs[k + 1] = v;
		}
		for (i = 0; i + 1 < cnt; i += 2) {
			int xa = (int)(xs[i] + 0.5), xb = (int)(xs[i + 1] + 0.5), xi;
			for (xi = xa; xi <= xb; xi++)
				px_set(t, xi, y, gc->fore);
		}
	}
}

void XCopyArea(Display *d, Drawable src, Drawable dst, GC gc, int sx, int sy, unsigned int w, unsigned int h, int dx, int dy) {
	int yi, xi;
	(void)d; (void)gc;
	/* forward copy is fine except overlapping same-drawable scrolls;
	 * copy through the right order by choosing direction */
	if (src == dst && dy == sy && dx > sx) {
		for (yi = (int)h - 1; yi >= 0; yi--)
			for (xi = (int)w - 1; xi >= 0; xi--) {
				int fx = sx + xi, fy = sy + yi, tx = dx + xi, ty = dy + yi;
				if (fx < 0 || fy < 0 || fx >= src->w || fy >= src->h) continue;
				px_set(dst, tx, ty, src->px[(size_t)fy * src->w + fx]);
			}
		return;
	}
	for (yi = 0; yi < (int)h; yi++)
		for (xi = 0; xi < (int)w; xi++) {
			int fx = sx + xi, fy = sy + yi, tx = dx + xi, ty = dy + yi;
			if (fx < 0 || fy < 0 || fx >= src->w || fy >= src->h) continue;
			px_set(dst, tx, ty, src->px[(size_t)fy * src->w + fx]);
		}
}

void XClearArea(Display *d, Window win, int x, int y, unsigned int w, unsigned int h, Bool exposures) {
	(void)exposures;
	if (w == 0) w = win->w - x;
	if (h == 0) h = win->h - y;
	if (sx_bg_pixmap) {
		int yi, xi;
		for (yi = y; yi < y + (int)h; yi++)
			for (xi = x; xi < x + (int)w; xi++) {
				if (xi < 0 || yi < 0 || xi >= win->w || yi >= win->h) continue;
				win->px[(size_t)yi * win->w + xi] =
					sx_bg_pixmap->px[(size_t)(yi % sx_bg_pixmap->h) * sx_bg_pixmap->w + (xi % sx_bg_pixmap->w)];
			}
	} else {
		struct sx_gc g;
		g.fore = sx_bg_pixel;
		XFillRectangle(d, win, &g, x, y, w, h);
	}
}

void XClearWindow(Display *d, Window win) { XClearArea(d, win, 0, 0, 0, 0, False); }

void XSetWindowBackground(Display *d, Window win, unsigned long p) {
	(void)d; (void)win;
	sx_bg_pixel = p;
	sx_bg_pixmap = NULL;
}
void XSetWindowBackgroundPixmap(Display *d, Window win, Pixmap pm) {
	(void)d; (void)win;
	sx_bg_pixmap = pm;
}

Pixmap XCreatePixmap(Display *d, Drawable dr, unsigned int w, unsigned int h, unsigned int depth_) {
	(void)d; (void)dr; (void)depth_;
	return dnew((int)w, (int)h);
}
void XFreePixmap(Display *d, Pixmap p) {
	(void)d;
	if (!p) return;
	free(p->px);
	free(p);
}

void XStoreName(Display *d, Window w, const char *name) {
	(void)d; (void)w;
	if (sx_win) SDL_SetWindowTitle(sx_win, name);
}
void XMoveResizeWindow(Display *d, Window w, int x, int y, unsigned int ww, unsigned int hh) {
	(void)d; (void)w; (void)x; (void)y; (void)ww; (void)hh;   /* WM's job */
}
void XMapSubwindows(Display *d, Window w) { (void)d; (void)w; }
void XDestroyWindow(Display *d, Window w) { (void)d; (void)w; }

Status XGetWindowAttributes(Display *d, Window w, XWindowAttributes *wa) {
	(void)d;
	wa->x = wa->y = 0;
	wa->width = w ? w->w : window_width;
	wa->height = w ? w->h : window_height;
	wa->border_width = 0;
	wa->depth = 24;
	return 1;
}
Bool XTranslateCoordinates(Display *d, Window src, Window dst, int x, int y,
                           int *rx, int *ry, Window *child) {
	(void)d; (void)src; (void)dst;
	if (rx) *rx = x;
	if (ry) *ry = y;
	if (child) *child = (Window)0;
	return True;
}
/* child windows never actually raise here (cutin's use_copy path is always
 * taken); the stub keeps the dead branch compiling */
Window XCreateSimpleWindow(Display *d, Window parent, int x, int y,
                           unsigned int w, unsigned int h, unsigned int bw,
                           unsigned long border, unsigned long back) {
	(void)d; (void)parent; (void)x; (void)y; (void)bw; (void)border; (void)back;
	return dnew((int)(w ? w : 1), (int)(h ? h : 1));
}
void XMoveWindow(Display *d, Window w, int x, int y) { (void)d; (void)w; (void)x; (void)y; }

/* ---- XImage ---- */
XImage *XCreateImage(Display *d, Visual *v, unsigned int depth_, int fmt, int off, char *data, unsigned int w, unsigned int h, int pad, int bpl) {
	XImage *xi = calloc(1, sizeof(*xi));
	(void)d; (void)v; (void)off; (void)pad;
	xi->width = (int)w;
	xi->height = (int)h;
	xi->format = fmt;
	xi->depth = (int)depth_;
	xi->bits_per_pixel = 32;
	xi->bytes_per_line = bpl ? bpl : (int)w * 4;
	xi->data = data;
	return xi;
}
void XDestroyImage(XImage *xi) {
	if (!xi) return;
	free(xi->data);
	free(xi);
}
unsigned long XGetPixel(XImage *xi, int x, int y) {
	if (x < 0 || y < 0 || x >= xi->width || y >= xi->height) return 0;
	return *(uint32_t *)(xi->data + (size_t)y * xi->bytes_per_line + (size_t)x * 4);
}
void XPutPixel(XImage *xi, int x, int y, unsigned long p) {
	if (x < 0 || y < 0 || x >= xi->width || y >= xi->height) return;
	*(uint32_t *)(xi->data + (size_t)y * xi->bytes_per_line + (size_t)x * 4) = (uint32_t)p;
}
void XAddPixel(XImage *xi, long v) {
	int x, y;
	for (y = 0; y < xi->height; y++)
		for (x = 0; x < xi->width; x++)
			XPutPixel(xi, x, y, (unsigned long)(XGetPixel(xi, x, y) + v));
}
void XPutImage(Display *d, Drawable t, GC gc, XImage *xi, int sx, int sy, int dx, int dy, unsigned int w, unsigned int h) {
	int yi, xi_;
	(void)d; (void)gc;
	for (yi = 0; yi < (int)h; yi++)
		for (xi_ = 0; xi_ < (int)w; xi_++) {
			int fx = sx + xi_, fy = sy + yi;
			if (fx < 0 || fy < 0 || fx >= xi->width || fy >= xi->height) continue;
			px_set(t, dx + xi_, dy + yi, XGetPixel(xi, fx, fy));
		}
}
XImage *XGetImage(Display *d, Drawable t, int x, int y, unsigned int w, unsigned int h, unsigned long mask, int fmt) {
	XImage *xi = XCreateImage(d, NULL, 24, fmt, 0, malloc((size_t)w * h * 4), w, h, 32, 0);
	int yi, xi_;
	(void)mask;
	for (yi = 0; yi < (int)h; yi++)
		for (xi_ = 0; xi_ < (int)w; xi_++) {
			int fx = x + xi_, fy = y + yi;
			unsigned long p = (fx < 0 || fy < 0 || fx >= t->w || fy >= t->h)
				? 0 : t->px[(size_t)fy * t->w + fx];
			XPutPixel(xi, xi_, yi, p);
		}
	return xi;
}

/* ---- colors (truecolor bit-packing + an X11 name table) ---- */
static const struct { const char *name; unsigned long rgb; } sx_colors[] = {
	{ "black", 0x000000 }, { "white", 0xffffff }, { "red", 0xff0000 },
	{ "green", 0x00ff00 }, { "blue", 0x0000ff }, { "yellow", 0xffff00 },
	{ "cyan", 0x00ffff }, { "magenta", 0xff00ff }, { "gray", 0xbebebe },
	{ "grey", 0xbebebe }, { "darkblue", 0x00008b }, { "darkgreen", 0x006400 },
	{ "darkred", 0x8b0000 }, { "darkcyan", 0x008b8b }, { "darkmagenta", 0x8b008b },
	{ "darkgray", 0xa9a9a9 }, { "darkgrey", 0xa9a9a9 }, { "lightgray", 0xd3d3d3 },
	{ "lightgrey", 0xd3d3d3 }, { "dimgray", 0x696969 }, { "dimgrey", 0x696969 },
	{ "navy", 0x000080 }, { "navyblue", 0x000080 }, { "midnightblue", 0x191970 },
	{ "cornflowerblue", 0x6495ed }, { "darkslateblue", 0x483d8b },
	{ "slateblue", 0x6a5acd }, { "mediumblue", 0x0000cd }, { "royalblue", 0x4169e1 },
	{ "dodgerblue", 0x1e90ff }, { "deepskyblue", 0x00bfff }, { "skyblue", 0x87ceeb },
	{ "lightskyblue", 0x87cefa }, { "steelblue", 0x4682b4 }, { "lightsteelblue", 0xb0c4de },
	{ "lightblue", 0xadd8e6 }, { "powderblue", 0xb0e0e6 }, { "paleturquoise", 0xafeeee },
	{ "turquoise", 0x40e0d0 }, { "mediumturquoise", 0x48d1cc }, { "darkturquoise", 0x00ced1 },
	{ "cadetblue", 0x5f9ea0 }, { "aquamarine", 0x7fffd4 }, { "mediumaquamarine", 0x66cdaa },
	{ "seagreen", 0x2e8b57 }, { "mediumseagreen", 0x3cb371 }, { "lightseagreen", 0x20b2aa },
	{ "palegreen", 0x98fb98 }, { "springgreen", 0x00ff7f }, { "lawngreen", 0x7cfc00 },
	{ "chartreuse", 0x7fff00 }, { "mediumspringgreen", 0x00fa9a }, { "greenyellow", 0xadff2f },
	{ "limegreen", 0x32cd32 }, { "yellowgreen", 0x9acd32 }, { "forestgreen", 0x228b22 },
	{ "olivedrab", 0x6b8e23 }, { "darkkhaki", 0xbdb76b }, { "khaki", 0xf0e68c },
	{ "palegoldenrod", 0xeee8aa }, { "lightgoldenrodyellow", 0xfafad2 },
	{ "lightyellow", 0xffffe0 }, { "gold", 0xffd700 }, { "lightgoldenrod", 0xeedd82 },
	{ "goldenrod", 0xdaa520 }, { "darkgoldenrod", 0xb8860b }, { "rosybrown", 0xbc8f8f },
	{ "indianred", 0xcd5c5c }, { "saddlebrown", 0x8b4513 }, { "sienna", 0xa0522d },
	{ "peru", 0xcd853f }, { "burlywood", 0xdeb887 }, { "beige", 0xf5f5dc },
	{ "wheat", 0xf5deb3 }, { "sandybrown", 0xf4a460 }, { "tan", 0xd2b48c },
	{ "chocolate", 0xd2691e }, { "firebrick", 0xb22222 }, { "brown", 0xa52a2a },
	{ "darksalmon", 0xe9967a }, { "salmon", 0xfa8072 }, { "lightsalmon", 0xffa07a },
	{ "orange", 0xffa500 }, { "darkorange", 0xff8c00 }, { "coral", 0xff7f50 },
	{ "lightcoral", 0xf08080 }, { "tomato", 0xff6347 }, { "orangered", 0xff4500 },
	{ "hotpink", 0xff69b4 }, { "deeppink", 0xff1493 }, { "pink", 0xffc0cb },
	{ "lightpink", 0xffb6c1 }, { "palevioletred", 0xdb7093 }, { "maroon", 0xb03060 },
	{ "mediumvioletred", 0xc71585 }, { "violetred", 0xd02090 }, { "violet", 0xee82ee },
	{ "plum", 0xdda0dd }, { "orchid", 0xda70d6 }, { "mediumorchid", 0xba55d3 },
	{ "darkorchid", 0x9932cc }, { "darkviolet", 0x9400d3 }, { "blueviolet", 0x8a2be2 },
	{ "purple", 0xa020f0 }, { "mediumpurple", 0x9370db }, { "thistle", 0xd8bfd8 },
	{ "snow", 0xfffafa }, { "ghostwhite", 0xf8f8ff }, { "whitesmoke", 0xf5f5f5 },
	{ "gainsboro", 0xdcdcdc }, { "floralwhite", 0xfffaf0 }, { "oldlace", 0xfdf5e6 },
	{ "linen", 0xfaf0e6 }, { "antiquewhite", 0xfaebd7 }, { "papayawhip", 0xffefd5 },
	{ "blanchedalmond", 0xffebcd }, { "bisque", 0xffe4c4 }, { "peachpuff", 0xffdab9 },
	{ "navajowhite", 0xffdead }, { "moccasin", 0xffe4b5 }, { "cornsilk", 0xfff8dc },
	{ "ivory", 0xfffff0 }, { "lemonchiffon", 0xfffacd }, { "seashell", 0xfff5ee },
	{ "honeydew", 0xf0fff0 }, { "mintcream", 0xf5fffa }, { "azure", 0xf0ffff },
	{ "aliceblue", 0xf0f8ff }, { "lavender", 0xe6e6fa }, { "lavenderblush", 0xfff0f5 },
	{ "mistyrose", 0xffe4e1 }, { "slategray", 0x708090 }, { "slategrey", 0x708090 },
	{ "lightslategray", 0x778899 }, { "lightslategrey", 0x778899 },
	{ "darkslategray", 0x2f4f4f }, { "darkslategrey", 0x2f4f4f },
	{ "crimson", 0xdc143c }, { "indigo", 0x4b0082 }, { "olive", 0x808000 },
	{ "teal", 0x008080 }, { "silver", 0xc0c0c0 }, { "lightgreen", 0x90ee90 },
	{ NULL, 0 }
};

static int sx_lookup_color(const char *name, unsigned long *out) {
	char buf[64];
	size_t i, o = 0;
	int n;
	if (!name) return -1;
	if (name[0] == '#') {
		unsigned long v = strtoul(name + 1, NULL, 16);
		if (strlen(name) == 4) {   /* #rgb */
			unsigned long r = (v >> 8) & 0xf, g = (v >> 4) & 0xf, b = v & 0xf;
			v = (r * 17 << 16) | (g * 17 << 8) | (b * 17);
		}
		*out = v & 0xffffff;
		return 0;
	}
	for (i = 0; name[i] && o < sizeof(buf) - 1; i++) {
		if (name[i] == ' ' || name[i] == '\t') continue;
		buf[o++] = (char)((name[i] >= 'A' && name[i] <= 'Z') ? name[i] + 32 : name[i]);
	}
	buf[o] = 0;
	/* grayNN / greyNN */
	if ((sscanf(buf, "gray%d", &n) == 1 || sscanf(buf, "grey%d", &n) == 1) &&
	    n >= 0 && n <= 100) {
		unsigned long l = (unsigned long)(n * 255 / 100);
		*out = (l << 16) | (l << 8) | l;
		return 0;
	}
	for (i = 0; sx_colors[i].name; i++)
		if (strcmp(buf, sx_colors[i].name) == 0) {
			*out = sx_colors[i].rgb;
			return 0;
		}
	return -1;
}

Status XAllocColor(Display *d, Colormap cm, XColor *c) {
	(void)d; (void)cm;
	c->pixel = ((unsigned long)(c->red >> 8) << 16) |
	           ((unsigned long)(c->green >> 8) << 8) |
	           (unsigned long)(c->blue >> 8);
	return 1;
}
Status XParseColor(Display *d, Colormap cm, const char *name, XColor *c) {
	unsigned long v;
	(void)d; (void)cm;
	if (sx_lookup_color(name, &v) != 0) return 0;
	c->red = (unsigned short)(((v >> 16) & 0xff) * 257);
	c->green = (unsigned short)(((v >> 8) & 0xff) * 257);
	c->blue = (unsigned short)((v & 0xff) * 257);
	c->pixel = v;
	return 1;
}
Status XAllocNamedColor(Display *d, Colormap cm, const char *name, XColor *c1, XColor *c0) {
	if (!XParseColor(d, cm, name, c1)) return 0;
	if (c0) *c0 = *c1;
	return 1;
}
void XQueryColor(Display *d, Colormap cm, XColor *c) {
	(void)d; (void)cm;
	c->red = (unsigned short)(((c->pixel >> 16) & 0xff) * 257);
	c->green = (unsigned short)(((c->pixel >> 8) & 0xff) * 257);
	c->blue = (unsigned short)((c->pixel & 0xff) * 257);
}
void XQueryColors(Display *d, Colormap cm, XColor *cs, int n) {
	int i;
	for (i = 0; i < n; i++)
		XQueryColor(d, cm, &cs[i]);
}
void XFreeColors(Display *d, Colormap cm, unsigned long *p, int n, unsigned long planes) {
	(void)d; (void)cm; (void)p; (void)n; (void)planes;
}
Colormap XCopyColormapAndFree(Display *d, Colormap cm) { (void)d; return cm; }

/* ---- events ---- */
#define SX_QLEN 256
static XEvent sx_q[SX_QLEN];
static int sx_qhead, sx_qcount;

static void sx_enqueue(XEvent *e) {
	if (sx_qcount >= SX_QLEN) return;   /* drop when flooded */
	sx_q[(sx_qhead + sx_qcount) % SX_QLEN] = *e;
	sx_qcount++;
}

static unsigned int sx_mapkey(int k) {
	if (k >= 'A' && k <= 'Z') return (unsigned int)(k + 32);
	switch (k) {
	case SDLK_ESCAPE: return XK_Escape;
	case SDLK_RETURN: return XK_Return;
	case SDLK_BACKSPACE: return XK_BackSpace;
	case SDLK_DELETE: return XK_Delete;
	case SDLK_TAB: return XK_Tab;
	case SDLK_UP: return XK_Up;
	case SDLK_DOWN: return XK_Down;
	case SDLK_LEFT: return XK_Left;
	case SDLK_RIGHT: return XK_Right;
	case SDLK_PAGEUP: return XK_Prior;
	case SDLK_PAGEDOWN: return XK_Next;
	case SDLK_HOME: return XK_Home;
	case SDLK_LSHIFT: return XK_Shift_L;
	case SDLK_RSHIFT: return XK_Shift_R;
	case SDLK_LCTRL: return XK_Control_L;
	case SDLK_RCTRL: return XK_Control_R;
	}
	if (k > 0 && k < 128) return (unsigned int)k;
	return 0;
}

static void sx_resize(int w, int h) {
	uint32_t *npx;
	if (w == sx_windraw.w && h == sx_windraw.h) return;
	npx = calloc((size_t)w * h, 4);
	if (!npx) return;
	free(sx_windraw.px);
	sx_windraw.px = npx;
	sx_windraw.w = w;
	sx_windraw.h = h;
}

/* Grow a cache pixmap to at least the window size (contents dropped —
 * they're all redrawn caches). */
static void sx_grow(Pixmap *pm, int w, int h) {
	if (!*pm || ((*pm)->w >= w && (*pm)->h >= h)) return;
	XFreePixmap(display, *pm);
	*pm = dnew(w, h);
}

static void sx_pump(void) {
	SDL_Event se;
	XEvent e;
	while (SDL_PollEvent(&se)) {
		memset(&e, 0, sizeof(e));
		switch (se.type) {
		case SDL_EVENT_KEY_DOWN:
		case SDL_EVENT_KEY_UP:
			e.xkey.type = se.type == SDL_EVENT_KEY_DOWN ? KeyPress : KeyRelease;
			e.xkey.window = window;
			e.xkey.keycode = sx_mapkey((int)se.key.key);
			if (e.xkey.keycode) sx_enqueue(&e);
			break;
		case SDL_EVENT_MOUSE_BUTTON_DOWN:
		case SDL_EVENT_MOUSE_BUTTON_UP:
			e.xbutton.type = se.type == SDL_EVENT_MOUSE_BUTTON_DOWN ? ButtonPress : ButtonRelease;
			e.xbutton.window = window;
			e.xbutton.button = se.button.button;
			e.xbutton.x = (int)se.button.x;
			e.xbutton.y = (int)se.button.y;
			sx_enqueue(&e);
			break;
		case SDL_EVENT_MOUSE_MOTION:
			e.xmotion.type = MotionNotify;
			e.xmotion.window = window;
			e.xmotion.x = (int)se.motion.x;
			e.xmotion.y = (int)se.motion.y;
			sx_enqueue(&e);
			break;
		case SDL_EVENT_WINDOW_RESIZED:
			sx_surf = SDL_GetWindowSurface(sx_win);
			sx_resize(sx_surf->w, sx_surf->h);
			sx_grow(&pixmap, sx_surf->w, sx_surf->h);
			sx_grow(&maskpix, sx_surf->w, sx_surf->h);
			sx_grow(&cachewin, sx_surf->w, sx_surf->h);
			sx_grow(&cachetmp, sx_surf->w, sx_surf->h);
			e.xconfigure.type = ConfigureNotify;
			e.xconfigure.window = window;
			e.xconfigure.width = sx_surf->w;
			e.xconfigure.height = sx_surf->h;
			sx_enqueue(&e);
			break;
		case SDL_EVENT_WINDOW_EXPOSED:
			e.xexpose.type = Expose;
			e.xexpose.window = window;
			e.xexpose.count = 0;
			sx_enqueue(&e);
			break;
		case SDL_EVENT_QUIT:
		case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
			/* run mgp's stock quit path */
			e.xkey.type = KeyPress;
			e.xkey.window = window;
			e.xkey.keycode = XK_q;
			sx_enqueue(&e);
			break;
		}
	}
}

static long sx_evmask(int type) {
	switch (type) {
	case KeyPress: return KeyPressMask;
	case KeyRelease: return KeyReleaseMask;
	case ButtonPress: return ButtonPressMask;
	case ButtonRelease: return ButtonReleaseMask;
	case MotionNotify: return Button1MotionMask;
	case Expose: return ExposureMask;
	case ConfigureNotify: return StructureNotifyMask;
	}
	return ~0L;   /* unknown types match "everything" masks */
}

int XEventsQueued(Display *d, int mode) {
	(void)d; (void)mode;
	sx_pump();
	return sx_qcount;
}

void XNextEvent(Display *d, XEvent *e) {
	(void)d;
	sx_pump();
	if (!sx_qcount) {   /* callers always guard; don't block */
		memset(e, 0, sizeof(*e));
		return;
	}
	*e = sx_q[sx_qhead];
	sx_qhead = (sx_qhead + 1) % SX_QLEN;
	sx_qcount--;
}

void XPeekEvent(Display *d, XEvent *e) {
	(void)d;
	sx_pump();
	if (!sx_qcount) { memset(e, 0, sizeof(*e)); return; }
	*e = sx_q[sx_qhead];
}

Bool XCheckMaskEvent(Display *d, long mask, XEvent *e) {
	int i;
	(void)d;
	sx_pump();
	for (i = 0; i < sx_qcount; i++) {
		int idx = (sx_qhead + i) % SX_QLEN;
		if (sx_evmask(sx_q[idx].type) & mask) {
			int j;
			*e = sx_q[idx];
			for (j = i; j + 1 < sx_qcount; j++)
				sx_q[(sx_qhead + j) % SX_QLEN] = sx_q[(sx_qhead + j + 1) % SX_QLEN];
			sx_qcount--;
			return True;
		}
	}
	return False;
}

void XPutBackEvent(Display *d, XEvent *e) {
	(void)d;
	if (sx_qcount >= SX_QLEN) return;
	sx_qhead = (sx_qhead + SX_QLEN - 1) % SX_QLEN;
	sx_q[sx_qhead] = *e;
	sx_qcount++;
}

KeySym XLookupKeysym(XKeyEvent *e, int idx) {
	(void)idx;
	return (KeySym)e->keycode;
}
KeyCode XKeysymToKeycode(Display *d, KeySym ks) {
	(void)d;
	return (KeyCode)(ks & 0xff ? ks & 0xff : 1);
}
void XSelectInput(Display *d, Window w, long mask) { (void)d; (void)w; (void)mask; }

/* ---- cursors (no-op) ---- */
Cursor XCreateFontCursor(Display *d, unsigned int shape) { (void)d; (void)shape; return 1; }
void XDefineCursor(Display *d, Window w, Cursor c) { (void)d; (void)w; (void)c; }
void XUndefineCursor(Display *d, Window w) { (void)d; (void)w; }
void XRecolorCursor(Display *d, Cursor c, XColor *a, XColor *b) { (void)d; (void)c; (void)a; (void)b; }

/* ---- misc ---- */
int XParseGeometry(const char *s, int *x, int *y, unsigned int *w, unsigned int *h) {
	int mask = 0;
	unsigned int uw, uh;
	int ix, iy;
	char sx_, sy_;
	if (!s) return 0;
	if (sscanf(s, "%ux%u", &uw, &uh) == 2) {
		*w = uw; *h = uh;
		mask |= WidthValue | HeightValue;
		while (*s && *s != '+' && *s != '-') s++;
	}
	if (sscanf(s, "%c%d%c%d", &sx_, &ix, &sy_, &iy) == 4 &&
	    (sx_ == '+' || sx_ == '-') && (sy_ == '+' || sy_ == '-')) {
		*x = ix; *y = iy;
		mask |= XValue | YValue;
		if (sx_ == '-') mask |= XNegative;
		if (sy_ == '-') mask |= YNegative;
	}
	return mask;
}

void XDrawString16(Display *d, Drawable t, GC gc, int x, int y, XChar2b *s, int n) {
	(void)d; (void)t; (void)gc; (void)x; (void)y; (void)s; (void)n;
	/* X-server-font text path is not built in this port (freetype only) */
}

/* ---- send.c replacements (truecolor only) ---- */
XImageInfo *imageToXImage(Display *disp, int scrn, Visual *vis, unsigned int ddepth,
                          Image *image, int private_cmap, int fit, int verbose)
{
	XImageInfo *info;
	XImage *xi;
	unsigned int x, y;
	byte *p;
	(void)scrn; (void)vis; (void)ddepth; (void)private_cmap; (void)fit; (void)verbose;

	info = calloc(1, sizeof(*info));
	if (!info) return NULL;
	xi = XCreateImage(disp, NULL, 24, ZPixmap, 0,
	                  malloc((size_t)image->width * image->height * 4),
	                  image->width, image->height, 32, 0);
	if (!xi->data) { free(info); free(xi); return NULL; }

	switch (image->type) {
	case ITRUE: {
		unsigned int pl = image->pixlen;
		p = image->data;
		for (y = 0; y < image->height; y++)
			for (x = 0; x < image->width; x++, p += pl)
				XPutPixel(xi, (int)x, (int)y, memToVal(p, pl));
		break;
	}
	case IRGB: {
		unsigned int pl = image->pixlen;
		p = image->data;
		for (y = 0; y < image->height; y++)
			for (x = 0; x < image->width; x++, p += pl) {
				unsigned long idx = memToVal(p, pl);
				unsigned long pix = 0;
				if (idx < image->rgb.used)
					pix = ((unsigned long)(image->rgb.red[idx] >> 8) << 16) |
					      ((unsigned long)(image->rgb.green[idx] >> 8) << 8) |
					      (unsigned long)(image->rgb.blue[idx] >> 8);
				XPutPixel(xi, (int)x, (int)y, pix);
			}
		break;
	}
	case IBITMAP: {
		unsigned int bpl = (image->width + 7) / 8;
		unsigned long fg = 0x000000, bg = 0xffffff;
		if (image->rgb.used >= 2) {
			fg = ((unsigned long)(image->rgb.red[1] >> 8) << 16) |
			     ((unsigned long)(image->rgb.green[1] >> 8) << 8) |
			     (unsigned long)(image->rgb.blue[1] >> 8);
			bg = ((unsigned long)(image->rgb.red[0] >> 8) << 16) |
			     ((unsigned long)(image->rgb.green[0] >> 8) << 8) |
			     (unsigned long)(image->rgb.blue[0] >> 8);
		}
		for (y = 0; y < image->height; y++) {
			p = image->data + (size_t)y * bpl;
			for (x = 0; x < image->width; x++)
				XPutPixel(xi, (int)x, (int)y,
				          (p[x / 8] & (0x80 >> (x % 8))) ? fg : bg);
		}
		break;
	}
	default:
		free(xi->data);
		free(xi);
		free(info);
		return NULL;
	}

	info->disp = disp;
	info->ximage = xi;
	return info;
}

void freeXImage(Image *image, XImageInfo *info) {
	(void)image;
	if (!info) return;
	XDestroyImage(info->ximage);
	free(info);
}

Pixmap ximageToPixmap(Display *disp, Window parent, XImageInfo *info) {
	Pixmap pm;
	(void)parent;
	pm = dnew(info->ximage->width, info->ximage->height);
	XPutImage(disp, pm, NULL, info->ximage, 0, 0, 0, 0,
	          (unsigned int)info->ximage->width, (unsigned int)info->ximage->height);
	return pm;
}

void sendXImage(XImageInfo *info, int sx, int sy, int dx, int dy, unsigned int w, unsigned int h) {
	XPutImage(display, window, gcfore, info->ximage, sx, sy, dx, dy, w, h);
}

/* ---- x11.c entry points (init/teardown/colors) ---- */
static Display sx_display_obj;

void init_win1(char *geometry) {
	int xloc = -1, yloc = -1;
	unsigned int xsiz = 0, ysiz = 0;
	int mode = 0;
	unsigned int i;

	display = &sx_display_obj;
	(void)sx_disp;
	screen = 0;
	visual = NULL;
	depth = 24;
	depth_mask = 0xffffff;

	window_width = window_height = -1;
	window_x = window_y = -1;
	if (geometry) {
		mode = XParseGeometry(geometry, &xloc, &yloc, &xsiz, &ysiz);
		if (mode & WidthValue) window_width = (int)xsiz;
		if (mode & HeightValue) window_height = (int)ysiz;
	}
	/* No display-size query in this world: default to a 4:3 window the
	 * WM can maximize (the presentation scales with the window). */
	if (window_width <= 0) window_width = 800;
	if (window_height <= 0) window_height = 600;

	colormap = 0;
	char_size[0] = window_height * DEFAULT_CHARSIZE / 100;
	nonscaled_size[0] = char_size[0];
	sup_off = DEFAULT_SUPOFF;
	sub_off = DEFAULT_SUBOFF;
	sup_scale = DEFAULT_SUPSCALE;
	(void)get_color(DEFAULT_FORE, &fore_color[0]);
	ctrl_color[0] = fore_color[0];
	(void)get_color(back_clname, &back_color[0]);
	(void)i;
}

void init_win2(void) {
	if (!SDL_Init(SDL_INIT_VIDEO)) {
		fprintf(stderr, "mgp: cannot init SDL video\n");
		exit(-1);
	}
	sx_win = SDL_CreateWindow(mgp_wname ? mgp_wname : "MagicPoint",
	                          window_width, window_height, SDL_WINDOW_RESIZABLE);
	if (!sx_win) {
		fprintf(stderr, "mgp: cannot create window\n");
		exit(-1);
	}
	sx_surf = SDL_GetWindowSurface(sx_win);
	window_width = sx_surf->w;
	window_height = sx_surf->h;

	sx_windraw.w = window_width;
	sx_windraw.h = window_height;
	sx_windraw.px = calloc((size_t)window_width * window_height, 4);
	sx_windraw.iswin = 1;
	window = &sx_windraw;
	sx_bg_pixel = back_color[0];

	pixmap = dnew(window_width, window_height);
	maskpix = dnew(window_width, window_height);
	cachewin = dnew(window_width, window_height);
	cachetmp = dnew(window_width, window_height);

	gc_cache = XCreateGC(display, window, 0, 0);
	gcfore = XCreateGC(display, window, 0, 0);
	gcpen = XCreateGC(display, window, 0, 0);
	gcred = XCreateGC(display, window, 0, 0);
	gcgreen = XCreateGC(display, window, 0, 0);
	gcyellow = XCreateGC(display, window, 0, 0);
	XSetForeground(display, gcfore, fore_color[0]);
	XSetForeground(display, gcpen, 0xff0000);
	XSetForeground(display, gcred, 0xff0000);
	XSetForeground(display, gcgreen, 0x00ff00);
	XSetForeground(display, gcyellow, 0xffff00);

	gc_pl = XCreateGC(display, window, 0, 0);
	gc_plrev = XCreateGC(display, window, 0, 0);
	gc_pta = XCreateGC(display, window, 0, 0);
	gc_ptk = XCreateGC(display, window, 0, 0);
	plfs = plkfs = NULL;   /* no X server fonts; page-list UI is stubbed */
	pl_fh = pl_fw = 12;
}

void init_win3(void) { }

void toggle_fullscreen(void) {
	/* no fullscreen protocol here; the WM's maximize is the analog */
}

void finish_win(void) { }

int get_color(char *colorname, unsigned long *value) {
	unsigned long v;
	if (sx_lookup_color(colorname, &v) != 0) {
		fprintf(stderr, "mgp: unknown color '%s'\n", colorname ? colorname : "(null)");
		return -1;
	}
	if (value) *value = v;
	return 0;
}

struct g_color *name2gcolor(char *colorname) {
	struct g_color *color = calloc(1, sizeof(*color));
	unsigned long v = 0;
	if (sx_lookup_color(colorname, &v) != 0)
		fprintf(stderr, "color '%s' unknown. ignored.\n", colorname);
	color->r = (int)((v >> 16) & 0xff);
	color->g = (int)((v >> 8) & 0xff);
	color->b = (int)(v & 0xff);
	return color;
}

void free_alloc_colors(struct alloc_color *clr) { (void)clr; }
void regist_alloc_colors(struct alloc_color *clr, unsigned long *colors, int num) {
	(void)clr; (void)colors; (void)num;
}

void reset_cache_pixmap(void) {
	XFreePixmap(display, cachewin);
	XFreePixmap(display, cachetmp);
	cachewin = dnew(window_width, window_height);
	cachetmp = dnew(window_width, window_height);
}

/* frame-callback registration (the runtime's __setAnimationFrameFunc,
 * wrapped so mgp.c needs no SDL include) */
void sdlx_frame_hook(void (*cb)(void)) {
	__setAnimationFrameFunc(cb);
}
