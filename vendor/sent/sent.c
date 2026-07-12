/* See LICENSE file for copyright and license details.
 *
 * gucOS port (todos/0119): suckless sent with the display layer patched
 * from Xlib/Xft to SDL + freetype (drw.c reimplements the drw API over the
 * SDL window surface) and the fork+filter farbfeld image pipeline replaced
 * by native loaders (.png via libpng's simplified API, .ff read directly).
 * The event loop is the __setAnimationFrameFunc frame callback (the term.c
 * model): main() returns after setup and the runtime drives frames.
 */
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <SDL.h>
#include <png.h>

#include "arg.h"
#include "util.h"
#include "drw.h"

char *argv0;

/* macros */
#define LEN(a)         (sizeof(a) / sizeof(a)[0])
#define LIMIT(x, a, b) (x) = (x) < (a) ? (a) : (x) > (b) ? (b) : (x)

typedef enum {
	NONE = 0,
	SCALED = 1,
} imgstate;

typedef struct {
	unsigned char *buf;         /* original image, RGB 888 */
	unsigned int bufwidth, bufheight;
	imgstate state;
	uint32_t *scaled;           /* scaled to fit, surface pixel format */
	unsigned int scaledwidth, scaledheight;
} Image;

typedef struct {
	unsigned int linecount;
	char **lines;
	Image *img;
	char *embed;
} Slide;

/* Purely graphic info */
typedef struct {
	SDL_Window *win;
	SDL_Surface *surf;
	int w, h;
	int uw, uh; /* usable dimensions for drawing text and images */
} XWindow;

typedef union {
	int i;
	unsigned int ui;
	float f;
	const void *v;
} Arg;

typedef struct {
	unsigned int b;
	void (*func)(const Arg *);
	const Arg arg;
} Mousekey;

typedef struct {
	int keysym;
	void (*func)(const Arg *);
	const Arg arg;
} Shortcut;

static void fffree(Image *img);
static void ffload(Slide *s);
static void ffprepare(Image *img);
static void ffscale(Image *img);
static void ffdraw(Image *img);

static void getfontsize(Slide *s, unsigned int *width, unsigned int *height);
static void cleanup(int slidesonly);
static void reload(const Arg *arg);
static void load(FILE *fp);
static void advance(const Arg *arg);
static void quit(const Arg *arg);
static void resize(int width, int height);
static void usage(void);
static void xdraw(void);
static void xinit(void);
static void xloadfonts(void);

/* config.h for applying patches and the configuration. */
#include "config.h"

/* Globals */
static const char *fname = NULL;
static Slide *slides = NULL;
static int idx = 0;
static int slidecount = 0;
static XWindow xw;
static Drw *d = NULL;
static Clr *sc;
static Fnt *fonts[NUMFONTSCALES];
static int running = 1;

void
fffree(Image *img)
{
	free(img->buf);
	free(img->scaled);
	free(img);
}

/* Load a PNG through libpng's simplified read API into an RGB 888 buffer,
 * blending alpha against the configured window background (the upstream
 * farbfeld path did the same blend). */
static int
pngload(Slide *s, const char *filename)
{
	png_image pi;
	unsigned char *rgba;
	size_t n, i, o;
	unsigned int a;

	memset(&pi, 0, sizeof(pi));
	pi.version = PNG_IMAGE_VERSION;
	if (!png_image_begin_read_from_file(&pi, filename))
		return -1;
	pi.format = PNG_FORMAT_RGBA;
	rgba = ecalloc(1, PNG_IMAGE_SIZE(pi));
	if (!png_image_finish_read(&pi, NULL, rgba, 0, NULL)) {
		free(rgba);
		return -1;
	}

	s->img = ecalloc(1, sizeof(Image));
	s->img->bufwidth = pi.width;
	s->img->bufheight = pi.height;
	s->img->buf = ecalloc(pi.width * pi.height, 3);
	n = (size_t)pi.width * pi.height;
	for (i = 0, o = 0; i < n; i++) {
		a = rgba[i * 4 + 3];
		s->img->buf[o++] = (rgba[i * 4 + 0] * a + sc[ColBg].r * (255 - a)) / 255;
		s->img->buf[o++] = (rgba[i * 4 + 1] * a + sc[ColBg].g * (255 - a)) / 255;
		s->img->buf[o++] = (rgba[i * 4 + 2] * a + sc[ColBg].b * (255 - a)) / 255;
	}
	free(rgba);
	return 0;
}

/* Read a farbfeld file directly (16-bit big-endian RGBA), blending alpha
 * against the window background like upstream. */
static int
ffldfile(Slide *s, const char *filename)
{
	unsigned char hdr[16], *row;
	uint32_t w, h, y, x;
	size_t rowlen, off;
	FILE *fp;

	if (!(fp = fopen(filename, "rb")))
		return -1;
	if (fread(hdr, 1, 16, fp) != 16 || memcmp("farbfeld", hdr, 8)) {
		fclose(fp);
		return -1;
	}
	w = ((uint32_t)hdr[8] << 24) | ((uint32_t)hdr[9] << 16) | ((uint32_t)hdr[10] << 8) | hdr[11];
	h = ((uint32_t)hdr[12] << 24) | ((uint32_t)hdr[13] << 16) | ((uint32_t)hdr[14] << 8) | hdr[15];
	if (!w || !h || w > 16384 || h > 16384) {
		fclose(fp);
		return -1;
	}

	s->img = ecalloc(1, sizeof(Image));
	s->img->bufwidth = w;
	s->img->bufheight = h;
	s->img->buf = ecalloc((size_t)w * h, 3);
	rowlen = (size_t)w * 8;
	row = ecalloc(1, rowlen);
	for (off = 0, y = 0; y < h; y++) {
		if (fread(row, 1, rowlen, fp) != rowlen) {
			free(row);
			fclose(fp);
			fffree(s->img);
			s->img = NULL;
			return -1;
		}
		for (x = 0; x < w; x++) {
			unsigned int r = row[x * 8 + 0], g = row[x * 8 + 2],
			             b = row[x * 8 + 4], a = row[x * 8 + 6];
			s->img->buf[off++] = (r * a + sc[ColBg].r * (255 - a)) / 255;
			s->img->buf[off++] = (g * a + sc[ColBg].g * (255 - a)) / 255;
			s->img->buf[off++] = (b * a + sc[ColBg].b * (255 - a)) / 255;
		}
	}
	free(row);
	fclose(fp);
	return 0;
}

void
ffload(Slide *s)
{
	const char *filename, *ext;

	if (s->img || !(filename = s->embed) || !s->embed[0])
		return; /* already done */

	ext = strrchr(filename, '.');
	if (ext && !strcmp(ext, ".ff")) {
		if (ffldfile(s, filename) != 0)
			die("sent: Unable to read farbfeld file '%s'", filename);
	} else {
		if (pngload(s, filename) != 0)
			die("sent: Unable to read image '%s' (PNG and farbfeld supported)", filename);
	}
}

void
ffprepare(Image *img)
{
	int width = xw.uw;
	int height = xw.uh;

	if (xw.uw * img->bufheight > xw.uh * img->bufwidth)
		width = img->bufwidth * xw.uh / img->bufheight;
	else
		height = img->bufheight * xw.uw / img->bufwidth;

	if (width < 1)
		width = 1;
	if (height < 1)
		height = 1;
	free(img->scaled);
	img->scaled = ecalloc((size_t)width * height, sizeof(uint32_t));
	img->scaledwidth = width;
	img->scaledheight = height;

	ffscale(img);
	img->state |= SCALED;
}

void
ffscale(Image *img)
{
	unsigned int x, y;
	unsigned int width = img->scaledwidth;
	unsigned int height = img->scaledheight;
	uint32_t *out = img->scaled;
	unsigned char *ibuf;
	unsigned int dx = (img->bufwidth << 10) / width;

	for (y = 0; y < height; y++) {
		unsigned int bufx = img->bufwidth / width;
		ibuf = &img->buf[(size_t)(y * img->bufheight / height) * img->bufwidth * 3];

		for (x = 0; x < width; x++) {
			unsigned char *p = &ibuf[(bufx >> 10) * 3];
			*out++ = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
			         ((uint32_t)p[2] << 16) | 0xFF000000u;
			bufx += dx;
		}
	}
}

void
ffdraw(Image *img)
{
	uint32_t *px = (uint32_t *)xw.surf->pixels;
	int sw = xw.surf->w, sh = xw.surf->h;
	int xoffset = (xw.w - (int)img->scaledwidth) / 2;
	int yoffset = (xw.h - (int)img->scaledheight) / 2;
	unsigned int x, y;

	for (y = 0; y < img->scaledheight; y++) {
		int dy = yoffset + (int)y;
		if (dy < 0 || dy >= sh)
			continue;
		for (x = 0; x < img->scaledwidth; x++) {
			int dx = xoffset + (int)x;
			if (dx < 0 || dx >= sw)
				continue;
			px[dy * sw + dx] = img->scaled[y * img->scaledwidth + x];
		}
	}
}

void
getfontsize(Slide *s, unsigned int *width, unsigned int *height)
{
	int i, j;
	unsigned int curw, newmax;
	float lfac = linespacing * (s->linecount - 1) + 1;

	/* fit height */
	for (j = NUMFONTSCALES - 1; j >= 0; j--)
		if (fonts[j]->h * lfac <= xw.uh)
			break;
	LIMIT(j, 0, NUMFONTSCALES - 1);
	drw_setfontset(d, fonts[j]);

	/* fit width */
	*width = 0;
	for (i = 0; i < s->linecount; i++) {
		curw = drw_fontset_getwidth(d, s->lines[i]);
		newmax = (curw >= *width);
		while (j > 0 && curw > xw.uw) {
			drw_setfontset(d, fonts[--j]);
			curw = drw_fontset_getwidth(d, s->lines[i]);
		}
		if (newmax)
			*width = curw;
	}
	*height = fonts[j]->h * lfac;
}

void
cleanup(int slidesonly)
{
	unsigned int i, j;

	if (!slidesonly) {
		for (i = 0; i < NUMFONTSCALES; i++)
			drw_fontset_free(fonts[i]);
		free(sc);
		drw_free(d);
	}

	if (slides) {
		for (i = 0; i < slidecount; i++) {
			for (j = 0; j < slides[i].linecount; j++)
				free(slides[i].lines[j]);
			free(slides[i].lines);
			if (slides[i].img)
				fffree(slides[i].img);
		}
		if (!slidesonly) {
			free(slides);
			slides = NULL;
		}
	}
}

void
reload(const Arg *arg)
{
	FILE *fp = NULL;
	unsigned int i;

	if (!fname) {
		fprintf(stderr, "sent: Cannot reload from stdin. Use a file!\n");
		return;
	}

	cleanup(1);
	slidecount = 0;

	if (!(fp = fopen(fname, "r")))
		die("sent: Unable to open '%s' for reading:", fname);
	load(fp);
	fclose(fp);

	LIMIT(idx, 0, slidecount-1);
	for (i = 0; i < slidecount; i++)
		ffload(&slides[i]);
	xdraw();
}

void
load(FILE *fp)
{
	static size_t size = 0;
	size_t blen, maxlines;
	char buf[BUFSIZ], *p;
	Slide *s;

	/* read each line from fp and add it to the item list */
	while (1) {
		/* eat consecutive empty lines */
		while ((p = fgets(buf, sizeof(buf), fp)))
			if (strcmp(buf, "\n") != 0 && buf[0] != '#')
				break;
		if (!p)
			break;

		if ((slidecount+1) * sizeof(*slides) >= size)
			if (!(slides = realloc(slides, (size += BUFSIZ))))
				die("sent: Unable to reallocate %u bytes:", size);

		/* read one slide */
		maxlines = 0;
		memset((s = &slides[slidecount]), 0, sizeof(Slide));
		do {
			/* if there's a leading null, we can't do blen-1 */
			if (buf[0] == '\0')
				continue;

			if (buf[0] == '#')
				continue;

			/* grow lines array */
			if (s->linecount >= maxlines) {
				maxlines = 2 * s->linecount + 1;
				if (!(s->lines = realloc(s->lines, maxlines * sizeof(s->lines[0]))))
					die("sent: Unable to reallocate %u bytes:", maxlines * sizeof(s->lines[0]));
			}

			blen = strlen(buf);
			if (!(s->lines[s->linecount] = strdup(buf)))
				die("sent: Unable to strdup:");
			if (s->lines[s->linecount][blen-1] == '\n')
				s->lines[s->linecount][blen-1] = '\0';

			/* mark as image slide if first line of a slide starts with @ */
			if (s->linecount == 0 && s->lines[0][0] == '@')
				s->embed = &s->lines[0][1];

			if (s->lines[s->linecount][0] == '\\')
				memmove(s->lines[s->linecount], &s->lines[s->linecount][1], blen);
			s->linecount++;
		} while ((p = fgets(buf, sizeof(buf), fp)) && strcmp(buf, "\n") != 0);

		slidecount++;
		if (!p)
			break;
	}

	if (!slidecount)
		die("sent: No slides in file");
}

void
advance(const Arg *arg)
{
	int new_idx = idx + arg->i;
	LIMIT(new_idx, 0, slidecount-1);
	if (new_idx != idx) {
		if (slides[idx].img)
			slides[idx].img->state &= ~SCALED;
		idx = new_idx;
		xdraw();
	}
}

void
quit(const Arg *arg)
{
	running = 0;
}

void
resize(int width, int height)
{
	xw.w = width;
	xw.h = height;
	xw.uw = usablewidth * width;
	xw.uh = usableheight * height;
	drw_resize(d, xw.surf, width, height);
}

void
xdraw(void)
{
	unsigned int height, width, i;
	Image *im = slides[idx].img;

	getfontsize(&slides[idx], &width, &height);
	drw_rect(d, 0, 0, xw.w, xw.h, 1, 0);   /* window background */

	if (!im) {
		for (i = 0; i < slides[idx].linecount; i++)
			drw_text(d,
			         (xw.w - width) / 2,
			         (xw.h - height) / 2 + i * linespacing * d->fonts->h,
			         width,
			         d->fonts->h,
			         0,
			         slides[idx].lines[i],
			         0);
	} else {
		if (!(im->state & SCALED))
			ffprepare(im);
		ffdraw(im);
	}
	SDL_UpdateWindowSurface(xw.win);
}

void
xinit(void)
{
	unsigned int i;

	if (!SDL_Init(SDL_INIT_VIDEO))
		die("sent: Unable to init SDL");
	if (!(xw.win = SDL_CreateWindow("sent", INIT_WIDTH, INIT_HEIGHT,
	                                SDL_WINDOW_RESIZABLE)))
		die("sent: Unable to create window");
	if (!(xw.surf = SDL_GetWindowSurface(xw.win)))
		die("sent: Unable to get window surface");

	if (!(d = drw_create(xw.surf, xw.surf->w, xw.surf->h)))
		die("sent: Unable to create drawing context");
	sc = drw_scm_create(d, colors, 2);
	drw_setscheme(d, sc);

	xloadfonts();
	resize(xw.surf->w, xw.surf->h);
	for (i = 0; i < slidecount; i++)
		ffload(&slides[i]);
}

void
xloadfonts(void)
{
	int i;

	for (i = 0; i < NUMFONTSCALES; i++)
		if (!(fonts[i] = drw_fontset_create(d, fontpaths, LEN(fontpaths), FONTSZ(i))))
			die("sent: Unable to load any font for size %d", FONTSZ(i));
}

static void
bpress(unsigned int button)
{
	unsigned int i;

	for (i = 0; i < LEN(mshortcuts); i++)
		if (button == mshortcuts[i].b && mshortcuts[i].func)
			mshortcuts[i].func(&(mshortcuts[i].arg));
}

static void
kpress(int sym)
{
	unsigned int i;

	for (i = 0; i < LEN(shortcuts); i++)
		if (sym == shortcuts[i].keysym && shortcuts[i].func)
			shortcuts[i].func(&(shortcuts[i].arg));
}

/* Frame callback: drain SDL events, dispatch, exit when quit() ran. */
static void
frame_cb(void)
{
	SDL_Event ev;

	while (SDL_PollEvent(&ev)) {
		switch (ev.type) {
		case SDL_EVENT_KEY_DOWN:
			kpress(ev.key.key);
			break;
		case SDL_EVENT_MOUSE_BUTTON_DOWN:
			bpress(ev.button.button);
			break;
		case SDL_EVENT_MOUSE_WHEEL:
			{
				Arg a;
				a.i = ev.wheel.y < 0 ? +1 : -1;
				if (ev.wheel.y != 0)
					advance(&a);
			}
			break;
		case SDL_EVENT_WINDOW_RESIZED:
			xw.surf = SDL_GetWindowSurface(xw.win);   /* re-derive (SDL3 contract) */
			resize(xw.surf->w, xw.surf->h);
			if (slides[idx].img)
				slides[idx].img->state &= ~SCALED;
			xdraw();
			break;
		case SDL_EVENT_WINDOW_EXPOSED:
			xdraw();
			break;
		case SDL_EVENT_QUIT:
		case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
			running = 0;
			break;
		}
	}
	if (!running) {
		cleanup(0);
		exit(0);
	}
}

void
usage(void)
{
	die("usage: %s [file]", argv0);
}

int
main(int argc, char *argv[])
{
	FILE *fp = NULL;

	ARGBEGIN {
	case 'v':
		fprintf(stderr, "sent-"VERSION"\n");
		return 0;
	default:
		usage();
	} ARGEND

	if (!argv[0] || !strcmp(argv[0], "-"))
		fp = stdin;
	else if (!(fp = fopen(fname = argv[0], "r")))
		die("sent: Unable to open '%s' for reading:", fname);
	load(fp);
	fclose(fp);

	xinit();
	xdraw();

	__setAnimationFrameFunc(frame_cb);
	return 0;
}
