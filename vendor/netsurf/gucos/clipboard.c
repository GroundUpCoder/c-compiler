/*
 * Copyright 2013 Vincent Sanders <vince@netsurf-browser.org>
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
 * gucOS clipboard table over the SDL veneer clipboard (the kernel's
 * one cross-process slot — selections copy to/paste from every other
 * gucOS app).
 */

#include <stdlib.h>
#include <string.h>

#include <SDL.h>

#include "utils/log.h"
#include "netsurf/clipboard.h"

#include "gucos/clipboard.h"

/**
 * Core asks front end for clipboard contents.
 *
 * \param  buffer  UTF-8 text, allocated by front end, ownership yielded to core
 * \param  length  Byte length of UTF-8 text in buffer
 */
static void gui_get_clipboard(char **buffer, size_t *length)
{
	char *clip;
	size_t len;

	*buffer = NULL;
	*length = 0;

	clip = SDL_GetClipboardText();	/* never NULL; "" when empty */
	len = strlen(clip);
	if (len > 0) {
		*buffer = malloc(len);
		if (*buffer != NULL) {
			memcpy(*buffer, clip, len);
			*length = len;
		}
	}
	SDL_free(clip);
}

/**
 * Core tells front end to put given text in clipboard.
 *
 * \param  buffer    UTF-8 text, owned by core
 * \param  length    Byte length of UTF-8 text in buffer
 * \param  styles    Array of styles given to text runs, owned by core, or NULL
 * \param  n_styles  Number of text run styles in array
 */
static void gui_set_clipboard(const char *buffer, size_t length,
		nsclipboard_styles styles[], int n_styles)
{
	char *text;

	text = malloc(length + 1);
	if (text == NULL) {
		return;
	}
	memcpy(text, buffer, length);
	text[length] = '\0';

	SDL_SetClipboardText(text);

	free(text);
}

static struct gui_clipboard_table clipboard_table = {
	.get = gui_get_clipboard,
	.set = gui_set_clipboard,
};

struct gui_clipboard_table *gucos_clipboard_table = &clipboard_table;
