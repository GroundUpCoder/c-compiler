/*
 * Copyright 2006 James Bursa <bursa@users.sourceforge.net>
 * Copyright 2006 Richard Wilson <info@tinct.net>
 * Copyright 2008 Michael Drake <tlsa@netsurf-browser.org>
 * Copyright 2009 Paul Blokus <paul_pl@users.sourceforge.net>
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
 * implementation of user interaction with a CONTENT_HTML.
 */

#include <assert.h>
#include <stdbool.h>
#include <string.h>

#include <dom/dom.h>

#include "utils/corestrings.h"
#include "utils/messages.h"
#include "utils/utils.h"
#include "utils/log.h"
#include "utils/nsoption.h"
#include "netsurf/content.h"
#include "netsurf/browser_window.h"
#include "netsurf/mouse.h"
#include "netsurf/misc.h"
#include "netsurf/layout.h"
#include "netsurf/keypress.h"
#include "content/hlcache.h"
#include "content/content_protected.h"
#include "content/textsearch.h"
#include "desktop/browser_history.h"
#include "desktop/frames.h"
#include "desktop/scrollbar.h"
#include "desktop/selection.h"
#include "desktop/textarea.h"
#include "javascript/js.h"
#include "desktop/gui_internal.h"

#include "html/box.h"
#include "html/box_construct.h"
#include "html/box_textarea.h"
#include "html/box_inspect.h"
#include "html/font.h"
#include "html/form_internal.h"
#include "html/private.h"
#include "html/imagemap.h"
#include "html/interaction.h"

/* DOM event helpers, defined with the rest of the mouse-event layer
 * further down but needed by the click/submit sites above it */
static void html_mouse_pos(struct browser_window *bw, int x, int y,
			   struct dom_mouse_event_pos *pos);
static unsigned int html_mouse_mods(browser_mouse_state mouse);

/**
 * Get pointer shape for given box
 *
 * \param box       box in question
 * \param imagemap  whether an imagemap applies to the box
 */

static browser_pointer_shape get_pointer_shape(struct box *box, bool imagemap)
{
	browser_pointer_shape pointer;
	css_computed_style *style;
	enum css_cursor_e cursor;
	lwc_string **cursor_uris;

	if (box->type == BOX_FLOAT_LEFT || box->type == BOX_FLOAT_RIGHT)
		style = box->children->style;
	else
		style = box->style;

	if (style == NULL)
		return BROWSER_POINTER_DEFAULT;

	cursor = css_computed_cursor(style, &cursor_uris);

	switch (cursor) {
	case CSS_CURSOR_AUTO:
		if (box->href || (box->gadget &&
				(box->gadget->type == GADGET_IMAGE ||
				box->gadget->type == GADGET_SUBMIT)) ||
				imagemap) {
			/* link */
			pointer = BROWSER_POINTER_POINT;
		} else if (box->gadget &&
				(box->gadget->type == GADGET_TEXTBOX ||
				box->gadget->type == GADGET_PASSWORD ||
				box->gadget->type == GADGET_TEXTAREA)) {
			/* text input */
			pointer = BROWSER_POINTER_CARET;
		} else {
			/* html content doesn't mind */
			pointer = BROWSER_POINTER_AUTO;
		}
		break;
	case CSS_CURSOR_CROSSHAIR:
		pointer = BROWSER_POINTER_CROSS;
		break;
	case CSS_CURSOR_POINTER:
		pointer = BROWSER_POINTER_POINT;
		break;
	case CSS_CURSOR_MOVE:
		pointer = BROWSER_POINTER_MOVE;
		break;
	case CSS_CURSOR_E_RESIZE:
		pointer = BROWSER_POINTER_RIGHT;
		break;
	case CSS_CURSOR_W_RESIZE:
		pointer = BROWSER_POINTER_LEFT;
		break;
	case CSS_CURSOR_N_RESIZE:
		pointer = BROWSER_POINTER_UP;
		break;
	case CSS_CURSOR_S_RESIZE:
		pointer = BROWSER_POINTER_DOWN;
		break;
	case CSS_CURSOR_NE_RESIZE:
		pointer = BROWSER_POINTER_RU;
		break;
	case CSS_CURSOR_SW_RESIZE:
		pointer = BROWSER_POINTER_LD;
		break;
	case CSS_CURSOR_SE_RESIZE:
		pointer = BROWSER_POINTER_RD;
		break;
	case CSS_CURSOR_NW_RESIZE:
		pointer = BROWSER_POINTER_LU;
		break;
	case CSS_CURSOR_TEXT:
		pointer = BROWSER_POINTER_CARET;
		break;
	case CSS_CURSOR_WAIT:
		pointer = BROWSER_POINTER_WAIT;
		break;
	case CSS_CURSOR_PROGRESS:
		pointer = BROWSER_POINTER_PROGRESS;
		break;
	case CSS_CURSOR_HELP:
		pointer = BROWSER_POINTER_HELP;
		break;
	default:
		pointer = BROWSER_POINTER_DEFAULT;
		break;
	}

	return pointer;
}


/**
 * Start drag scrolling the contents of a box
 *
 * \param box	the box to be scrolled
 * \param x	x ordinate of initial mouse position
 * \param y	y ordinate
 */

static void html_box_drag_start(struct box *box, int x, int y)
{
	int box_x, box_y;
	int scroll_mouse_x, scroll_mouse_y;

	box_coords(box, &box_x, &box_y);

	if (box->scroll_x != NULL) {
		scroll_mouse_x = x - box_x ;
		scroll_mouse_y = y - (box_y + box->padding[TOP] +
				box->height + box->padding[BOTTOM] -
				SCROLLBAR_WIDTH);
		scrollbar_start_content_drag(box->scroll_x,
				scroll_mouse_x, scroll_mouse_y);
	} else if (box->scroll_y != NULL) {
		scroll_mouse_x = x - (box_x + box->padding[LEFT] +
				box->width + box->padding[RIGHT] -
				SCROLLBAR_WIDTH);
		scroll_mouse_y = y - box_y;

		scrollbar_start_content_drag(box->scroll_y,
				scroll_mouse_x, scroll_mouse_y);
	}
}


/**
 * End overflow scroll scrollbar drags
 *
 * \param html   html content
 * \param mouse  state of mouse buttons and modifier keys
 * \param x	 coordinate of mouse
 * \param y	 coordinate of mouse
 * \param dir    Direction of drag
 */
static size_t html_selection_drag_end(struct html_content *html,
		browser_mouse_state mouse, int x, int y, int dir)
{
	int pixel_offset;
	struct box *box;
	int dx, dy;
	size_t idx = 0;

	box = box_pick_text_box(html, x, y, dir, &dx, &dy);
	if (box) {
		plot_font_style_t fstyle;

		font_plot_style_from_css(&html->unit_len_ctx, box->style, &fstyle);

		guit->layout->position(&fstyle, box->text, box->length,
				       dx, &idx, &pixel_offset);

		idx += box->byte_offset;
	}

	return idx;
}


/**
 * Helper for file gadgets to store their filename.
 *
 * Stores the filename unencoded on the dom node associated with the
 * gadget.
 *
 * \todo Get rid of this crap eventually
 *
 * \param operation DOM operation
 * \param key DOM node key being considerd
 * \param _data The data assocated with the key
 * \param src The source DOM node.
 * \param dst The destination DOM node.
 */
static void
html__image_coords_dom_user_data_handler(dom_node_operation operation,
					 dom_string *key,
					 void *_data,
					 struct dom_node *src,
					 struct dom_node *dst)
{
	struct image_input_coords *oldcoords, *coords = _data, *newcoords;

	if (!dom_string_isequal(corestring_dom___ns_key_image_coords_node_data,
				key) || coords == NULL) {
		return;
	}

	switch (operation) {
	case DOM_NODE_CLONED:
		newcoords = calloc(1, sizeof(*newcoords));
		if (newcoords != NULL) {
			*newcoords = *coords;
			if (dom_node_set_user_data(dst,
				 corestring_dom___ns_key_image_coords_node_data,
				 newcoords,
				 html__image_coords_dom_user_data_handler,
				 &oldcoords) == DOM_NO_ERR) {
				free(oldcoords);
			}
		}
		break;

	case DOM_NODE_DELETED:
		free(coords);
		break;

	case DOM_NODE_RENAMED:
	case DOM_NODE_IMPORTED:
	case DOM_NODE_ADOPTED:
		break;

	default:
		NSLOG(netsurf, INFO, "User data operation not handled.");
		assert(0);
	}
}


/**
 * End overflow scroll scrollbar drags
 *
 * \param  scrollbar  scrollbar widget
 * \param  mouse   state of mouse buttons and modifier keys
 * \param  x	   coordinate of mouse
 * \param  y	   coordinate of mouse
 */
static void
html_overflow_scroll_drag_end(struct scrollbar *scrollbar,
			      browser_mouse_state mouse,
			      int x, int y)
{
	int scroll_mouse_x, scroll_mouse_y, box_x, box_y;
	struct html_scrollbar_data *data = scrollbar_get_data(scrollbar);
	struct box *box;

	box = data->box;
	box_coords(box, &box_x, &box_y);

	if (scrollbar_is_horizontal(scrollbar)) {
		scroll_mouse_x = x - box_x;
		scroll_mouse_y = y - (box_y + box->padding[TOP] +
				box->height + box->padding[BOTTOM] -
				SCROLLBAR_WIDTH);
		scrollbar_mouse_drag_end(scrollbar, mouse,
				scroll_mouse_x, scroll_mouse_y);
	} else {
		scroll_mouse_x = x - (box_x + box->padding[LEFT] +
				box->width + box->padding[RIGHT] -
				SCROLLBAR_WIDTH);
		scroll_mouse_y = y - box_y;
		scrollbar_mouse_drag_end(scrollbar, mouse,
				scroll_mouse_x, scroll_mouse_y);
	}
}


/**
 * handle html mouse action when select menu is open
 *
 */
static nserror
mouse_action_select_menu(html_content *html,
			 struct browser_window *bw,
			 browser_mouse_state mouse,
			 int x, int y)
{
	struct box *box;
	int box_x = 0;
	int box_y = 0;
	const char *status;
	int width, height;
	struct hlcache_handle *bw_content;
	browser_drag_type bw_drag_type;

	assert(html->visible_select_menu != NULL);

	bw_drag_type = browser_window_get_drag_type(bw);
	if (bw_drag_type != DRAGGING_NONE && !mouse) {
		/* drag end: select menu */
		form_select_mouse_drag_end(html->visible_select_menu, mouse, x, y);
	}

	/* the click arrived in SCREEN coordinates, so it maps against the box
	 * on screen (todos/0412) */
	box = form_gadget_screen_box(html->visible_select_menu);
	if (box == NULL) {
		/* The gadget lost its box — its element left the document.
		 * The menu can no longer be drawn or hit-tested, so close it
		 * rather than swallow this click and every later one. */
		form_free_select_menu(html->visible_select_menu);
		html->visible_select_menu = NULL;
		return NSERROR_OK;
	}
	box_coords(box, &box_x, &box_y);

	box_x -= box->border[LEFT].width;
	box_y += box->height + box->border[BOTTOM].width +
		box->padding[BOTTOM] + box->padding[TOP];

	status = form_select_mouse_action(html->visible_select_menu,
					  mouse,
					  x - box_x,
					  y - box_y);
	if (status != NULL) {
		/* set status if menu still open */
		union content_msg_data msg_data;
		msg_data.explicit_status_text = status;
		content_broadcast((struct content *)html,
				  CONTENT_MSG_STATUS,
				  &msg_data);
		return NSERROR_OK;
	}

	/* close menu and redraw where it was */
	form_select_get_dimensions(html->visible_select_menu, &width, &height);

	html->visible_select_menu = NULL;

	bw_content = browser_window_get_content(bw);
	content_request_redraw(bw_content,
			       box_x,
			       box_y,
			       width,
			       height);
	return NSERROR_OK;
}


/**
 * handle html mouse action when a selection drag is being performed
 *
 */
static nserror
mouse_action_drag_selection(html_content *html,
			    struct browser_window *bw,
			    browser_mouse_state mouse,
			    int x, int y)
{
	struct box *box;
	int dir = -1;
	int dx, dy;
	size_t idx;
	union html_drag_owner drag_owner;
	int pixel_offset;
	plot_font_style_t fstyle;

	if (!mouse) {
		/* End of selection drag */
		if (selection_dragging_start(html->sel)) {
			dir = 1;
		}

		idx = html_selection_drag_end(html, mouse, x, y, dir);

		if (idx != 0) {
			selection_track(html->sel, mouse, idx);
		}

		drag_owner.no_owner = true;
		html_set_drag_type(html, HTML_DRAG_NONE, drag_owner, NULL);

		return NSERROR_OK;
	}

	if (selection_dragging_start(html->sel)) {
		dir = 1;
	}

	box = box_pick_text_box(html, x, y, dir, &dx, &dy);
	if (box != NULL) {
		font_plot_style_from_css(&html->unit_len_ctx, box->style, &fstyle);

		guit->layout->position(&fstyle,
				       box->text,
				       box->length,
				       dx,
				       &idx,
				       &pixel_offset);

		selection_track(html->sel, mouse, box->byte_offset + idx);
	}
	return NSERROR_OK;
}


/**
 * handle html mouse action when a scrollbar drag is being performed
 *
 */
static nserror
mouse_action_drag_scrollbar(html_content *html,
			    struct browser_window *bw,
			    browser_mouse_state mouse,
			    int x, int y)
{
	struct scrollbar *scr;
	struct html_scrollbar_data *data;
	struct box *box;
	int box_x = 0;
	int box_y = 0;
	const char *status;
	int scroll_mouse_x = 0, scroll_mouse_y = 0;
	scrollbar_mouse_status scrollbar_status;

	scr = html->drag_owner.scrollbar;

	if (!mouse) {
		/* drag end: scrollbar */
		html_overflow_scroll_drag_end(scr, mouse, x, y);
	}

	data = scrollbar_get_data(scr);

	box = data->box;

	box_coords(box, &box_x, &box_y);

	if (scrollbar_is_horizontal(scr)) {
		scroll_mouse_x = x - box_x ;
		scroll_mouse_y = y - (box_y + box->padding[TOP] +
				      box->height + box->padding[BOTTOM] -
				      SCROLLBAR_WIDTH);
		scrollbar_status = scrollbar_mouse_action(scr,
							  mouse,
							  scroll_mouse_x,
							  scroll_mouse_y);
	} else {
		scroll_mouse_x = x - (box_x + box->padding[LEFT] +
				      box->width + box->padding[RIGHT] -
				      SCROLLBAR_WIDTH);
		scroll_mouse_y = y - box_y;

		scrollbar_status = scrollbar_mouse_action(scr,
							  mouse,
							  scroll_mouse_x,
							  scroll_mouse_y);
	}
	status = scrollbar_mouse_status_to_message(scrollbar_status);

	if (status != NULL) {
		union content_msg_data msg_data;

		msg_data.explicit_status_text = status;
		content_broadcast((struct content *)html,
				  CONTENT_MSG_STATUS,
				  &msg_data);
	}

	return NSERROR_OK;
}


/**
 * handle mouse actions while dragging in a text area
 */
static nserror
mouse_action_drag_textarea(html_content *html,
			    struct browser_window *bw,
			    browser_mouse_state mouse,
			    int x, int y)
{
	struct box *box;
	int box_x = 0;
	int box_y = 0;

	box = html->drag_owner.textarea;

	assert(box->gadget != NULL);
	assert(box->gadget->type == GADGET_TEXTAREA ||
	       box->gadget->type == GADGET_PASSWORD ||
	       box->gadget->type == GADGET_TEXTBOX);

	box_coords(box, &box_x, &box_y);
	textarea_mouse_action(box->gadget->data.text.ta,
			      mouse,
			      x - box_x,
			      y - box_y);

	/* TODO: Set appropriate statusbar message */
	return NSERROR_OK;
}


/**
 * handle mouse actions while dragging in a content
 */
static nserror
mouse_action_drag_content(html_content *html,
			  struct browser_window *bw,
			  browser_mouse_state mouse,
			  int x, int y)
{
	struct box *box;
	int box_x = 0;
	int box_y = 0;

	box = html->drag_owner.content;
	assert(box->object != NULL);

	box_coords(box, &box_x, &box_y);
	content_mouse_track(box->object,
			    bw, mouse,
			    x - box_x,
			    y - box_y);
	return NSERROR_OK;
}


/**
 * local structure containing all the mouse action state information
 */
struct mouse_action_state {
	struct {
		const char *status; /**< status text */
		browser_pointer_shape pointer; /**< pointer shape */
		enum {
		      ACTION_NONE, /**< default of no action */
		      ACTION_NOSEND, /**< do not send status and pointer message */
		      ACTION_SUBMIT, /**< submit form */
		      ACTION_NAVIGATE, /**< navigate to link url */
		      ACTION_JS, /**< execute link as script */
		      ACTION_BACK, /**< navigate back in history */
		      ACTION_FORWARD, /**< navigate forward in history */
		} action;
	} result;

	/** dom node */
	struct dom_node *node;

	/** html object */
	struct {
		struct box *box;
		int pos_x;
		int pos_y;
	} html_object;

	/** non html object */
	hlcache_handle *object;

	/** iframe */
	struct browser_window *iframe;

	/** link either from href or imagemap */
	struct {
		struct box *box;
		nsurl *url;
		const char *target;
		bool is_imagemap;
	} link;

	/** gadget */
	struct {
		struct form_control *control;
		struct box *box;
		int box_x;
		int box_y;
		const char *target;
	} gadget;

	/** title */
	const char *title;

	/** candidate box for drag operation */
	struct box *drag_candidate;

	/** scrollbar */
	struct {
		struct scrollbar *bar;
		int mouse_x;
		int mouse_y;
	} scroll;

	/** text in box */
	struct {
		struct box *box;
		int box_x;
	} text;
};


/**
 * iterate the box tree for deepest node at coordinates
 *
 * extracts mouse action node information by descending through
 *  visible boxes setting more specific values for:
 *
 * box - deepest box at point
 * html_object_box - html object
 * html_object_pos_x - html object
 * html_object_pos_y - html object
 * object - non html object
 * iframe - iframe
 * url - href or imagemap
 * target - href or imagemap or gadget
 * url_box - href or imagemap
 * imagemap - imagemap
 * gadget - gadget
 * gadget_box - gadget
 * gadget_box_x - gadget
 * gadget_box_y - gadget
 * title - title
 * pointer
 *
 * drag_candidate - first box with scroll
 * padding_left - box with scroll
 * padding_right
 * padding_top
 * padding_bottom
 * scrollbar - inside padding box stops decent
 * scroll_mouse_x - inside padding box stops decent
 * scroll_mouse_y - inside padding box stops decent
 *
 * text_box - text box
 * text_box_x - text_box
 */
static nserror
get_mouse_action_node(html_content *html,
		      int x, int y,
		      struct mouse_action_state *man)
{
	struct box *box;
	int box_x = 0;
	int box_y = 0;

	/* initialise the mouse action state data */
	memset(man, 0, sizeof(struct mouse_action_state));
	man->node = html->layout->node; /* Default dom node to the <HTML> */
	man->result.pointer = BROWSER_POINTER_DEFAULT;

	/* search the box tree for a link, imagemap, form control, or
	 * box with scrollbars
	 */
	box = html->layout;

	/* Consider the margins of the html page now */
	box_x = box->margin[LEFT];
	box_y = box->margin[TOP];

	do {
		/* skip hidden boxes */
		if ((box->style != NULL) &&
		    (css_computed_visibility(box->style) ==
		     CSS_VISIBILITY_HIDDEN)) {
			goto next_box;
		}

		if (box->node != NULL) {
			man->node = box->node;
		}

		if (box->object) {
			if (content_get_type(box->object) == CONTENT_HTML) {
				man->html_object.box = box;
				man->html_object.pos_x = box_x;
				man->html_object.pos_y = box_y;
			} else {
				man->object = box->object;
			}
		}

		if (box->iframe) {
			man->iframe = box->iframe;
		}

		if (box->href) {
			man->link.url = box->href;
			man->link.target = box->target;
			man->link.box = box;
			man->link.is_imagemap = false;
		}

		if (box->usemap) {
			man->link.url = imagemap_get(html,
						     box->usemap,
						     box_x,
						     box_y,
						     x, y,
						     &man->link.target);
			man->link.box = box;
			man->link.is_imagemap = true;
		}

		if (box->gadget) {
			man->gadget.control = box->gadget;
			man->gadget.box = box;
			man->gadget.box_x = box_x;
			man->gadget.box_y = box_y;
			if (box->gadget->form) {
				man->gadget.target = box->gadget->form->target;
			}
		}

		if (box->title) {
			man->title = box->title;
		}

		man->result.pointer = get_pointer_shape(box, false);

		if ((box->scroll_x != NULL) ||
		    (box->scroll_y != NULL)) {
			int padding_left;
			int padding_right;
			int padding_top;
			int padding_bottom;

			if (man->drag_candidate == NULL) {
				man->drag_candidate = box;
			}

			padding_left = box_x +
					scrollbar_get_offset(box->scroll_x);
			padding_right = padding_left + box->padding[LEFT] +
					box->width + box->padding[RIGHT];
			padding_top = box_y +
					scrollbar_get_offset(box->scroll_y);
			padding_bottom = padding_top + box->padding[TOP] +
					box->height + box->padding[BOTTOM];

			if ((x > padding_left) &&
			    (x < padding_right) &&
			    (y > padding_top) &&
			    (y < padding_bottom)) {
				/* mouse inside padding box */

				if ((box->scroll_y != NULL) &&
				    (x > (padding_right - SCROLLBAR_WIDTH))) {
					/* mouse above vertical box scroll */

					man->scroll.bar = box->scroll_y;
					man->scroll.mouse_x = x - (padding_right - SCROLLBAR_WIDTH);
					man->scroll.mouse_y = y - padding_top;
					break;

				} else if ((box->scroll_x != NULL) &&
					   (y > (padding_bottom -
							SCROLLBAR_WIDTH))) {
					/* mouse above horizontal box scroll */

					man->scroll.bar = box->scroll_x;
					man->scroll.mouse_x = x - padding_left;
					man->scroll.mouse_y = y - (padding_bottom - SCROLLBAR_WIDTH);
					break;
				}
			}
		}

		if (box->text && !box->object) {
			man->text.box = box;
			man->text.box_x = box_x;
		}

	next_box:
		/* iterate to next box */
		box = box_at_point(&html->unit_len_ctx, box, x, y, &box_x, &box_y);
	} while (box != NULL);

	/* use of box_x, box_y, or content below this point is probably a
	 * mistake; they will refer to the last box returned by box_at_point */

	assert(man->node != NULL);

	return NSERROR_OK;
}


/**
 * process mouse activity on a form gadget
 */
static nserror
gadget_mouse_action(html_content *html,
		    browser_mouse_state mouse,
		    int x, int y,
		    struct mouse_action_state *mas)
{
	struct content *c = (struct content *)html;
	textarea_mouse_status ta_status;
	union content_msg_data msg_data;
	nserror res;
	bool click;
	click = mouse & (BROWSER_MOUSE_PRESS_1 | BROWSER_MOUSE_PRESS_2 |
			 BROWSER_MOUSE_CLICK_1 | BROWSER_MOUSE_CLICK_2 |
			 BROWSER_MOUSE_DRAG_1 | BROWSER_MOUSE_DRAG_2);

	switch (mas->gadget.control->type) {
	case GADGET_SELECT:
		mas->result.status = messages_get("FormSelect");
		mas->result.pointer = BROWSER_POINTER_MENU;
		if (mouse & BROWSER_MOUSE_CLICK_1 &&
		    nsoption_bool(core_select_menu)) {
			html->visible_select_menu = mas->gadget.control;
			res = form_open_select_menu(c,
						    mas->gadget.control,
						    form_select_menu_callback,
						    c);
			if (res != NSERROR_OK) {
				NSLOG(netsurf, ERROR, "%s",
				      messages_get_errorcode(res));
				html->visible_select_menu = NULL;
			}
			mas->result.pointer = BROWSER_POINTER_DEFAULT;
		} else if (mouse & BROWSER_MOUSE_CLICK_1) {
			msg_data.select_menu.gadget = mas->gadget.control;
			content_broadcast(c,
					  CONTENT_MSG_SELECTMENU,
					  &msg_data);
		}
		break;

	case GADGET_CHECKBOX:
		mas->result.status = messages_get("FormCheckbox");
		if (mouse & BROWSER_MOUSE_CLICK_1) {
			mas->gadget.control->selected = !mas->gadget.control->selected;
			dom_html_input_element_set_checked(
				(dom_html_input_element *)(mas->gadget.control->node),
				mas->gadget.control->selected);
			html__redraw_a_box(html, mas->gadget.box);
			if (NETSURF_UI_EVENTS) {
				form_gadget_fire_change(mas->gadget.control);
			}
		}
		break;

	case GADGET_RADIO:
		mas->result.status = messages_get("FormRadio");
		if (mouse & BROWSER_MOUSE_CLICK_1) {
			form_radio_set(mas->gadget.control);
			if (NETSURF_UI_EVENTS) {
				form_gadget_fire_change(mas->gadget.control);
			}
		}
		break;

	case GADGET_IMAGE:
		/* This falls through to SUBMIT */
		if (mouse & BROWSER_MOUSE_CLICK_1) {
			struct image_input_coords *coords, *oldcoords;
			/** \todo Find a way to not ignore errors */
			coords = calloc(1, sizeof(*coords));
			if (coords == NULL) {
				return NSERROR_OK;
			}
			coords->x = x - mas->gadget.box_x;
			coords->y = y - mas->gadget.box_y;
			if (dom_node_set_user_data(
				mas->gadget.control->node,
				corestring_dom___ns_key_image_coords_node_data,
				coords,
				html__image_coords_dom_user_data_handler,
				&oldcoords) != DOM_NO_ERR) {
				return NSERROR_OK;
			}
			free(oldcoords);
		}
		fallthrough;

	case GADGET_SUBMIT:
		if (mas->gadget.control->form) {
			static char status_buffer[200];

			snprintf(status_buffer,
				 sizeof status_buffer,
				 messages_get("FormSubmit"),
				 mas->gadget.control->form->action);
			mas->result.status = status_buffer;
			mas->result.pointer = get_pointer_shape(mas->gadget.box,
								false);
			if (mouse & (BROWSER_MOUSE_CLICK_1 |
				     BROWSER_MOUSE_CLICK_2)) {
				mas->result.action = ACTION_SUBMIT;
			}
		} else {
			mas->result.status = messages_get("FormBadSubmit");
		}
		break;

	case GADGET_TEXTBOX:
	case GADGET_PASSWORD:
	case GADGET_TEXTAREA:
		if (mas->gadget.control->type == GADGET_TEXTAREA) {
			mas->result.status = messages_get("FormTextarea");
		} else {
			mas->result.status = messages_get("FormTextbox");
		}

		if (click &&
		    (html->selection_type != HTML_SELECTION_TEXTAREA ||
		     html->selection_owner.textarea != mas->gadget.box)) {
			union html_selection_owner sel_owner;
			sel_owner.none = true;
			html_set_selection(html,
					   HTML_SELECTION_NONE,
					   sel_owner,
					   true);
		}

		ta_status = textarea_mouse_action(mas->gadget.control->data.text.ta,
						  mouse,
						  x - mas->gadget.box_x,
						  y - mas->gadget.box_y);

		if (ta_status & TEXTAREA_MOUSE_EDITOR) {
			mas->result.pointer = get_pointer_shape(mas->gadget.box, false);
		} else {
			mas->result.pointer = BROWSER_POINTER_DEFAULT;
			mas->result.status = scrollbar_mouse_status_to_message(ta_status >> 3);
		}
		break;

	case GADGET_HIDDEN:
		/* not possible: no box generated */
		break;

	case GADGET_RESET:
		mas->result.status = messages_get("FormReset");
		break;

	case GADGET_FILE:
		mas->result.status = messages_get("FormFile");
		if (mouse & BROWSER_MOUSE_CLICK_1) {
			msg_data.gadget_click.gadget = mas->gadget.control;
			content_broadcast(c,
					  CONTENT_MSG_GADGETCLICK,
					  &msg_data);
		}
		break;

	case GADGET_BUTTON:
		/* This gadget cannot be activated */
		mas->result.status = messages_get("FormButton");
		break;
	}

	return NSERROR_OK;
}


/**
 * process mouse activity on an iframe
 */
static nserror
iframe_mouse_action(struct browser_window *bw,
		    browser_mouse_state mouse,
		    int x, int y,
		    struct mouse_action_state *mas)
{
	int pos_x, pos_y;
	float scale;

	scale = browser_window_get_scale(bw);

	browser_window_get_position(mas->iframe, false, &pos_x, &pos_y);

	if (mouse & BROWSER_MOUSE_CLICK_1 ||
	    mouse & BROWSER_MOUSE_CLICK_2) {
		browser_window_mouse_click(mas->iframe,
					   mouse,
					   (x * scale) - pos_x,
					   (y * scale) - pos_y);
	} else {
		browser_window_mouse_track(mas->iframe,
					   mouse,
					   (x * scale) - pos_x,
					   (y * scale) - pos_y);
	}
	mas->result.action = ACTION_NOSEND;

	return NSERROR_OK;
}


/**
 * process mouse activity on an html object
 */
static nserror
html_object_mouse_action(html_content *html,
			 struct browser_window *bw,
			 browser_mouse_state mouse,
			 int x, int y,
			 struct mouse_action_state *mas)
{
	bool click;
	click = mouse & (BROWSER_MOUSE_PRESS_1 | BROWSER_MOUSE_PRESS_2 |
			 BROWSER_MOUSE_CLICK_1 | BROWSER_MOUSE_CLICK_2 |
			 BROWSER_MOUSE_DRAG_1 | BROWSER_MOUSE_DRAG_2);

	if (click &&
	    (html->selection_type != HTML_SELECTION_CONTENT ||
	     html->selection_owner.content != mas->html_object.box)) {
		union html_selection_owner sel_owner;
		sel_owner.none = true;
		html_set_selection(html, HTML_SELECTION_NONE, sel_owner, true);
	}

	if (mouse & BROWSER_MOUSE_CLICK_1 ||
	    mouse & BROWSER_MOUSE_CLICK_2) {
		content_mouse_action(mas->html_object.box->object,
				     bw,
				     mouse,
				     x - mas->html_object.pos_x,
				     y - mas->html_object.pos_y);
	} else {
		content_mouse_track(mas->html_object.box->object,
				    bw,
				    mouse,
				    x - mas->html_object.pos_x,
				    y - mas->html_object.pos_y);
	}

	mas->result.action = ACTION_NOSEND;
	return NSERROR_OK;
}


/**
 * determine if a url has a javascript scheme
 *
 * \param urm The url to check.
 * \return true if the url is a javascript scheme else false
 */
static bool is_javascript_navigate_url(nsurl *url)
{
	bool is_js = false;
	lwc_string *scheme;

	scheme = nsurl_get_component(url, NSURL_SCHEME);
	if (scheme != NULL) {
		if (scheme == corestring_lwc_javascript) {
			is_js = true;
		}
		lwc_string_unref(scheme);
	}
	return is_js;
}


/**
 * process mouse activity on a link
 */
static nserror
link_mouse_action(html_content *html,
		  struct browser_window *bw,
		  browser_mouse_state mouse,
		  int x, int y,
		  struct mouse_action_state *mas)
{
	nserror res;
	char *url_s = NULL;
	size_t url_l = 0;
	static char status_buffer[200];
	union content_msg_data msg_data;

	if (nsoption_bool(display_decoded_idn) == true) {
		res = nsurl_get_utf8(mas->link.url, &url_s, &url_l);
		if (res != NSERROR_OK) {
			/* Unable to obtain a decoded IDN. This is not
			 *  a fatal error.  Ensure the string pointer
			 *  is NULL so we use the encoded version.
			 */
			url_s = NULL;
		}
	}

	if (mas->title) {
		snprintf(status_buffer,
			 sizeof status_buffer,
			 "%s: %s",
			 url_s ? url_s : nsurl_access(mas->link.url),
			 mas->title);
	} else {
		snprintf(status_buffer,
			 sizeof status_buffer,
			 "%s",
			 url_s ? url_s : nsurl_access(mas->link.url));
	}

	if (url_s != NULL) {
		free(url_s);
	}

	mas->result.status = status_buffer;

	mas->result.pointer = get_pointer_shape(mas->link.box,
						mas->link.is_imagemap);

	if (mouse & BROWSER_MOUSE_CLICK_1 &&
	    mouse & BROWSER_MOUSE_MOD_1) {
		/* force download of link */
		browser_window_navigate(bw,
					mas->link.url,
					content_get_url((struct content *)html),
					BW_NAVIGATE_DOWNLOAD,
					NULL,
					NULL,
					NULL);

	} else if (mouse & BROWSER_MOUSE_CLICK_2 &&
		   mouse & BROWSER_MOUSE_MOD_1) {
		msg_data.savelink.url = mas->link.url;
		msg_data.savelink.title = mas->title;
		content_broadcast((struct content *)html,
				  CONTENT_MSG_SAVELINK,
				  &msg_data);

	} else if (mouse & (BROWSER_MOUSE_CLICK_1 | BROWSER_MOUSE_CLICK_2)) {
		if (is_javascript_navigate_url(mas->link.url)) {
			mas->result.action = ACTION_JS;
		} else {
			mas->result.action = ACTION_NAVIGATE;
		}
	}

	return NSERROR_OK;
}


static nserror
default_mouse_action_focus(html_content *html, browser_mouse_state mouse)
{
	if (mouse && mouse < BROWSER_MOUSE_MOD_1) {
		/* ensure key presses still act on the browser window */
		union html_focus_owner fo;
		fo.self = true;
		html_set_focus(html, HTML_FOCUS_SELF, fo, true, 0, 0, 0, NULL);
	}

	return NSERROR_OK;
}


/**
 * process mouse activity if it is not anything else
 */
static nserror
default_mouse_action(html_content *html,
		  struct browser_window *bw,
		  browser_mouse_state mouse,
		  int x, int y,
		  struct mouse_action_state *mas)
{
	struct content *c = (struct content *)html;

	/* frame resizing */
	if (browser_window_frame_resize_start(bw, mouse, x, y, &mas->result.pointer)) {
		if (mouse & (BROWSER_MOUSE_DRAG_1 | BROWSER_MOUSE_DRAG_2)) {
			mas->result.status = messages_get("FrameDrag");
		}
		return default_mouse_action_focus(html, mouse);
	}

	/* clicking in the main page removes the selection from any text areas.
	 */
	union html_selection_owner sel_owner;
	bool click;
	click = mouse & (BROWSER_MOUSE_PRESS_1 | BROWSER_MOUSE_PRESS_2 |
			 BROWSER_MOUSE_CLICK_1 | BROWSER_MOUSE_CLICK_2 |
			 BROWSER_MOUSE_DRAG_1 | BROWSER_MOUSE_DRAG_2);

	if (click && html->focus_type != HTML_FOCUS_SELF) {
		union html_focus_owner fo;
		fo.self = true;
		html_set_focus(html, HTML_FOCUS_SELF, fo, true, 0, 0, 0, NULL);
	}
	if (click && html->selection_type != HTML_SELECTION_SELF) {
		sel_owner.none = true;
		html_set_selection(html, HTML_SELECTION_NONE, sel_owner, true);
	}

	if (mas->text.box) {
		int pixel_offset;
		size_t idx;
		plot_font_style_t fstyle;

		font_plot_style_from_css(&html->unit_len_ctx,
					 mas->text.box->style,
					 &fstyle);

		guit->layout->position(&fstyle,
				       mas->text.box->text,
				       mas->text.box->length,
				       x - mas->text.box_x,
				       &idx,
				       &pixel_offset);

		if ((html->mouse_default_prevented == false) &&
		    selection_click(html->sel,
				    html->bw,
				    mouse,
				    mas->text.box->byte_offset + idx)) {
			/* key presses must be directed at the
			 * main browser window, paste text
			 * operations ignored */
			html_drag_type drag_type;
			union html_drag_owner drag_owner;

			if (selection_dragging(html->sel)) {
				drag_type = HTML_DRAG_SELECTION;
				drag_owner.no_owner = true;
				html_set_drag_type(html,
						   drag_type,
						   drag_owner,
						   NULL);
				mas->result.status = messages_get("Selecting");
			}

			if (selection_active(html->sel)) {
				sel_owner.none = false;
				html_set_selection(html, HTML_SELECTION_SELF,
						   sel_owner, true);
			} else if (click && html->selection_type != HTML_SELECTION_NONE) {
				sel_owner.none = true;
				html_set_selection(html, HTML_SELECTION_NONE,
						   sel_owner, true);
			}

			return default_mouse_action_focus(html, mouse);
		}

	} else if (mouse & BROWSER_MOUSE_PRESS_1) {
		sel_owner.none = true;
		selection_clear(html->sel, true);
	}

	if (selection_active(html->sel)) {
		sel_owner.none = false;
		html_set_selection(html, HTML_SELECTION_SELF, sel_owner, true);
	} else if (click && html->selection_type != HTML_SELECTION_NONE) {
		sel_owner.none = true;
		html_set_selection(html, HTML_SELECTION_NONE, sel_owner, true);
	}

	if (mas->title) {
		mas->result.status = mas->title;
	}

	if (html->mouse_default_prevented) {
		/* preventDefault() on the mousedown: no page-scroll drag, no
		 * box drag.  The page is handling this gesture itself. */
	} else if (mouse & BROWSER_MOUSE_DRAG_1) {
		if (mouse & BROWSER_MOUSE_MOD_2) {
			union content_msg_data msg_data;
			msg_data.dragsave.type = CONTENT_SAVE_COMPLETE;
			msg_data.dragsave.content = NULL;
			content_broadcast(c, CONTENT_MSG_DRAGSAVE, &msg_data);
		} else {
			if (mas->drag_candidate == NULL) {
				browser_window_page_drag_start(bw, x, y);
			} else {
				html_box_drag_start(mas->drag_candidate, x, y);
			}
			mas->result.pointer = BROWSER_POINTER_MOVE;
		}
	} else if (mouse & BROWSER_MOUSE_DRAG_2) {
		if (mouse & BROWSER_MOUSE_MOD_2) {
			union content_msg_data msg_data;
			msg_data.dragsave.type = CONTENT_SAVE_SOURCE;
			msg_data.dragsave.content = NULL;
			content_broadcast(c, CONTENT_MSG_DRAGSAVE, &msg_data);
		} else {
			if (mas->drag_candidate == NULL) {
				browser_window_page_drag_start(bw, x, y);
			} else {
				html_box_drag_start(mas->drag_candidate, x, y);
			}
			mas->result.pointer = BROWSER_POINTER_MOVE;
		}
	}


	return default_mouse_action_focus(html, mouse);
}


/**
 * handle non dragging mouse actions
 */
static nserror
mouse_action_drag_none(html_content *html,
		       struct browser_window *bw,
		       browser_mouse_state mouse,
		       int x, int y)
{
	nserror res;
	struct content *c = (struct content *)html;
	union content_msg_data msg_data;
	lwc_string *path;
	bool click_prevented = false;

	/**
	 * computed state
	 *
	 * not on heap to avoid allocation or stack because it is large
	 */
	static struct mouse_action_state mas;

	res = get_mouse_action_node(html, x, y, &mas);
	if (res != NSERROR_OK) {
		return res;
	}

	if (mouse & BROWSER_MOUSE_CLICK_4) {
		mas.result.action = ACTION_BACK;
	} else if (mouse & BROWSER_MOUSE_CLICK_5) {
		mas.result.action = ACTION_FORWARD;
	} else if (mas.scroll.bar) {
		mas.result.status = scrollbar_mouse_status_to_message(
				scrollbar_mouse_action(mas.scroll.bar,
						       mouse,
						       mas.scroll.mouse_x,
						       mas.scroll.mouse_y));
		mas.result.pointer = BROWSER_POINTER_DEFAULT;

	} else if (mas.gadget.control) {
		res = gadget_mouse_action(html, mouse, x, y, &mas);

	} else if ((mas.object != NULL) && (mouse & BROWSER_MOUSE_MOD_2)) {

		if (mouse & BROWSER_MOUSE_DRAG_2) {
			msg_data.dragsave.type = CONTENT_SAVE_NATIVE;
			msg_data.dragsave.content = mas.object;
			content_broadcast(c, CONTENT_MSG_DRAGSAVE, &msg_data);

		} else if (mouse & BROWSER_MOUSE_DRAG_1) {
			msg_data.dragsave.type = CONTENT_SAVE_ORIG;
			msg_data.dragsave.content = mas.object;
			content_broadcast(c, CONTENT_MSG_DRAGSAVE, &msg_data);
		}

		/* \todo should have a drag-saving object msg */

	} else if (mas.iframe != NULL) {
		res = iframe_mouse_action(bw, mouse, x, y, &mas);

	} else if (mas.html_object.box != NULL) {
		res = html_object_mouse_action(html, bw, mouse, x, y, &mas);

	} else if (mas.link.url != NULL) {
		res = link_mouse_action(html, bw, mouse, x, y, &mas);

	} else {
		res = default_mouse_action(html, bw, mouse, x, y, &mas);

	}
	if (res != NSERROR_OK) {
		return res;
	}

	/* send status and pointer message */
	if (mas.result.action != ACTION_NOSEND) {
		msg_data.explicit_status_text = mas.result.status;
		content_broadcast(c, CONTENT_MSG_STATUS, &msg_data);

		msg_data.pointer = mas.result.pointer;
		content_broadcast(c, CONTENT_MSG_POINTER, &msg_data);
	}

	/* fire dom click event.  This used to be a plain Event, so it
	 * carried no coordinates at all (clientX read `undefined`); it is a
	 * real MouseEvent now, and a double click also gets its dblclick. */
	if (mouse & BROWSER_MOUSE_CLICK_1) {
		struct dom_mouse_event_pos pos;
		int detail = (mouse & BROWSER_MOUSE_TRIPLE_CLICK) ? 3 :
			     (mouse & BROWSER_MOUSE_DOUBLE_CLICK) ? 2 : 1;

		html_mouse_pos(bw, x, y, &pos);
		if (NETSURF_UI_EVENTS == 0) {
			/* upstream: a plain Event, so no coordinates */
			click_prevented = (fire_generic_dom_event(
					corestring_dom_click,
					mas.node, true, true) == false);
		} else {
			click_prevented = (fire_dom_mouse_event(
					corestring_dom_click, mas.node,
					true, true, &pos, 0, 0,
					html_mouse_mods(mouse), detail) == false);
		}

		if (NETSURF_UI_EVENTS && (mouse & BROWSER_MOUSE_DOUBLE_CLICK)) {
			fire_dom_mouse_event(corestring_dom_dblclick,
					mas.node, true, true, &pos, 0, 0,
					html_mouse_mods(mouse), 2);
		}
	}

	/* preventDefault() on the click cancels the clicked element's
	 * ACTIVATION BEHAVIOUR (DOM, "run post-click activation steps").
	 * Both dispatch helpers already report it: libdom's
	 * dom_event_target_dispatch_event answers false when a listener
	 * cancelled the event, and fire_dom_event passes that answer up.
	 * Upstream simply threw the answer away here, so a handler could
	 * never stop a link (todos/0419).
	 *
	 * The three cancelled actions are exactly the element-activation
	 * ones.  ACTION_BACK and ACTION_FORWARD are the mouse's own history
	 * buttons, not an element behaviour, and this block cannot even see
	 * them: they need CLICK_4/CLICK_5, while the click above needs
	 * CLICK_1.  ACTION_SUBMIT is included because a submit button's
	 * activation behaviour IS the submission — form_submit() honours the
	 * cancelable `submit`, which is a DIFFERENT event and does not cover
	 * a cancelled click. */
	if (click_prevented) {
		switch (mas.result.action) {
		case ACTION_SUBMIT:
		case ACTION_NAVIGATE:
		case ACTION_JS:
			mas.result.action = ACTION_NONE;
			break;

		default:
			break;
		}
	}

	/* deferred actions that can cause this browser_window to be destroyed
	 * and must therefore be done after set_status/pointer
	 */
	switch (mas.result.action) {
	case ACTION_SUBMIT:
		/* The cancelable DOM `submit` fires inside form_submit(),
		 * the one choke every trigger shares. */
		res = form_submit(content_get_url(c),
				  browser_window_find_target(bw,
							     mas.gadget.target,
							     mouse),
				  mas.gadget.control->form,
				  mas.gadget.control);
		break;

	case ACTION_NAVIGATE:
		res = browser_window_navigate(
				browser_window_find_target(bw,
							   mas.link.target,
							   mouse),
				mas.link.url,
				content_get_url(c),
				BW_NAVIGATE_HISTORY,
				NULL,
				NULL,
				NULL);
		break;

	case ACTION_JS:
		path = nsurl_get_component(mas.link.url, NSURL_PATH);
		if (path != NULL) {
			html_exec(c,
				  lwc_string_data(path),
				  lwc_string_length(path));
			lwc_string_unref(path);
		}
		break;

	case ACTION_BACK:
		res = browser_window_history_back(bw, false);
		break;

	case ACTION_FORWARD:
		res = browser_window_history_forward(bw, false);
		break;

	case ACTION_NOSEND:
	case ACTION_NONE:
		res = NSERROR_OK;
		break;
	}

	return res;
}


/**
 * Find the deepest DOM node under a document coordinate.
 *
 * Exported (see private.h) because html_scroll_at_point needs it too.
 *
 * A cut-down get_mouse_action_node: the DOM only needs the node, not the
 * link/gadget/scrollbar state that costs the rest of that function.  Never
 * returns NULL — the root element is the floor, which is what the DOM
 * wants anyway (an event over blank margin still targets the document).
 */
dom_node *html_dom_node_at_point(html_content *html, int x, int y)
{
	struct box *box = html->layout;
	dom_node *node = html->layout->node;
	int box_x = box->margin[LEFT];
	int box_y = box->margin[TOP];

	do {
		if ((box->style != NULL) &&
		    (css_computed_visibility(box->style) ==
		     CSS_VISIBILITY_HIDDEN)) {
			goto next_box;
		}
		if (box->node != NULL) {
			node = box->node;
		}
	next_box:
		box = box_at_point(&html->unit_len_ctx, box, x, y,
				   &box_x, &box_y);
	} while (box != NULL);

	return node;
}


/**
 * Translate a browser_mouse_state's modifier bits to DOM modifier names.
 */
static unsigned int html_mouse_mods(browser_mouse_state mouse)
{
	unsigned int mods = 0;

	if (mouse & BROWSER_MOUSE_MOD_1) mods |= HTML_MOD_SHIFT;
	if (mouse & BROWSER_MOUSE_MOD_2) mods |= HTML_MOD_CTRL;
	if (mouse & BROWSER_MOUSE_MOD_3) mods |= HTML_MOD_ALT;
	if (mouse & BROWSER_MOUSE_MOD_4) mods |= HTML_MOD_META;

	return mods;
}


/**
 * The DOM `buttons` bitmask implied by a browser_mouse_state.
 *
 * netsurf numbers buttons 1 = primary, 2 = auxiliary — but every front end
 * here maps the RIGHT button onto 2, and DOM's `buttons` is
 * 1 = primary, 2 = secondary, 4 = auxiliary.  So 1 -> 1 and 2 -> 2, and
 * nothing claims to be the middle button (no front end delivers one).
 */
static unsigned short html_mouse_buttons(browser_mouse_state mouse)
{
	unsigned short buttons = 0;

	if (mouse & (BROWSER_MOUSE_PRESS_1 | BROWSER_MOUSE_HOLDING_1 |
		     BROWSER_MOUSE_DRAG_1)) {
		buttons |= 1;
	}
	if (mouse & (BROWSER_MOUSE_PRESS_2 | BROWSER_MOUSE_HOLDING_2 |
		     BROWSER_MOUSE_DRAG_2)) {
		buttons |= 2;
	}

	return buttons;
}


/**
 * Fill in a mouse position from the document coordinate plus the front
 * end's viewport scroll offset.
 */
static void html_mouse_pos(struct browser_window *bw, int x, int y,
			   struct dom_mouse_event_pos *pos)
{
	int sx = 0;
	int sy = 0;

	if (bw != NULL) {
		browser_window_get_scroll(bw, &sx, &sy);
	}

	pos->page_x = x;
	pos->page_y = y;
	pos->client_x = x - sx;
	pos->client_y = y - sy;
}


/**
 * Is anything on this page listening for this event type?
 *
 * Everything below this point costs a box-tree walk and a libdom event
 * allocation per mouse motion, so a page with no listener — which is every
 * page in the corpus that is not a JS demo — must not pay for it.
 */
static inline bool html_wants_event(html_content *html, const char *type)
{
	return js_event_type_registered(html->jsthread, type);
}


/**
 * Dispatch the DOM mouse events implied by one core mouse action.
 *
 * Called at the TOP of html_mouse_action, before the native handling, so
 * that `mousedown`/`mouseup` precede the focus, selection and gadget work
 * they would precede in a real browser.  `click` deliberately stays where
 * upstream put it — AFTER the action — because a click listener must see
 * the checkbox it just toggled as already toggled.
 *
 * netsurf's model has no explicit button-release event: a release that was
 * not a drag arrives as BROWSER_MOUSE_CLICK_n, and a release that ENDED a
 * drag arrives as a plain track with no buttons held.  Both are a
 * `mouseup`, and the second is recognisable because this content still has
 * a live drag while the incoming state holds nothing.
 */
static void html_fire_mouse_events(html_content *html,
				   struct browser_window *bw,
				   browser_mouse_state mouse,
				   int x, int y)
{
	struct dom_mouse_event_pos pos;
	unsigned short button;
	unsigned short buttons;
	unsigned int mods;
	dom_node *node;
	bool down;
	bool up;
	int detail;

	if (NETSURF_UI_EVENTS == 0) {
		return;
	}

	/* Cleared unconditionally at every press: a stale "prevented" would
	 * silently disable page scrolling for the rest of the document's
	 * life. */
	if (mouse & (BROWSER_MOUSE_PRESS_1 | BROWSER_MOUSE_PRESS_2)) {
		html->mouse_default_prevented = false;
	}

	if (html->layout == NULL || html->jsthread == NULL) {
		return;
	}

	down = !!(mouse & (BROWSER_MOUSE_PRESS_1 | BROWSER_MOUSE_PRESS_2));
	/* A release is either a CLICK_n (a press that was not a drag) or a
	 * track with nothing held after a press we saw (a drag ending).
	 * Both are the same `mouseup`. */
	up = !down &&
	     (!!(mouse & (BROWSER_MOUSE_CLICK_1 | BROWSER_MOUSE_CLICK_2)) ||
	      (html->mouse_pressed &&
	       ((mouse & (BROWSER_MOUSE_HOLDING_1 | BROWSER_MOUSE_HOLDING_2 |
			  BROWSER_MOUSE_DRAG_ON | BROWSER_MOUSE_DRAG_1 |
			  BROWSER_MOUSE_DRAG_2)) == 0)));

	/* The cheap gate: a string lookup beats the box walk below, so a
	 * page listening for none of these pays almost nothing per motion
	 * event.  The press/release bookkeeping still has to happen, so it
	 * is folded into the branches rather than gated out here. */
	if (down == false && up == false &&
	    html_wants_event(html, "mousemove") == false) {
		return;
	}
	if (down && html_wants_event(html, "mousedown") == false) {
		html->mouse_pressed = true;
		return;
	}
	if (up && html_wants_event(html, "mouseup") == false &&
	    html_wants_event(html, "mousedown") == false) {
		html->mouse_pressed = false;
		return;
	}

	node = html_dom_node_at_point(html, x, y);
	if (node == NULL) {
		return;
	}

	html_mouse_pos(bw, x, y, &pos);
	mods = html_mouse_mods(mouse);
	buttons = html_mouse_buttons(mouse);
	button = (mouse & (BROWSER_MOUSE_PRESS_2 | BROWSER_MOUSE_CLICK_2 |
			   BROWSER_MOUSE_HOLDING_2 | BROWSER_MOUSE_DRAG_2)) ?
			2 : 0;
	detail = (mouse & BROWSER_MOUSE_TRIPLE_CLICK) ? 3 :
		 (mouse & BROWSER_MOUSE_DOUBLE_CLICK) ? 2 : 1;

	if (down) {
		html->mouse_pressed = true;
		if (html_wants_event(html, "mousedown")) {
			html->mouse_default_prevented =
				(fire_dom_mouse_event(corestring_dom_mousedown,
					node, true, true, &pos, button,
					buttons, mods, detail) == false);
		}
		return;
	}

	if (up) {
		/* A front end that reports a click without ever reporting
		 * the press still owes the DOM a mousedown: the sequence is
		 * mousedown, mouseup, click, and a page that tracks its own
		 * button state from those would otherwise never start. */
		if ((html->mouse_pressed == false) &&
		    html_wants_event(html, "mousedown")) {
			fire_dom_mouse_event(corestring_dom_mousedown, node,
					true, true, &pos, button, buttons,
					mods, detail);
		}
		html->mouse_pressed = false;
		if (html_wants_event(html, "mouseup")) {
			/* the button is no longer held at a release */
			fire_dom_mouse_event(corestring_dom_mouseup, node,
					true, true, &pos, button, 0,
					mods, detail);
		}
		return;
	}

	if (html_wants_event(html, "mousemove")) {
		/* A move has no button that changed state, and detail 0 */
		fire_dom_mouse_event(corestring_dom_mousemove, node,
				true, true, &pos, 0, buttons, mods, 0);
	}
}


/**
 * The dynamic pseudo-class chains: `:hover` and `:active` (todos/0420).
 *
 * node_is_hover() in css/select.c was a `\todo Support hovering` stub that
 * always answered "no match", so a `:hover` rule could never apply however
 * long the pointer rested on the element.  The input half already worked —
 * the status bar names the link under the pointer — so what was missing is
 * the answer and the repaint.
 *
 * The chains are ELEMENTS, deepest first.  Only the deepest element is
 * stored, because libcss asks per node and select.c walks up from the
 * subject; the array form below exists purely to work out what CHANGED
 * between two pointer positions.
 *
 * The restyle is bounded to that change.  Moving the pointer from one
 * element to another leaves every common ancestor hovered, so the elements
 * whose answer moved are the two chains below their deepest common
 * ancestor.  Re-selecting the box subtree of the TOPMOST element of each
 * covers them, plus everything they can restyle by inheritance or by a
 * descendant combinator.
 *
 * Two shapes are deliberately NOT covered, because both need a full
 * style-invalidation engine rather than a chain walk:
 *
 *   - a SIBLING combinator (`a:hover ~ span`), whose subject sits outside
 *     both subtrees;
 *   - a rule that takes an element from `display: none` to displayed,
 *     which has no box to re-select from.
 *
 * Both are recorded in todos/LIABILITIES.md against todos/0426.
 */
#define HTML_CHAIN_MAX 128

/**
 * The deepest ELEMENT under the pointer.
 *
 * \return a NEW reference, or NULL
 */
static dom_node *html_dynamic_element_at(html_content *html, int x, int y)
{
	dom_node *node;

	if (html->layout == NULL) {
		return NULL;
	}

	node = html_dom_node_at_point(html, x, y);
	if (node == NULL) {
		return NULL;
	}
	dom_node_ref(node);

	/* html_dom_node_at_point answers with the deepest box's node, and
	 * for text that is a TEXT node.  A pseudo-class matches elements,
	 * so climb to the first element at or above it. */
	while (node != NULL) {
		dom_node_type type;
		dom_node *parent;

		if ((dom_node_get_node_type(node, &type) == DOM_NO_ERR) &&
		    (type == DOM_ELEMENT_NODE)) {
			break;
		}

		if (dom_node_get_parent_node(node, &parent) != DOM_NO_ERR) {
			parent = NULL;
		}
		dom_node_unref(node);
		node = parent;
	}

	return node;
}


/**
 * Collect \a node and its ancestors, deepest first.
 *
 * Each slot owns a reference; html_chain_free() drops them.
 *
 * \return the number of entries, or -1 if the document is deeper than
 *         HTML_CHAIN_MAX (the caller then restyles from the root instead)
 */
static int html_chain_build(dom_node *node, dom_node **chain)
{
	dom_node *cur = node;
	int n = 0;

	if (cur != NULL) {
		dom_node_ref(cur);
	}

	while (cur != NULL) {
		dom_node *parent;

		if (n == HTML_CHAIN_MAX) {
			dom_node_unref(cur);
			while (n > 0) {
				dom_node_unref(chain[--n]);
			}
			return -1;
		}
		chain[n++] = cur;

		if (dom_node_get_parent_node(cur, &parent) != DOM_NO_ERR) {
			parent = NULL;
		}
		cur = parent;
	}

	return n;
}

static void html_chain_free(dom_node **chain, int n)
{
	while (n > 0) {
		dom_node_unref(chain[--n]);
	}
}


/**
 * Append the topmost element of each chain whose state really changed.
 *
 * Both chains are deepest first, so they are compared from the TAIL: the
 * shared tail is the common ancestry, and the entry just below it is the
 * highest element the transition moved.
 */
static void
html_dynamic_changed(dom_node *from,
		     dom_node *to,
		     dom_node **out,
		     int *n_out)
{
	dom_node *a[HTML_CHAIN_MAX], *b[HTML_CHAIN_MAX];
	int na, nb, i, j;

	if (from == to) {
		return;
	}

	na = html_chain_build(from, a);
	nb = html_chain_build(to, b);
	if ((na < 0) || (nb < 0)) {
		/* pathologically deep: fall back to the whole document,
		 * which is correct, just not bounded */
		if (na >= 0) {
			html_chain_free(a, na);
		}
		if (nb >= 0) {
			html_chain_free(b, nb);
		}
		out[(*n_out)++] = NULL;
		return;
	}

	i = na - 1;
	j = nb - 1;
	while ((i >= 0) && (j >= 0) && (a[i] == b[j])) {
		i--;
		j--;
	}

	/* The topmost changed entry can be above the box tree — the chain
	 * runs to the DOCUMENT node, and an empty old chain therefore makes
	 * the whole of the new one "changed".  Descend to the first entry
	 * that really has a box: that is the highest box the transition can
	 * restyle.  An entry inside a `display: none` subtree has no box and
	 * neither has anything below it, so the walk correctly finds
	 * nothing. */
	while ((i >= 0) && (box_for_node(a[i]) == NULL)) {
		i--;
	}
	while ((j >= 0) && (box_for_node(b[j]) == NULL)) {
		j--;
	}

	if (i >= 0) {
		out[(*n_out)++] = a[i];
	}
	if (j >= 0) {
		out[(*n_out)++] = b[j];
	}

	/* The collected nodes stay alive without these references: each is
	 * an ancestor-or-self of a node the html_content itself holds. */
	html_chain_free(a, na);
	html_chain_free(b, nb);
}


/**
 * The screen area a box paints into, in document coordinates.
 */
static void html_box_paint_rect(struct box *box, struct rect *r)
{
	int x, y;

	box_coords(box, &x, &y);

	r->x0 = x - box->border[LEFT].width;
	r->y0 = y - box->border[TOP].width;
	r->x1 = x + box->padding[LEFT] + box->width + box->padding[RIGHT] +
		box->border[RIGHT].width;
	r->y1 = y + box->padding[TOP] + box->height + box->padding[BOTTOM] +
		box->border[BOTTOM].width;

	/* an overflowing descendant paints outside the box's own edges */
	if (x + box->descendant_x0 < r->x0) r->x0 = x + box->descendant_x0;
	if (y + box->descendant_y0 < r->y0) r->y0 = y + box->descendant_y0;
	if (x + box->descendant_x1 > r->x1) r->x1 = x + box->descendant_x1;
	if (y + box->descendant_y1 > r->y1) r->y1 = y + box->descendant_y1;
}

static void html_rect_union(struct rect *acc, const struct rect *r, bool *any)
{
	if (*any == false) {
		*acc = *r;
		*any = true;
		return;
	}
	if (r->x0 < acc->x0) acc->x0 = r->x0;
	if (r->y0 < acc->y0) acc->y0 = r->y0;
	if (r->x1 > acc->x1) acc->x1 = r->x1;
	if (r->y1 > acc->y1) acc->y1 = r->y1;
}


/**
 * What a dynamic restyle really touched.
 *
 * The re-selected SUBTREES are much wider than the boxes that change: a
 * pointer leaving a link and landing on a 3000px block re-selects both,
 * and only the link restyles.  So the repaint is driven by the boxes the
 * re-selection reported, not by the subtree roots — that is the
 * difference between invalidating 300x212 and invalidating the document.
 */
#define HTML_RESTYLE_MAX 64

struct html_restyle_state {
	struct box *box[HTML_RESTYLE_MAX];
	int n;
	bool overflow;
	struct rect area;
	bool any;
};

static void html_restyle_changed_cb(void *pw, struct box *box)
{
	struct html_restyle_state *st = pw;
	struct rect r;

	/* the PRE-reflow rectangle: a restyle that moves a box has to
	 * repaint where the box was as well as where it went */
	html_box_paint_rect(box, &r);
	html_rect_union(&st->area, &r, &st->any);

	if (st->n == HTML_RESTYLE_MAX) {
		st->overflow = true;
		return;
	}
	st->box[st->n++] = box;
}

/**
 * Re-select the subtrees a `:hover` / `:active` transition changed, then
 * reflow and repaint just as much as that needs.
 */
static void html_restyle_dynamic(html_content *html, dom_node **nodes, int n)
{
	struct html_restyle_state st;
	struct box *roots[4];
	int nroots = 0;
	int i, j;

	memset(&st, 0, sizeof(st));

	for (i = 0; i < n; i++) {
		struct box *box;

		/* a NULL entry is the "restyle everything" fallback */
		box = (nodes[i] == NULL) ? html->layout :
					   box_for_node(nodes[i]);
		if (box == NULL) {
			/* no box: `display: none`, or not built yet */
			continue;
		}

		/* drop a box already covered by an earlier one */
		for (j = 0; j < nroots; j++) {
			struct box *up;

			for (up = box; up != NULL; up = up->parent) {
				if (up == roots[j]) {
					break;
				}
			}
			if (up != NULL) {
				break;
			}
		}
		if (j < nroots) {
			continue;
		}

		roots[nroots++] = box;
	}

	for (i = 0; i < nroots; i++) {
		if (box_restyle_element(html, roots[i],
					html_restyle_changed_cb,
					&st) == false) {
			NSLOG(netsurf, ERROR,
			      "dynamic restyle failed (content %p)", html);
			return;
		}
	}

	if (st.any == false) {
		/* No rule keyed on the transition, so nothing to paint.
		 * This is the path every page without a dynamic rule takes,
		 * and it costs one re-selection per re-selected box. */
		return;
	}

	/* A dynamic rule may change geometry (`a:hover { padding: 4px }`),
	 * and this engine has no partial relayout, so reflow the document.
	 * `background` is true so the reflow does NOT drag a full-window
	 * repaint behind it — the bounded request below is the repaint. */
	if ((html->base.locked == false) &&
	    (html->reflowing == false) &&
	    (html->had_initial_layout) &&
	    ((html->base.status == CONTENT_STATUS_READY) ||
	     (html->base.status == CONTENT_STATUS_DONE))) {
		content__reformat(&html->base, true,
				  html->base.available_width,
				  html->base.available_height);

		/* where the changed boxes ended up */
		for (i = 0; i < st.n; i++) {
			struct rect r;

			html_box_paint_rect(st.box[i], &r);
			html_rect_union(&st.area, &r, &st.any);
		}

		/* More changed boxes than the list holds, so their new
		 * positions are unknown: fall back to the subtrees they came
		 * from, which contain all of them by construction. */
		if (st.overflow) {
			for (i = 0; i < nroots; i++) {
				struct rect r;

				html_box_paint_rect(roots[i], &r);
				html_rect_union(&st.area, &r, &st.any);
			}
		}
	}

	content__request_redraw(&html->base, st.area.x0, st.area.y0,
				st.area.x1 - st.area.x0,
				st.area.y1 - st.area.y0);
}


/**
 * Track the `:hover` and `:active` chains for one mouse action.
 *
 * Runs at the TOP of html_mouse_action, before the box walk, so that the
 * walk sees the boxes the restyle produced rather than the ones it
 * replaced.
 */
static void html_update_dynamic_chains(html_content *html,
				       browser_mouse_state mouse,
				       int x, int y)
{
	dom_node *changed[4];
	dom_node *hover, *active;
	int n = 0;

	/* Do not touch a box tree that is being built or swapped: the next
	 * mouse action re-derives everything from the pointer position
	 * anyway.
	 *
	 * The same goes for a tree something else is holding a box of.  An
	 * open select menu holds its gadget's box, and a drag holds the box
	 * it started on; a restyle here reflows the document under both.
	 * The press that arms `:active` arrives before any drag starts, and
	 * the release that clears it arrives after the drag has ended, so
	 * neither is lost. */
	if ((html->layout == NULL) ||
	    (html->reconverting) ||
	    (html->box_conversion_context != NULL) ||
	    (html->visible_select_menu != NULL) ||
	    (html->drag_type != HTML_DRAG_NONE)) {
		return;
	}

	hover = html_dynamic_element_at(html, x, y);

	/* `:active` names the element the button went down on, and keeps
	 * naming it for as long as the button is held. */
	if (mouse & BROWSER_MOUSE_PRESS_1) {
		active = (hover == NULL) ? NULL : dom_node_ref(hover);
	} else if (mouse & (BROWSER_MOUSE_HOLDING_1 |
			    BROWSER_MOUSE_DRAG_1 |
			    BROWSER_MOUSE_DRAG_ON)) {
		active = (html->active_node == NULL) ? NULL :
			 dom_node_ref(html->active_node);
	} else {
		active = NULL;
	}

	if ((hover == html->hover_node) && (active == html->active_node)) {
		if (hover != NULL) dom_node_unref(hover);
		if (active != NULL) dom_node_unref(active);
		return;
	}

	html_dynamic_changed(html->hover_node, hover, changed, &n);
	html_dynamic_changed(html->active_node, active, changed, &n);

	/* Publish the new chains BEFORE re-selecting: node_is_hover() and
	 * node_is_active() read them straight off the html_content. */
	if (html->hover_node != NULL) {
		dom_node_unref(html->hover_node);
	}
	html->hover_node = hover;
	if (html->active_node != NULL) {
		dom_node_unref(html->active_node);
	}
	html->active_node = active;

	if (n > 0) {
		html_restyle_dynamic(html, changed, n);
	}
}


/* exported interface documented in html/interaction.h */
nserror html_mouse_track(struct content *c,
			 struct browser_window *bw,
			 browser_mouse_state mouse,
			 int x, int y)
{
	return html_mouse_action(c, bw, mouse, x, y);
}


/* exported interface documented in html/interaction.h */
nserror
html_mouse_action(struct content *c,
		  struct browser_window *bw,
		  browser_mouse_state mouse,
		  int x, int y)
{
	html_content *html = (html_content *)c;
	nserror res = NSERROR_OK;

	/* DOM mouse events first, while html->drag_type still describes the
	 * state this action is about to change */
	html_fire_mouse_events(html, bw, mouse, x, y);

	/* then the dynamic pseudo-classes, so the box walk below runs
	 * against the boxes a :hover restyle produced (todos/0420) */
	html_update_dynamic_chains(html, mouse, x, y);

	/* handle open select menu */
	if (html->visible_select_menu != NULL) {
		return mouse_action_select_menu(html, bw, mouse, x, y);
	}

	/* handle content drag */
	switch (html->drag_type) {
	case HTML_DRAG_SELECTION:
		res = mouse_action_drag_selection(html, bw, mouse, x, y);
		break;

	case HTML_DRAG_SCROLLBAR:
		res = mouse_action_drag_scrollbar(html, bw, mouse, x, y);
		break;

	case HTML_DRAG_TEXTAREA_SELECTION:
	case HTML_DRAG_TEXTAREA_SCROLLBAR:
		res = mouse_action_drag_textarea(html, bw, mouse, x, y);
		break;

	case HTML_DRAG_CONTENT_SELECTION:
	case HTML_DRAG_CONTENT_SCROLL:
		res = mouse_action_drag_content(html, bw, mouse, x, y);
		break;

	case HTML_DRAG_NONE:
		res = mouse_action_drag_none(html, bw, mouse, x, y);
		break;

	default:
		/* Unknown content related drag type */
		assert(0 && "Unknown content related drag type");
	}

	if (res != NSERROR_OK) {
		NSLOG(netsurf, ERROR, "%s", messages_get_errorcode(res));
	}

	return res;
}


/**
 * Fire one DOM keyboard event at the right target.
 *
 * Upstream dispatched keydown at `html->layout->node` — the document root
 * — whatever had focus, so a listener on the `<input>` the user was typing
 * into never ran and every page had to listen on `document`.  The DOM says
 * the FOCUSED element is the target and the event bubbles to the root from
 * there, which is both correct and a superset: a document-level listener
 * still sees it.
 */
static void fire_dom_key_event(html_content *html, dom_string *type,
			       uint32_t key)
{
	dom_node *target = NULL;

	if (html->layout == NULL) {
		return;
	}

	if (NETSURF_UI_EVENTS) {
		switch (html->focus_type) {
		case HTML_FOCUS_TEXTAREA:
			if (html->focus_owner.textarea != NULL) {
				target = html->focus_owner.textarea->node;
			}
			break;

		case HTML_FOCUS_CONTENT:
			if (html->focus_owner.content != NULL) {
				target = html->focus_owner.content->node;
			}
			break;

		default:
			break;
		}
	}

	if (target == NULL) {
		target = html->layout->node;
	}
	if (target == NULL) {
		return;
	}

	fire_dom_keyboard_event(type, target, true, true, key);
}


/**
 * Handle key releases.
 *
 * \param  c	content of type HTML
 * \param  key	The UCS4 character codepoint
 * \return true if key handled, false otherwise
 */
bool html_key_release(struct content *c, uint32_t key)
{
	html_content *html = (html_content *) c;

	fire_dom_key_event(html, corestring_dom_keyup, key);

	/* Nothing in the core acts on a release; it exists so the DOM can
	 * see one.  Reporting "not handled" keeps every front-end fallback
	 * (scroll on an unclaimed arrow key) behaving exactly as before. */
	return false;
}


/**
 * Handle keypresses.
 *
 * \param  c	content of type HTML
 * \param  key	The UCS4 character codepoint
 * \return true if key handled, false otherwise
 */
bool html_keypress(struct content *c, uint32_t key)
{
	html_content *html = (html_content *) c;
	struct selection *sel = html->sel;

	/** \todo
	 * At the moment, the front end interface for keypress only gives
	 * us a UCS4 key value.  This doesn't doesn't have all the information
	 * we need to fill out the event properly.  We don't get to know about
	 * modifier keys, and things like CTRL+C are passed in as
	 * \ref NS_KEY_COPY_SELECTION, a magic value outside the valid Unicode
	 * range.
	 *
	 * We need to:
	 *
	 * 1. Update the front end interface so that both press and release
	 *    events reach the core.
	 * 2. Stop encoding the special keys like \ref NS_KEY_COPY_SELECTION as
	 *    magic values in the front ends, so we just get the events, e.g.:
	 *    1. Press ctrl
	 *    2. Press c
	 *    3. Release c
	 *    4. Release ctrl
	 * 3. Pass all the new info to the DOM KeyboardEvent events.
	 * 4. If there is a focused element, fire the event at that, instead of
	 *    `html->layout->node`.
	 * 5. Rebuild the \ref NS_KEY_COPY_SELECTION values from the info we
	 *    now get given, and use that for the code below this
	 *    \ref fire_dom_keyboard_event call.
	 * 6. Move the code after this \ref fire_dom_keyboard_event call into
	 *    the default action handler for DOM events.
	 *
	 * This will mean that if the JavaScript event listener does
	 * `event.preventDefault()` then we won't handle the event when
	 * we're not supposed to.
	 */
	fire_dom_key_event(html, corestring_dom_keydown, key);

	switch (html->focus_type) {
	case HTML_FOCUS_CONTENT:
		return content_keypress(html->focus_owner.content->object, key);

	case HTML_FOCUS_TEXTAREA:
		if (box_textarea_keypress(html, html->focus_owner.textarea, key) == NSERROR_OK) {
			return true;
		} else {
			return false;
		}

	default:
		/* Deal with it below */
		break;
	}

	switch (key) {
	case NS_KEY_COPY_SELECTION:
		selection_copy_to_clipboard(sel);
		return true;

	case NS_KEY_CLEAR_SELECTION:
		selection_clear(sel, true);
		return true;

	case NS_KEY_SELECT_ALL:
		selection_select_all(sel);
		return true;

	case NS_KEY_ESCAPE:
		/* if there's no selection, leave Escape for the caller */
		return selection_clear(sel, true);
	}

	return false;
}


/**
 * Callback for in-page scrollbars.
 */
void html_overflow_scroll_callback(void *client_data,
		struct scrollbar_msg_data *scrollbar_data)
{
	struct html_scrollbar_data *data = client_data;
	html_content *html = (html_content *)data->c;
	struct box *box = data->box;
	union content_msg_data msg_data;
	html_drag_type drag_type;
	union html_drag_owner drag_owner;

	switch(scrollbar_data->msg) {
	case SCROLLBAR_MSG_MOVED:

		if (html->reflowing == true) {
			/* Can't redraw during layout, and it will
			 * be redrawn after layout anyway. */
			break;
		}

		html__redraw_a_box(html, box);
		break;
	case SCROLLBAR_MSG_SCROLL_START:
	{
		struct rect rect = {
			.x0 = scrollbar_data->x0,
			.y0 = scrollbar_data->y0,
			.x1 = scrollbar_data->x1,
			.y1 = scrollbar_data->y1
		};
		drag_type = HTML_DRAG_SCROLLBAR;
		drag_owner.scrollbar = scrollbar_data->scrollbar;
		html_set_drag_type(html, drag_type, drag_owner, &rect);
	}
		break;
	case SCROLLBAR_MSG_SCROLL_FINISHED:
		drag_type = HTML_DRAG_NONE;
		drag_owner.no_owner = true;
		html_set_drag_type(html, drag_type, drag_owner, NULL);

		msg_data.pointer = BROWSER_POINTER_AUTO;
		content_broadcast(data->c, CONTENT_MSG_POINTER, &msg_data);
		break;
	}
}


/* Documented in html_internal.h */
void html_set_drag_type(html_content *html, html_drag_type drag_type,
		union html_drag_owner drag_owner, const struct rect *rect)
{
	union content_msg_data msg_data;

	assert(html != NULL);

	html->drag_type = drag_type;
	html->drag_owner = drag_owner;

	switch (drag_type) {
	case HTML_DRAG_NONE:
		assert(drag_owner.no_owner == true);
		msg_data.drag.type = CONTENT_DRAG_NONE;
		break;

	case HTML_DRAG_SCROLLBAR:
	case HTML_DRAG_TEXTAREA_SCROLLBAR:
	case HTML_DRAG_CONTENT_SCROLL:
		msg_data.drag.type = CONTENT_DRAG_SCROLL;
		break;

	case HTML_DRAG_SELECTION:
		assert(drag_owner.no_owner == true);
		fallthrough;
	case HTML_DRAG_TEXTAREA_SELECTION:
	case HTML_DRAG_CONTENT_SELECTION:
		msg_data.drag.type = CONTENT_DRAG_SELECTION;
		break;
	}
	msg_data.drag.rect = rect;

	/* Inform of the content's drag status change */
	content_broadcast((struct content *)html, CONTENT_MSG_DRAG, &msg_data);
}

/**
 * The DOM node that owns a focus state, if any.
 *
 * HTML_FOCUS_SELF is the document itself, which has no element to fire at.
 */
static dom_node *html_focus_node(html_content *html,
				 html_focus_type type,
				 const union html_focus_owner *owner)
{
	switch (type) {
	case HTML_FOCUS_CONTENT:
		return (owner->content != NULL) ? owner->content->node : NULL;

	case HTML_FOCUS_TEXTAREA:
		return (owner->textarea != NULL) ? owner->textarea->node : NULL;

	default:
		return NULL;
	}
}

/* Documented in html_internal.h */
void html_set_focus(html_content *html, html_focus_type focus_type,
		union html_focus_owner focus_owner, bool hide_caret,
		int x, int y, int height, const struct rect *clip)
{
	union content_msg_data msg_data;
	int x_off = 0;
	int y_off = 0;
	struct rect cr;
	dom_node *old_node = NULL;
	dom_node *new_node = NULL;
	struct form_control *lost_control = NULL;
	bool textarea_lost_focus = html->focus_type == HTML_FOCUS_TEXTAREA &&
			focus_type != HTML_FOCUS_TEXTAREA;

	assert(html != NULL);

	/* Note who is losing and gaining focus BEFORE the switch below
	 * overwrites it, so blur/focus can be dispatched afterwards. */
	if (html->jsthread != NULL) {
		old_node = html_focus_node(html, html->focus_type,
					   &html->focus_owner);
		new_node = html_focus_node(html, focus_type, &focus_owner);
	}
	if ((html->focus_type == HTML_FOCUS_TEXTAREA) &&
	    (html->focus_owner.textarea != NULL)) {
		lost_control = html->focus_owner.textarea->gadget;
	}
	if ((focus_type == HTML_FOCUS_TEXTAREA) &&
	    (focus_owner.textarea != NULL) &&
	    (focus_owner.textarea->gadget != lost_control)) {
		form_gadget_note_focus(focus_owner.textarea->gadget);
	}

	switch (focus_type) {
	case HTML_FOCUS_SELF:
		assert(focus_owner.self == true);
		if (html->focus_type == HTML_FOCUS_SELF)
			/* Don't need to tell anyone anything */
			return;
		break;

	case HTML_FOCUS_CONTENT:
		box_coords(focus_owner.content, &x_off, &y_off);
		break;

	case HTML_FOCUS_TEXTAREA:
		box_coords(focus_owner.textarea, &x_off, &y_off);
		break;
	}

	html->focus_type = focus_type;
	html->focus_owner = focus_owner;

	if (textarea_lost_focus) {
		msg_data.caret.type = CONTENT_CARET_REMOVE;
	} else if (focus_type != HTML_FOCUS_SELF && hide_caret) {
		msg_data.caret.type = CONTENT_CARET_HIDE;
	} else {
		if (clip != NULL) {
			cr = *clip;
			cr.x0 += x_off;
			cr.y0 += y_off;
			cr.x1 += x_off;
			cr.y1 += y_off;
		}

		msg_data.caret.type = CONTENT_CARET_SET_POS;
		msg_data.caret.pos.x = x + x_off;
		msg_data.caret.pos.y = y + y_off;
		msg_data.caret.pos.height = height;
		msg_data.caret.pos.clip = (clip == NULL) ? NULL : &cr;
	}

	/* Inform of the content's drag status change */
	content_broadcast((struct content *)html, CONTENT_MSG_CARET, &msg_data);

	if ((NETSURF_UI_EVENTS == 0) || (old_node == new_node)) {
		return;
	}

	/* A text control that has been edited and is now losing focus fires
	 * `change` — the classic "commit on blur" contract every form
	 * validator is written against.  It goes BEFORE blur. */
	if ((lost_control != NULL) && (new_node != old_node)) {
		form_gadget_commit_change(lost_control);
	}

	/* focus/blur do NOT bubble (focusin/focusout would; nothing in the
	 * core generates those yet — todos/0317). */
	if (old_node != NULL) {
		fire_generic_dom_event(corestring_dom_blur, old_node,
				       false, false);
	}
	if (new_node != NULL) {
		fire_generic_dom_event(corestring_dom_focus, new_node,
				       false, false);
	}
}



/* Documented in html_internal.h */
void html_set_selection(html_content *html, html_selection_type selection_type,
		union html_selection_owner selection_owner, bool read_only)
{
	union content_msg_data msg_data;
	struct box *box;
	bool changed = false;
	bool same_type = html->selection_type == selection_type;

	assert(html != NULL);

	if ((selection_type == HTML_SELECTION_NONE &&
			html->selection_type != HTML_SELECTION_NONE) ||
			(selection_type != HTML_SELECTION_NONE &&
			html->selection_type == HTML_SELECTION_NONE))
		/* Existance of selection has changed, and we'll need to
		 * inform our owner */
		changed = true;

	/* Clear any existing selection */
	if (html->selection_type != HTML_SELECTION_NONE) {
		switch (html->selection_type) {
		case HTML_SELECTION_SELF:
			if (same_type)
				break;
			selection_clear(html->sel, true);
			break;
		case HTML_SELECTION_TEXTAREA:
			if (same_type && html->selection_owner.textarea ==
					selection_owner.textarea)
				break;
			box = html->selection_owner.textarea;
			textarea_clear_selection(box->gadget->data.text.ta);
			break;
		case HTML_SELECTION_CONTENT:
			if (same_type && html->selection_owner.content ==
					selection_owner.content)
				break;
			box = html->selection_owner.content;
			content_clear_selection(box->object);
			break;
		default:
			break;
		}
	}

	html->selection_type = selection_type;
	html->selection_owner = selection_owner;

	if (!changed)
		/* Don't need to report lack of change to owner */
		return;

	/* Prepare msg */
	switch (selection_type) {
	case HTML_SELECTION_NONE:
		assert(selection_owner.none == true);
		msg_data.selection.selection = false;
		break;
	case HTML_SELECTION_SELF:
		assert(selection_owner.none == false);
		fallthrough;
	case HTML_SELECTION_TEXTAREA:
	case HTML_SELECTION_CONTENT:
		msg_data.selection.selection = true;
		break;
	default:
		break;
	}
	msg_data.selection.read_only = read_only;

	/* Inform of the content's selection status change */
	content_broadcast((struct content *)html, CONTENT_MSG_SELECTION,
			&msg_data);
}
