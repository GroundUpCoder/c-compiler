/* See LICENSE file for copyright and license details.
 *
 * gucOS port (todos/0119): the suckless drw layer rebuilt over SDL +
 * freetype. Same API shape sent.c consumes (fontsets, schemes, rect/text),
 * but a Drawable is the SDL window surface and a Fnt is a pixel size on
 * ONE shared freetype face (the baked mono.ttf) instead of an Xft fontset.
 */

typedef struct {
	unsigned char r, g, b;
	unsigned long pixel;   /* 0xRRGGBB, kept for sent.c's blend math */
} Clr;

enum { ColFg, ColBg }; /* Clr scheme index */

typedef struct Fnt {
	unsigned int px;   /* requested pixel size */
	unsigned int h;    /* line height at that size */
	int ascent;
} Fnt;

typedef struct {
	unsigned int w, h;
	SDL_Surface *surf;
	Clr *scheme;
	Fnt *fonts;
} Drw;

/* Drawable abstraction */
Drw *drw_create(SDL_Surface *surf, unsigned int w, unsigned int h);
void drw_resize(Drw *drw, SDL_Surface *surf, unsigned int w, unsigned int h);
void drw_free(Drw *drw);

/* Fnt abstraction (one face; a fontset is a pixel size) */
Fnt *drw_fontset_create(Drw *drw, const char *paths[], size_t pathcount, unsigned int px);
void drw_fontset_free(Fnt *set);
unsigned int drw_fontset_getwidth(Drw *drw, const char *text);

/* Colorscheme abstraction */
void drw_clr_create(Drw *drw, Clr *dest, const char *clrname);
Clr *drw_scm_create(Drw *drw, const char *clrnames[], size_t clrcount);

/* Drawing context manipulation */
void drw_setfontset(Drw *drw, Fnt *set);
void drw_setscheme(Drw *drw, Clr *scm);

/* Drawing functions */
void drw_rect(Drw *drw, int x, int y, unsigned int w, unsigned int h, int filled, int invert);
int drw_text(Drw *drw, int x, int y, unsigned int w, unsigned int h, unsigned int lpad, const char *text, int invert);
