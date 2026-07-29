/*
 * Copyright 2020 Vincent Sanders <vince@netsurf-browser.org>
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
 * HTML Box tree construction interface.
 *
 * This stage of rendering converts a tree of dom_nodes (produced by libdom)
 * to a tree of struct box. The box tree represents the structure of the
 * document as given by the CSS display and float properties.
 *
 * For example, consider the following HTML:
 * \code
 *   <h1>Example Heading</h1>
 *   <p>Example paragraph <em>with emphasised text</em> etc.</p>       \endcode
 *
 * This would produce approximately the following box tree with default CSS
 * rules:
 * \code
 *   BOX_BLOCK (corresponds to h1)
 *     BOX_INLINE_CONTAINER
 *       BOX_INLINE "Example Heading"
 *   BOX_BLOCK (p)
 *     BOX_INLINE_CONTAINER
 *       BOX_INLINE "Example paragraph "
 *       BOX_INLINE "with emphasised text" (em)
 *       BOX_INLINE "etc."                                             \endcode
 *
 * Note that the em has been collapsed into the INLINE_CONTAINER.
 *
 * If these CSS rules were applied:
 * \code
 *   h1 { display: table-cell }
 *   p { display: table-cell }
 *   em { float: left; width: 5em }                                    \endcode
 *
 * then the box tree would instead look like this:
 * \code
 *   BOX_TABLE
 *     BOX_TABLE_ROW_GROUP
 *       BOX_TABLE_ROW
 *         BOX_TABLE_CELL (h1)
 *           BOX_INLINE_CONTAINER
 *             BOX_INLINE "Example Heading"
 *         BOX_TABLE_CELL (p)
 *           BOX_INLINE_CONTAINER
 *             BOX_INLINE "Example paragraph "
 *             BOX_FLOAT_LEFT (em)
 *               BOX_BLOCK
 *                 BOX_INLINE_CONTAINER
 *                   BOX_INLINE "with emphasised text"
 *             BOX_INLINE "etc."                                       \endcode
 *
 * Here implied boxes have been added and a float is present.
 */

#ifndef NETSURF_HTML_BOX_CONSTRUCT_H
#define NETSURF_HTML_BOX_CONSTRUCT_H

/**
 * Construct a box tree from a dom and html content
 *
 * \param n dom document
 * \param c content of type CONTENT_HTML to construct box tree in
 * \param cb callback to report conversion completion
 * \param box_conversion_context pointer that recives the conversion context
 * \return netsurf error code indicating status of call
 */
nserror dom_to_box(struct dom_node *n, struct html_content *c, box_construct_complete_cb cb, void **box_conversion_context);


/**
 * aborts any ongoing box construction
 */
nserror cancel_dom_to_box(void *box_conversion_context);


/**
 * Retrieve the box for a dom node, if there is one
 *
 * \param node The DOM node
 * \return The box if there is one
 */
struct box *box_for_node(struct dom_node *node);

/**
 * Reported for each box a re-selection really changed the style of.
 */
typedef void (*box_restyle_cb)(void *pw, struct box *box);

/**
 * Re-select the style of an element's box and everything below it.
 *
 * The bounded restyle the dynamic pseudo-classes need (todos/0420).  A
 * `:hover` or `:active` transition changes the answer libcss gets from
 * node_is_hover()/node_is_active() for the elements on the entry and exit
 * chains.  Call this for the TOPMOST element of each changed chain: the
 * elements below it can be restyled by inheritance or by a descendant
 * combinator, so they are re-selected too, and nothing outside the two
 * subtrees is touched.
 *
 * The subtree that is re-selected is much wider than the set that really
 * changes — an element the pointer LEFT and a 3000px block it entered are
 * both re-selected, but only the first usually restyles.  \a cb reports
 * the set that changed, which is the set the caller has to repaint; it is
 * not called at all for a transition no rule keys on, which is every page
 * with no dynamic rule.
 *
 * A style change can move boxes, so a caller that saw \a cb fire must
 * reflow before it trusts a box's geometry.
 *
 * \param c    html content the box belongs to
 * \param box  Box to re-select from
 * \param cb   Called for each box whose computed style changed
 * \param pw   Client data for \a cb
 * \return true on success, false on memory exhaustion
 */
bool box_restyle_element(struct html_content *c, struct box *box,
			 box_restyle_cb cb, void *pw);

/**
 * Extract a URL from a relative link, handling junk like whitespace and
 * attempting to read a real URL from "javascript:" links.
 *
 * \param content html content
 * \param dsrel relative URL text taken from page
 * \param base base for relative URLs
 * \param result updated to target URL on heap, unchanged if extract failed
 * \return true on success, false on memory exhaustion
 */
bool box_extract_link(const struct html_content *content, const struct dom_string *dsrel, struct nsurl *base, struct nsurl **result);

#endif
