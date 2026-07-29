/*
 * Copyright 2009 John-Mark Bell <jmb@netsurf-browser.org>
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

#ifndef NETSURF_CSS_SELECT_H_
#define NETSURF_CSS_SELECT_H_

#include <stdint.h>

#include <dom/dom.h>

#include <libcss/libcss.h>

struct content;
struct nsurl;

/**
 * Selection context
 */
typedef struct nscss_select_ctx
{
	css_select_ctx *ctx;
	bool quirks;
	struct nsurl *base_url;
	lwc_string *universal;
	const css_computed_style *root_style;
	const css_computed_style *parent_style;
	/**
	 * Deepest element under the pointer, or NULL.  `:hover` matches
	 * this node and every ancestor of it (todos/0420).  The pointer is
	 * BORROWED for the call: the html_content owns the reference.
	 *
	 * Read only by the pseudo-class callbacks, which need a node.  The
	 * blank-style path (nscss_get_blank_style, used for the anonymous
	 * table boxes) has no node and never reaches them, so its callers
	 * leave this unset — exactly as they already leave parent_style.
	 */
	struct dom_node *hover_node;
	/**
	 * Deepest element the primary button went down on, or NULL.
	 * `:active` matches this node and every ancestor of it.  Same
	 * borrowing and same read scope as hover_node.
	 */
	struct dom_node *active_node;
} nscss_select_ctx;

css_stylesheet *nscss_create_inline_style(const uint8_t *data, size_t len,
		const char *charset, const char *url, bool allow_quirks);

css_select_results *nscss_get_style(nscss_select_ctx *ctx, dom_node *n,
		const css_media *media,
		const css_unit_ctx *unit_len_ctx,
		const css_stylesheet *inline_style);

css_computed_style *nscss_get_blank_style(nscss_select_ctx *ctx,
		const css_unit_ctx *unit_len_ctx,
		const css_computed_style *parent);


css_error named_ancestor_node(void *pw, void *node,
		const css_qname *qname, void **ancestor);

css_error node_is_visited(void *pw, void *node, bool *match);

/**
 * Drop the cached libcss node data from a DOM node, freeing it properly.
 *
 * Used by the live re-conversion path: re-styling a document behaves
 * like styling a fresh one, so every node's style cache must go first
 * (set_libcss_node_data asserts no stale data is being replaced).
 *
 * \param node  DOM node to clear (no-op if it carries no data)
 */
void nscss_node_data_clear(struct dom_node *node);

#endif
