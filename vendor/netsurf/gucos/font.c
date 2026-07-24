/*
 * Copyright 2005 James Bursa <bursa@users.sourceforge.net>
 *           2008 Vincent Sanders <vince@simtec.co.uk>
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

/*
 * gucOS frontend: the framebuffer frontend's font_freetype.c ported
 * onto the vendored freetype build.  Differences from upstream:
 *
 *  - The FTC cache subsystem is not in the vendored freetype (no
 *    src/cache/), so faces are plain FT_Faces opened once, and
 *    rendered glyphs live in a frontend-owned hash cache keyed by
 *    (face, 26.6 size, codepoint), byte-bounded by the
 *    fb_font_cachesize option (a full flush on overflow — the same
 *    "bounded, reclaimable" contract FTC provided).
 *
 *  - Font files resolve against gucOS font locations (/etc/fonts >
 *    /usr/share/fonts, then the resource paths) instead of a compiled
 *    resource dir; the sans face falls back to the always-baked
 *    mono.ttf so a stock image renders real text everywhere.
 */

#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <limits.h>
#include <unistd.h>

#include <ft2build.h>
#include FT_FREETYPE_H

#include "netsurf/inttypes.h"
#include "utils/filepath.h"
#include "utils/utf8.h"
#include "utils/log.h"
#include "utils/nsoption.h"
#include "netsurf/layout.h"
#include "netsurf/browser.h"
#include "netsurf/plot_style.h"

#include "gucos/gui.h"
#include "gucos/font.h"

/* glyph cache minimum size */
#define CACHE_MIN_SIZE (100 * 1024)

#define BOLD_WEIGHT 700

static FT_Library library;

static int ft_load_type;

enum fb_face_e {
	FB_FACE_SANS_SERIF = 0,
	FB_FACE_SANS_SERIF_BOLD,
	FB_FACE_SANS_SERIF_ITALIC,
	FB_FACE_SANS_SERIF_ITALIC_BOLD,
	FB_FACE_SERIF,
	FB_FACE_SERIF_BOLD,
	FB_FACE_MONOSPACE,
	FB_FACE_MONOSPACE_BOLD,
	FB_FACE_CURSIVE,
	FB_FACE_FANTASY,
	FB_FACE_COUNT
};

typedef struct fb_faceid_s {
	char *fontfile;		/* path to font */
	FT_Face face;		/* opened face (set size before use) */
	FT_F26Dot6 cursize;	/* size the face is currently set to */
} fb_faceid_t;

static fb_faceid_t *fb_faces[FB_FACE_COUNT];

/* ---------------------------------------------------------------- */
/* rendered-glyph cache                                             */
/* ---------------------------------------------------------------- */

struct glyph_ent {
	struct glyph_ent *next;
	fb_faceid_t *face;
	FT_F26Dot6 size;
	uint32_t ucs4;
	gucos_glyph_t g;	/* g.bitmap allocated inline after this */
};

#define GLYPH_HASH_SIZE 1024	/* power of two */

static struct glyph_ent *glyph_hash[GLYPH_HASH_SIZE];
static size_t glyph_cache_bytes;
static size_t glyph_cache_limit;

static unsigned int glyph_key(fb_faceid_t *face, FT_F26Dot6 size, uint32_t ucs4)
{
	uintptr_t h = (uintptr_t)face;
	h = h * 31 + (uintptr_t)size;
	h = h * 31 + ucs4;
	return (unsigned int)(h & (GLYPH_HASH_SIZE - 1));
}

static void glyph_cache_flush(void)
{
	int i;
	for (i = 0; i < GLYPH_HASH_SIZE; i++) {
		struct glyph_ent *ge = glyph_hash[i];
		while (ge != NULL) {
			struct glyph_ent *next = ge->next;
			free(ge);
			ge = next;
		}
		glyph_hash[i] = NULL;
	}
	glyph_cache_bytes = 0;
}

/* ---------------------------------------------------------------- */
/* face management                                                  */
/* ---------------------------------------------------------------- */

/**
 * Locate a font file: an absolute option path is used as-is,
 * otherwise the gucOS font locations then the resource paths are
 * searched for the generic filename.
 */
static char *fb_find_fontfile(const char *option, const char *fontname)
{
	char buf[PATH_MAX];

	if ((option != NULL) && (option[0] == '/')) {
		return strdup(option);
	}
	if (option != NULL) {
		fontname = option;
	}

	snprintf(buf, sizeof(buf), "/etc/fonts/%s", fontname);
	if (access(buf, R_OK) == 0) {
		return strdup(buf);
	}
	snprintf(buf, sizeof(buf), "/usr/share/fonts/%s", fontname);
	if (access(buf, R_OK) == 0) {
		return strdup(buf);
	}
	if (filepath_sfind(respaths, buf, fontname) != NULL) {
		return strdup(buf);
	}
	return NULL;
}

/**
 * create a new face and load it to check it is usable
 */
static fb_faceid_t *fb_new_face(const char *option, const char *fontname)
{
	fb_faceid_t *newf;
	FT_Error error;

	newf = calloc(1, sizeof(fb_faceid_t));
	if (newf == NULL) {
		return NULL;
	}

	newf->fontfile = fb_find_fontfile(option, fontname);
	if (newf->fontfile == NULL) {
		free(newf);
		return NULL;
	}

	error = FT_New_Face(library, newf->fontfile, 0, &newf->face);
	if (error) {
		NSLOG(netsurf, INFO, "Could not load font %s (code %d)",
		      newf->fontfile, error);
		free(newf->fontfile);
		free(newf);
		return NULL;
	}

	/* the unicode charmap is selected by default when present; make
	 * the requirement explicit like upstream */
	FT_Select_Charmap(newf->face, FT_ENCODING_UNICODE);

	NSLOG(netsurf, INFO, "Loaded face from %s", newf->fontfile);

	return newf;
}

/* exported interface documented in gucos/font.h */
bool gucos_font_init(void)
{
	FT_Error error;
	fb_faceid_t *fb_face;
	long cachesize;

	error = FT_Init_FreeType(&library);
	if (error) {
		NSLOG(netsurf, INFO,
		      "Freetype could not be initialised (code %d)", error);
		return false;
	}

	cachesize = nsoption_int(fb_font_cachesize) * 1024;
	if (cachesize < CACHE_MIN_SIZE) {
		cachesize = CACHE_MIN_SIZE;
	}
	glyph_cache_limit = (size_t)cachesize;

	/* Start with the sans serif font; it is the default and must
	 * exist — its last fallback is the always-baked mono face. */
	fb_face = fb_new_face(nsoption_charp(fb_face_sans_serif), "sans.ttf");
	if (fb_face == NULL) {
		fb_face = fb_new_face(NULL, "mono.ttf");
	}
	if (fb_face == NULL) {
		NSLOG(netsurf, INFO, "Could not find the default font");
		FT_Done_FreeType(library);
		return false;
	}
	fb_faces[FB_FACE_SANS_SERIF] = fb_face;

	/* the remaining generic faces fall back exactly like upstream */
	fb_face = fb_new_face(nsoption_charp(fb_face_sans_serif_bold),
			      "sans_bold.ttf");
	fb_faces[FB_FACE_SANS_SERIF_BOLD] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF];

	fb_face = fb_new_face(nsoption_charp(fb_face_sans_serif_italic),
			      "sans_italic.ttf");
	fb_faces[FB_FACE_SANS_SERIF_ITALIC] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF];

	fb_face = fb_new_face(nsoption_charp(fb_face_sans_serif_italic_bold),
			      "sans_italic_bold.ttf");
	fb_faces[FB_FACE_SANS_SERIF_ITALIC_BOLD] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF_ITALIC];

	fb_face = fb_new_face(nsoption_charp(fb_face_serif), "serif.ttf");
	fb_faces[FB_FACE_SERIF] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF];

	fb_face = fb_new_face(nsoption_charp(fb_face_serif_bold),
			      "serif_bold.ttf");
	fb_faces[FB_FACE_SERIF_BOLD] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SERIF];

	fb_face = fb_new_face(nsoption_charp(fb_face_monospace), "mono.ttf");
	fb_faces[FB_FACE_MONOSPACE] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF];

	fb_face = fb_new_face(nsoption_charp(fb_face_monospace_bold),
			      "mono_bold.ttf");
	fb_faces[FB_FACE_MONOSPACE_BOLD] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_MONOSPACE];

	fb_face = fb_new_face(nsoption_charp(fb_face_cursive), "cursive.ttf");
	fb_faces[FB_FACE_CURSIVE] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF];

	fb_face = fb_new_face(nsoption_charp(fb_face_fantasy), "fantasy.ttf");
	fb_faces[FB_FACE_FANTASY] =
		(fb_face != NULL) ? fb_face : fb_faces[FB_FACE_SANS_SERIF];

	/* set the default render mode */
	if (nsoption_bool(fb_font_monochrome) == true) {
		ft_load_type = FT_LOAD_MONOCHROME; /* faster but less pretty */
	} else {
		ft_load_type = 0;
	}

	return true;
}

/* exported interface documented in gucos/font.h */
void gucos_font_fini(void)
{
	int i, j;

	glyph_cache_flush();

	for (i = 0; i < FB_FACE_COUNT; i++) {
		if (fb_faces[i] == NULL) {
			continue;
		}
		/* unset any entries that duplicate this one */
		for (j = i + 1; j < FB_FACE_COUNT; j++) {
			if (fb_faces[i] == fb_faces[j]) {
				fb_faces[j] = NULL;
			}
		}
		FT_Done_Face(fb_faces[i]->face);
		free(fb_faces[i]->fontfile);
		free(fb_faces[i]);
		fb_faces[i] = NULL;
	}

	FT_Done_FreeType(library);
}

/**
 * style to face + 26.6 pixel size (upstream fb_fill_scalar)
 */
static fb_faceid_t *
fb_style_to_face(const plot_font_style_t *fstyle, FT_F26Dot6 *size_out)
{
	int selected_face = FB_FACE_SANS_SERIF;

	switch (fstyle->family) {

	case PLOT_FONT_FAMILY_SERIF:
		if (fstyle->weight >= BOLD_WEIGHT) {
			selected_face = FB_FACE_SERIF_BOLD;
		} else {
			selected_face = FB_FACE_SERIF;
		}
		break;

	case PLOT_FONT_FAMILY_MONOSPACE:
		if (fstyle->weight >= BOLD_WEIGHT) {
			selected_face = FB_FACE_MONOSPACE_BOLD;
		} else {
			selected_face = FB_FACE_MONOSPACE;
		}
		break;

	case PLOT_FONT_FAMILY_CURSIVE:
		selected_face = FB_FACE_CURSIVE;
		break;

	case PLOT_FONT_FAMILY_FANTASY:
		selected_face = FB_FACE_FANTASY;
		break;

	case PLOT_FONT_FAMILY_SANS_SERIF:
	default:
		if ((fstyle->flags & FONTF_ITALIC) ||
		    (fstyle->flags & FONTF_OBLIQUE)) {
			if (fstyle->weight >= BOLD_WEIGHT) {
				selected_face = FB_FACE_SANS_SERIF_ITALIC_BOLD;
			} else {
				selected_face = FB_FACE_SANS_SERIF_ITALIC;
			}
		} else {
			if (fstyle->weight >= BOLD_WEIGHT) {
				selected_face = FB_FACE_SANS_SERIF_BOLD;
			} else {
				selected_face = FB_FACE_SANS_SERIF;
			}
		}
	}

	/* 26.6 point size; FT_Set_Char_Size applies the dpi */
	*size_out = (fstyle->size * 64) / PLOT_STYLE_SCALE;

	return fb_faces[selected_face];
}

/* exported interface documented in gucos/font.h */
const gucos_glyph_t *
gucos_getglyph(const struct plot_font_style *fstyle, uint32_t ucs4)
{
	fb_faceid_t *fb_face;
	FT_F26Dot6 size;
	unsigned int key;
	struct glyph_ent *ge;
	FT_Error error;
	FT_GlyphSlot slot;
	FT_UInt glyph_index;
	size_t bmbytes;

	fb_face = fb_style_to_face(fstyle, &size);
	if (fb_face == NULL) {
		return NULL;
	}

	key = glyph_key(fb_face, size, ucs4);
	for (ge = glyph_hash[key]; ge != NULL; ge = ge->next) {
		if ((ge->face == fb_face) && (ge->size == size) &&
		    (ge->ucs4 == ucs4)) {
			return &ge->g;
		}
	}

	/* render it */
	if (fb_face->cursize != size) {
		error = FT_Set_Char_Size(fb_face->face, 0, size,
					 browser_get_dpi(), browser_get_dpi());
		if (error) {
			return NULL;
		}
		fb_face->cursize = size;
	}

	glyph_index = FT_Get_Char_Index(fb_face->face, ucs4);

	error = FT_Load_Glyph(fb_face->face, glyph_index,
			      FT_LOAD_RENDER | FT_LOAD_FORCE_AUTOHINT |
			      ft_load_type);
	if (error) {
		return NULL;
	}

	slot = fb_face->face->glyph;
	bmbytes = (size_t)abs(slot->bitmap.pitch) * slot->bitmap.rows;

	/* byte-bounded cache: flush wholesale when full (the FTC
	 * contract: bounded and reclaimable, never wedged) */
	if (glyph_cache_bytes + sizeof(*ge) + bmbytes > glyph_cache_limit) {
		glyph_cache_flush();
	}

	ge = malloc(sizeof(*ge) + bmbytes);
	if (ge == NULL) {
		return NULL;
	}
	ge->face = fb_face;
	ge->size = size;
	ge->ucs4 = ucs4;
	ge->g.advance_x = slot->advance.x >> 6;
	ge->g.left = slot->bitmap_left;
	ge->g.top = slot->bitmap_top;
	ge->g.width = slot->bitmap.width;
	ge->g.rows = slot->bitmap.rows;
	ge->g.pitch = slot->bitmap.pitch;
	ge->g.mono = (slot->bitmap.pixel_mode == FT_PIXEL_MODE_MONO);
	if (bmbytes > 0) {
		ge->g.bitmap = (uint8_t *)(ge + 1);
		memcpy(ge->g.bitmap, slot->bitmap.buffer, bmbytes);
	} else {
		ge->g.bitmap = NULL;
	}

	ge->next = glyph_hash[key];
	glyph_hash[key] = ge;
	glyph_cache_bytes += sizeof(*ge) + bmbytes;

	return &ge->g;
}

/* ---------------------------------------------------------------- */
/* the three layout ops (upstream, over gucos_glyph advances)       */
/* ---------------------------------------------------------------- */

static nserror
gucos_font_width(const plot_font_style_t *fstyle,
		 const char *string, size_t length, int *width)
{
	uint32_t ucs4;
	size_t nxtchr = 0;
	const gucos_glyph_t *glyph;

	*width = 0;
	while (nxtchr < length) {
		ucs4 = utf8_to_ucs4(string + nxtchr, length - nxtchr);
		nxtchr = utf8_next(string, length, nxtchr);

		glyph = gucos_getglyph(fstyle, ucs4);
		if (glyph == NULL)
			continue;

		*width += glyph->advance_x;
	}
	return NSERROR_OK;
}

static nserror
gucos_font_position(const plot_font_style_t *fstyle,
		    const char *string, size_t length,
		    int x, size_t *char_offset, int *actual_x)
{
	uint32_t ucs4;
	size_t nxtchr = 0;
	const gucos_glyph_t *glyph;
	int prev_x = 0;

	*actual_x = 0;
	while (nxtchr < length) {
		ucs4 = utf8_to_ucs4(string + nxtchr, length - nxtchr);

		glyph = gucos_getglyph(fstyle, ucs4);
		if (glyph == NULL) {
			nxtchr = utf8_next(string, length, nxtchr);
			continue;
		}

		*actual_x += glyph->advance_x;
		if (*actual_x > x)
			break;

		prev_x = *actual_x;
		nxtchr = utf8_next(string, length, nxtchr);
	}

	/* choose nearest of previous and last x */
	if (abs(*actual_x - x) > abs(prev_x - x))
		*actual_x = prev_x;

	*char_offset = nxtchr;
	return NSERROR_OK;
}

/**
 * Find where to split a string to make it fit a width (upstream
 * contract: char_offset gives the split point closest to x with
 * actual_x <= x, else the first possible split; length = no split).
 */
static nserror
gucos_font_split(const plot_font_style_t *fstyle,
		 const char *string, size_t length,
		 int x, size_t *char_offset, int *actual_x)
{
	uint32_t ucs4;
	size_t nxtchr = 0;
	int last_space_x = 0;
	int last_space_idx = 0;
	const gucos_glyph_t *glyph;

	*actual_x = 0;
	while (nxtchr < length) {
		ucs4 = utf8_to_ucs4(string + nxtchr, length - nxtchr);

		glyph = gucos_getglyph(fstyle, ucs4);
		if (glyph == NULL) {
			nxtchr = utf8_next(string, length, nxtchr);
			continue;
		}

		if (ucs4 == 0x20) {
			last_space_x = *actual_x;
			last_space_idx = nxtchr;
		}

		*actual_x += glyph->advance_x;
		if (*actual_x > x && last_space_idx != 0) {
			/* string exceeded the available width and a
			 * space was seen; return the previous space */
			*actual_x = last_space_x;
			*char_offset = last_space_idx;
			return NSERROR_OK;
		}

		nxtchr = utf8_next(string, length, nxtchr);
	}

	*char_offset = nxtchr;

	return NSERROR_OK;
}

static struct gui_layout_table layout_table = {
	.width = gucos_font_width,
	.position = gucos_font_position,
	.split = gucos_font_split,
};

struct gui_layout_table *gucos_layout_table = &layout_table;
