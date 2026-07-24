/*
 * Copyright 2012 Vincent Sanders <vince@netsurf-browser.org>
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
 * gucOS frontend options (the framebuffer frontend's font options,
 * near-verbatim — the fb_* names are kept so upstream documentation
 * and Choices files transfer).  Pulled into utils/nsoption.h via the
 * nsgucos target define (see ../patches/netsurf.diff).
 */

#ifndef NETSURF_GUCOS_OPTIONS_H
#define NETSURF_GUCOS_OPTIONS_H

/* currently nothing here */

#endif

/** url history file location (the monkey/riscos-heritage option the
 * core's urldb load/save expects a frontend to define) */
NSOPTION_STRING(url_file, NULL)

/***** font options *****/

/** render all fonts monochrome */
NSOPTION_BOOL(fb_font_monochrome, false)
/** size of font glyph cache in kilobytes. */
NSOPTION_INTEGER(fb_font_cachesize, 2048)

/* Font face paths. These are treated as absolute paths if they start
 * with a / otherwise the font resource path is searched.
 */
NSOPTION_STRING(fb_face_sans_serif, NULL)
NSOPTION_STRING(fb_face_sans_serif_bold, NULL)
NSOPTION_STRING(fb_face_sans_serif_italic, NULL)
NSOPTION_STRING(fb_face_sans_serif_italic_bold, NULL)
NSOPTION_STRING(fb_face_serif, NULL)
NSOPTION_STRING(fb_face_serif_bold, NULL)
NSOPTION_STRING(fb_face_monospace, NULL)
NSOPTION_STRING(fb_face_monospace_bold, NULL)
NSOPTION_STRING(fb_face_cursive, NULL)
NSOPTION_STRING(fb_face_fantasy, NULL)
