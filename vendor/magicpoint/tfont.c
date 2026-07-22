/*
 * tfont.c — gucOS port (todos/0119): the TrueType glyph engine rewritten
 * from FreeType 1 (TT_* API, 5-level gray pixmaps) to FreeType 2, keeping
 * upstream's interface and cache design:
 *
 *   - struct tfont fields and the hash+LRU cache are upstream's;
 *   - dbitmap is now an 8-bit coverage map (0..255) instead of 0..4
 *     levels, and tfc_image() alpha-blends fore over the XImage's
 *     existing pixels (which draw.c prefills with the background), so
 *     the old 5-entry color-ramp machinery is gone;
 *   - char size semantics match upstream: 96dpi at size*0.75pt is
 *     exactly `size` pixels, so FT_Set_Pixel_Sizes(face, 0, size);
 *   - one FT_Face per font file, cached like upstream's TT_Face table;
 *   - codes are byte values (latin1) or latin2-4 remapped through
 *     latin_unicode_map, exactly like upstream's CharToUnicode; the
 *     charset16 (JIS) path is not built (FREETYPE_CHARSET16 undefined).
 */
#include "mgp.h"

#ifdef FREETYPE

#include <ft2build.h>
#include FT_FREETYPE_H

int tfcachesize = 3000; /*XXX*/
#define	TFFONT_NUM	128
#define	TFHASH_SIZE	255
#define TFCACHE_HASH(c, siz)   ((c ^ siz) % TFHASH_SIZE)

static FT_Library	engine;
static FT_Face		face[TFFONT_NUM];

static char *tf_curname[4]; /* contains iso8859-[2-4] fonts */
static char *tf_mcurname = NULL;
static int tfcinitdone;
static int tfcachecnt;
static struct tfont tfclru;
static struct tfont tfcache[TFHASH_SIZE];
static int tffontcnt = 0;
static int tfcachehit = 0;
static int tfcachemiss = 0;
static int tfcuridx = -1;
static char tfloadedfont[1024][TFFONT_NUM];
static int tfloadedregistry[TFFONT_NUM];
static unsigned int tfcursize;   /* current pixel size on face[tfcuridx] */

#define TFC_INSHASH(tfc) { \
	struct tfont *h, *n;						\
	h = &tfcache[TFCACHE_HASH(tfc->code, tfc->size)]; \
	n = h->next; tfc->next = n; n->prev = tfc;			\
	h->next = tfc; tfc->prev = h;					\
}
#define TFC_DELHASH(tfc) { \
	struct tfont *n, *p;						\
	n = tfc->next; p = tfc->prev;					\
	n->prev = p; p->next = n;					\
}
#define TFC_INSLRU(tfc) { \
	struct tfont *p;						\
	p = tfclru.lruprev; tfc->lruprev = p; p->lrunext = tfc;		\
	tfclru.lruprev = tfc; tfc->lrunext = &tfclru;			\
}
#define TFC_DELLRU(tfc) { \
	struct tfont *n, *p;						\
	n = tfc->lrunext; p = tfc->lruprev;				\
	n->lruprev = p; p->lrunext = n;					\
}

static void tfc_init __P((void));
static void tfc_free __P((struct tfont *));
static struct tfont *tfc_lookup __P((u_int, u_int, char*, int));
static struct tfont *tfc_alloc __P((u_int, u_int, char *, char *));
static long CharToUnicode __P((u_int, char *));

static void
tfc_init()
{
	u_int	i;
	struct tfont *tfc;

	if (FT_Init_FreeType(&engine)) {
		fprintf(stderr, "Error while initializing freetype.\n");
		cleanup(-1);
	}

	for (tfc = tfcache, i = 0; i < TFHASH_SIZE; tfc++, i++)
		tfc->next = tfc->prev = tfc;
	tfclru.lrunext = tfclru.lruprev = &tfclru;
	tfcinitdone ++;

	latin_unicode_map_init();
}

static void
tfc_free(tfc)
	struct tfont *tfc;
{
	TFC_DELHASH(tfc);
	TFC_DELLRU(tfc);
	free(tfc->fontname);
	free(tfc->dbitmap);
	free(tfc);
	tfcachecnt--;
}

int
tfc_setsize(char_size)
	u_int char_size;
{
	if (!tfcinitdone)
		return -1;
	if (tfcuridx < 0 || tffontcnt <= tfcuridx)
		return -1;
	if (char_size < 1)
		char_size = 1;
	if (FT_Set_Pixel_Sizes(face[tfcuridx], 0, char_size)) {
		fprintf(stderr, "Could not set size %u for \"%s\".\n",
			char_size, tfloadedfont[tfcuridx]);
		return -1;
	}
	tfcursize = char_size;
	return 0;
}

struct tfont *
tfc_get(code, size, force, registry, charset16)
	u_int code, size;
	int force;
	char *registry;
	int charset16;
{
	struct tfont *tfc, *ntfc;
	int	regid;

	if (!tfcinitdone)
		tfc_init();

	if (charset16)
		return NULL;   /* 2-octet charsets not built in this port */

	if (code >= 0xa0 && ((!registry || !registry[0]) && mgp_charset))
		regid = get_regid(mgp_charset);
	else
		regid = get_regid(registry);
	tfc = tfc_lookup(code, size, tf_curname[regid], regid);

	if (tfc == NULL) {
		if (tfcachecnt >= tfcachesize) {
			if (!force)
				return NULL;
			tfc = tfclru.lrunext;
			while (tfcachecnt >= tfcachesize) {
				if (tfc == &tfclru)
					break;
				ntfc = tfc->lrunext;
				if (tfc->ref == 0)
					tfc_free(tfc);
				tfc = ntfc;
			}
		}
		tfc = tfc_alloc(code, size, tf_curname[regid], registry);
	}
	return tfc;
}

void
tfc_setfont(name, charset16, registry)
	char *name;
	int charset16;  /*2-octet charset?*/
	char *registry;
{
	char *fontname = NULL;
	u_int i, regid = 0;
	char pathname[MAXPATHLEN];
	int trial;
	FT_Face	tface;

	if (!tfcinitdone)
		tfc_init();

	if (charset16)
		return;   /* 2-octet fonts not built in this port */

	if (TFFONT_NUM <= tffontcnt) {
		fprintf(stderr, "internal error: "
			"too many fonts opened (increase TFFONT_NUM)\n");
		cleanup(-1);
	}

	if (!name || !name[0]) {
		if (freetypefont0 && freetypefont0[0])
			name = freetypefont0;
		else
			goto fail;
	}

	/* check font cache first */
	for (trial = 0; trial < 2; trial++) {
		fontname = name;
		if (trial == 1) {
			snprintf(pathname, sizeof(pathname),
				"%s/%s", freetypefontdir, name);
			fontname = pathname;
		}
		for (i = 0; i < tffontcnt; i ++) {
			if (!strcmp(fontname, tfloadedfont[i])) {
				tfcuridx = i;
				regid = get_regid(registry);
				tf_curname[regid] = tfloadedfont[i];
				return;
			}
		}
	}

	/* try to load font */
	tface = NULL;
	for (trial = 0; trial < 3; trial++) {
		switch (trial) {
		case 0:
			fontname = name;
			break;
		case 1:
			snprintf(pathname, sizeof(pathname),
				"%s/%s", freetypefontdir, name);
			fontname = pathname;
			break;
		case 2:
			if (!freetypefont0 || !freetypefont0[0])
				continue;
			fontname = freetypefont0;
			for (i = 0; i < tffontcnt; i ++) {
				if (!strcmp(fontname, tfloadedfont[i])){
					tfcuridx = i;
					goto cached;
				}
			}
			break;
		}
		if (verbose)
			fprintf(stderr, "trying to open font \"%s\"\n", fontname);
		if (!FT_New_Face(engine, fontname, 0, &tface))
			break;
		tface = NULL;
	}
	if (!tface) {
		if (verbose)
			fprintf(stderr, "could not load font \"%s\"\n", name);
		goto fail;
	}

	if ((regid = get_regid(registry)) < 0) {
		fprintf(stderr, "font \"%s\" has irregal registry\n", fontname);
		FT_Done_Face(tface);
		goto fail;
	}

	tfloadedregistry[tffontcnt] = regid;
	strcpy(tfloadedfont[tffontcnt], fontname);
	tfcuridx = tffontcnt;
	face[tfcuridx] = tface;
	tffontcnt++;

cached:
	if (registry)
		tf_curname[regid] = tfloadedfont[tfcuridx];
	else {
		/* this should be default font */
		for (i = 0; i < 4; i ++)
			tf_curname[i] = tfloadedfont[tfcuridx];
	}
	tfcursize = 0;
	if (tfc_setsize(char_size[caching]) < 0) {
		tffontcnt--;
		goto fail;
	}
	return;

fail:
	tf_curname[regid] = "";
	tfcuridx = -1;
	return;
}

static struct tfont *
tfc_lookup(code, size, fontname, regid)
	u_int code, size;
	char *fontname;
	int	regid;
{
	u_int	i;
	struct tfont *tfc, *htfc;

	if (!fontname)
		return NULL;

	for (i = 0; i < tffontcnt; i ++) {
		if (!strcmp(fontname, tfloadedfont[i]))
			tfcuridx = i;
	}

	htfc = &tfcache[TFCACHE_HASH(code, size)];
	for (tfc = htfc->next; tfc != htfc; tfc = tfc->next) {
		if (tfc->code == code
		 && tfc->size == size
		 && tfc->regid == regid
		 && strcmp(tfc->fontname, fontname) == 0) {
			tfcachehit++;
			TFC_DELLRU(tfc);
			TFC_INSLRU(tfc);
			return tfc;
		}
	}
	tfcachemiss++;

	return NULL;
}

static struct tfont *
tfc_alloc(code, size, fontname, registry)
	u_int code, size;
	char *fontname;
	char *registry;
{
	struct tfont *tfc;
	long unicode;
	FT_Face f;
	FT_GlyphSlot slot;
	FT_UInt gidx;
	unsigned int y;

	/* if no font was ever loaded, try loading the last resort font */
	if (!tffontcnt)
		tfc_setfont(NULL, 0, NULL);

	if (tfcuridx < 0 || tffontcnt <= tfcuridx)
		return NULL;
	if (fontname == NULL)
		return NULL;

	/* This is required! (size may have changed since the last glyph) */
	if (tfcursize != char_size[caching] && tfc_setsize(char_size[caching]) < 0)
		return NULL;

	unicode = CharToUnicode(code, registry);
	if (!unicode)
		return NULL;

	f = face[tfcuridx];
	gidx = FT_Get_Char_Index(f, (FT_ULong)unicode);
	if (gidx == 0 && verbose)
		fprintf(stderr, "no glyph for 0x%04lx in \"%s\"\n",
			unicode, tfloadedfont[tfcuridx]);
	/* NO_AUTOHINT: keep pre-autofit rendering now the gucOS freetype
	 * build registers a hinter (todos/0279). */
	if (FT_Load_Glyph(f, gidx, FT_LOAD_DEFAULT | FT_LOAD_NO_AUTOHINT))
		return NULL;
	if (FT_Render_Glyph(f->glyph, FT_RENDER_MODE_NORMAL))
		return NULL;
	slot = f->glyph;

	tfc = (struct tfont *)malloc(sizeof(*tfc));
	if (tfc == NULL) {
		fprintf(stderr, "tfc_alloc: malloc failed\n");
		return NULL;
	}

	tfc->code = code;
	tfc->size = size;
	tfc->width = slot->bitmap.width;
	tfc->bwidth = slot->bitmap.width;   /* dbitmap rows are packed */
	tfc->height = slot->bitmap.rows;
	tfc->ascent = slot->bitmap_top;
	tfc->descent = (int)slot->bitmap.rows - slot->bitmap_top;
	tfc->xoff = slot->bitmap_left;
	tfc->fontname = strdup(fontname);
	tfc->charlen = (u_int)(slot->advance.x >> 6);
	tfc->xmax = (u_int)(slot->bitmap_left + (int)slot->bitmap.width);
	tfc->ref = 0;
	tfc->regid = get_regid(registry);
	if (!tfc->charlen)
		tfc->charlen = 1;

	tfc->dbitmap = malloc((size_t)tfc->bwidth * tfc->height + 1);
	if (tfc->dbitmap == NULL) {
		free(tfc->fontname);
		free(tfc);
		return NULL;
	}
	for (y = 0; y < tfc->height; y++)
		memcpy(tfc->dbitmap + (size_t)y * tfc->bwidth,
		       slot->bitmap.buffer + (size_t)y * slot->bitmap.pitch,
		       tfc->bwidth);

	TFC_INSHASH(tfc);
	TFC_INSLRU(tfc);
	tfcachecnt++;

	return tfc;
}

static long
CharToUnicode(code, registry)
	u_int code;
	char *registry;
{
	/* latin2-4 encoding processing (upstream logic, sans charmap walk —
	 * FT2's default charmap is already Unicode) */
	if (code > 0xa0 && code < 256) {
		int tempregid = -1;
		if (registry)
			tempregid = get_regid(registry) - 1;
		else if (mgp_charset)
			tempregid = get_regid(mgp_charset) - 1;
		if (tempregid >= 0 && latin_unicode_map[tempregid][code])
			return latin_unicode_map[tempregid][code];
	}
	return (long)code;
}

/*
 * NOTE: this is upper-layer's responsibility to adjust the (bx, by)
 * so that the font bitmap fits into the given XImage.
 * see draw_onechar_tf() for the code.
 */
XImage *
tfc_image(tfc, fore, back, xim, bx, by)
	struct tfont *tfc;
	long fore, back;
	XImage *xim;
	int bx, by;
{
	int x, y;
	u_char a, *s;
	unsigned long dst, fr, fg, fb, r, g, b;

	(void)back;   /* blending over the prefilled XImage replaces the ramp */
	fr = ((unsigned long)fore >> 16) & 0xff;
	fg = ((unsigned long)fore >> 8) & 0xff;
	fb = (unsigned long)fore & 0xff;

	s = tfc->dbitmap;
	for (y = 0; y < (int)tfc->height; y++) {
		for (x = 0; x < (int)tfc->bwidth; x++) {
			a = *s++;
			if (!a || x >= (int)tfc->width)
				continue;
			dst = XGetPixel(xim, bx + tfc->xoff + x,
				by - tfc->ascent + y);
			r = (dst >> 16) & 0xff;
			g = (dst >> 8) & 0xff;
			b = dst & 0xff;
			r = (unsigned long)((long)r + (long)a * ((long)fr - (long)r) / 255);
			g = (unsigned long)((long)g + (long)a * ((long)fg - (long)g) / 255);
			b = (unsigned long)((long)b + (long)a * ((long)fb - (long)b) / 255);
			XPutPixel(xim, bx + tfc->xoff + x,
				by - tfc->ascent + y,
				(r << 16) | (g << 8) | b);
		}
	}
	return xim;
}

#endif /* FREETYPE */
