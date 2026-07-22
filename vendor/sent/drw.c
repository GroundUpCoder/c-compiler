/* See LICENSE file for copyright and license details.
 *
 * gucOS port (todos/0119): SDL + freetype implementation of the drw API.
 * One freetype face is shared by every Fnt; a Fnt is just a pixel size.
 * Glyphs render straight into the SDL window surface (RGBA bytes, the
 * term.c convention) with alpha blending against the destination pixel.
 */
#include <SDL.h>
#include <ft2build.h>
#include FT_FREETYPE_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "util.h"
#include "drw.h"

static FT_Library ftlib;
static FT_Face ftface;   /* one face; sized per call */
static unsigned int cur_px;

/* Minimal UTF-8 decode: returns codepoint, advances *s. Invalid bytes decode
 * as U+FFFD one byte at a time so bad input can't wedge the walk. */
static unsigned long
utf8decode(const char **s)
{
	const unsigned char *p = (const unsigned char *)*s;
	unsigned long cp;
	int len, i;

	if (p[0] < 0x80) { cp = p[0]; len = 1; }
	else if ((p[0] & 0xE0) == 0xC0) { cp = p[0] & 0x1F; len = 2; }
	else if ((p[0] & 0xF0) == 0xE0) { cp = p[0] & 0x0F; len = 3; }
	else if ((p[0] & 0xF8) == 0xF0) { cp = p[0] & 0x07; len = 4; }
	else { *s += 1; return 0xFFFD; }
	for (i = 1; i < len; i++) {
		if ((p[i] & 0xC0) != 0x80) { *s += 1; return 0xFFFD; }
		cp = (cp << 6) | (p[i] & 0x3F);
	}
	*s += len;
	return cp;
}

static void
setsize(unsigned int px)
{
	if (px == cur_px)
		return;
	FT_Set_Pixel_Sizes(ftface, 0, px);
	cur_px = px;
}

Drw *
drw_create(SDL_Surface *surf, unsigned int w, unsigned int h)
{
	Drw *drw = ecalloc(1, sizeof(Drw));

	drw->surf = surf;
	drw->w = w;
	drw->h = h;
	return drw;
}

void
drw_resize(Drw *drw, SDL_Surface *surf, unsigned int w, unsigned int h)
{
	drw->surf = surf;
	drw->w = w;
	drw->h = h;
}

void
drw_free(Drw *drw)
{
	free(drw);
}

Fnt *
drw_fontset_create(Drw *drw, const char *paths[], size_t pathcount, unsigned int px)
{
	Fnt *f;
	size_t i;

	(void)drw;
	if (!ftface) {
		if (FT_Init_FreeType(&ftlib))
			die("sent: cannot init freetype");
		for (i = 0; i < pathcount; i++)
			if (!FT_New_Face(ftlib, paths[i], 0, &ftface))
				break;
		if (!ftface)
			die("sent: cannot load any font face");
	}
	f = ecalloc(1, sizeof(Fnt));
	f->px = px;
	setsize(px);
	f->h = (unsigned int)(ftface->size->metrics.height >> 6);
	f->ascent = (int)(ftface->size->metrics.ascender >> 6);
	if (f->h == 0)
		f->h = px;
	return f;
}

void
drw_fontset_free(Fnt *set)
{
	free(set);
}

unsigned int
drw_fontset_getwidth(Drw *drw, const char *text)
{
	unsigned int w = 0;
	unsigned long cp;

	if (!drw->fonts || !text)
		return 0;
	setsize(drw->fonts->px);
	while (*text) {
		cp = utf8decode(&text);
		/* NO_AUTOHINT: keep pre-autofit rendering now the gucOS
		 * freetype build registers a hinter (todos/0279). */
		if (FT_Load_Char(ftface, cp, FT_LOAD_DEFAULT | FT_LOAD_NO_AUTOHINT))
			continue;
		w += (unsigned int)(ftface->glyph->advance.x >> 6);
	}
	return w;
}

void
drw_clr_create(Drw *drw, Clr *dest, const char *clrname)
{
	unsigned long v;

	(void)drw;
	if (clrname[0] != '#' || strlen(clrname) != 7)
		die("sent: color must be #RRGGBB: %s", clrname);
	v = strtoul(clrname + 1, NULL, 16);
	dest->r = (v >> 16) & 0xFF;
	dest->g = (v >> 8) & 0xFF;
	dest->b = v & 0xFF;
	dest->pixel = v;
}

Clr *
drw_scm_create(Drw *drw, const char *clrnames[], size_t clrcount)
{
	size_t i;
	Clr *ret = ecalloc(clrcount, sizeof(Clr));

	for (i = 0; i < clrcount; i++)
		drw_clr_create(drw, &ret[i], clrnames[i]);
	return ret;
}

void
drw_setfontset(Drw *drw, Fnt *set)
{
	drw->fonts = set;
}

void
drw_setscheme(Drw *drw, Clr *scm)
{
	drw->scheme = scm;
}

static unsigned int
clrpack(const Clr *c)
{
	return (unsigned int)c->r | ((unsigned int)c->g << 8) |
	       ((unsigned int)c->b << 16) | 0xFF000000u;
}

void
drw_rect(Drw *drw, int x, int y, unsigned int w, unsigned int h, int filled, int invert)
{
	unsigned int *px = (unsigned int *)drw->surf->pixels;
	int sw = drw->surf->w, sh = drw->surf->h;
	unsigned int pix = clrpack(invert ? &drw->scheme[ColFg] : &drw->scheme[ColBg]);
	int xi, yi;

	(void)filled;
	for (yi = y; yi < y + (int)h && yi < sh; yi++) {
		if (yi < 0)
			continue;
		for (xi = x; xi < x + (int)w && xi < sw; xi++)
			if (xi >= 0)
				px[yi * sw + xi] = pix;
	}
}

int
drw_text(Drw *drw, int x, int y, unsigned int w, unsigned int h, unsigned int lpad, const char *text, int invert)
{
	unsigned int *px = (unsigned int *)drw->surf->pixels;
	int sw = drw->surf->w, sh = drw->surf->h;
	const Clr *fg = &drw->scheme[invert ? ColBg : ColFg];
	int penx, baseline;
	unsigned long cp;

	if (!drw->fonts || !drw->scheme)
		return 0;
	setsize(drw->fonts->px);
	penx = x + (int)lpad;
	baseline = y + ((int)h - (int)drw->fonts->h) / 2 + drw->fonts->ascent;

	while (*text) {
		FT_Bitmap *bm;
		int gx0, gy0, gy, gx;

		cp = utf8decode(&text);
		if (FT_Load_Char(ftface, cp, FT_LOAD_RENDER | FT_LOAD_NO_AUTOHINT))
			continue;
		bm = &ftface->glyph->bitmap;
		gx0 = penx + ftface->glyph->bitmap_left;
		gy0 = baseline - ftface->glyph->bitmap_top;
		for (gy = 0; gy < (int)bm->rows; gy++) {
			int dy = gy0 + gy;
			if (dy < 0 || dy >= sh)
				continue;
			for (gx = 0; gx < (int)bm->width; gx++) {
				int dx = gx0 + gx;
				unsigned int a, dst, r, g, b;
				if (dx < 0 || dx >= sw)
					continue;
				a = bm->buffer[gy * bm->pitch + gx];
				if (!a)
					continue;
				dst = px[dy * sw + dx];
				r = (dst) & 0xFF;
				g = (dst >> 8) & 0xFF;
				b = (dst >> 16) & 0xFF;
				r = r + a * ((unsigned int)fg->r - r) / 255;
				g = g + a * ((unsigned int)fg->g - g) / 255;
				b = b + a * ((unsigned int)fg->b - b) / 255;
				px[dy * sw + dx] = r | (g << 8) | (b << 16) | 0xFF000000u;
			}
		}
		penx += (int)(ftface->glyph->advance.x >> 6);
	}
	(void)w;
	return penx - x;
}
