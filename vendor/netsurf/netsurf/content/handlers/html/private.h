/*
 * Copyright 2004 James Bursa <bursa@users.sourceforge.net>
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
 * Private data for text/html content.
 */

#ifndef NETSURF_HTML_PRIVATE_H
#define NETSURF_HTML_PRIVATE_H

#include <dom/bindings/hubbub/parser.h>

#include "netsurf/types.h"
#include "netsurf/uievents.h"
#include "content/content_protected.h"
#include "content/handlers/css/utils.h"


struct gui_layout_table;
struct scrollbar_msg_data;
struct content_redraw_data;
struct selection;

typedef enum {
	HTML_DRAG_NONE,			/** No drag */
	HTML_DRAG_SELECTION,		/** Own; Text selection */
	HTML_DRAG_SCROLLBAR,		/** Not own; drag in scrollbar widget */
	HTML_DRAG_TEXTAREA_SELECTION,	/** Not own; drag in textarea widget */
	HTML_DRAG_TEXTAREA_SCROLLBAR,	/** Not own; drag in textarea widget */
	HTML_DRAG_CONTENT_SELECTION,	/** Not own; drag in child content */
	HTML_DRAG_CONTENT_SCROLL	/** Not own; drag in child content */
} html_drag_type;

/**
 * For drags we don't own
 */
union html_drag_owner {
	bool no_owner;
	struct box *content;
	struct scrollbar *scrollbar;
	struct box *textarea;
};

typedef enum {
	HTML_SELECTION_NONE,		/** No selection */
	HTML_SELECTION_TEXTAREA,	/** Selection in one of our textareas */
	HTML_SELECTION_SELF,		/** Selection in this html content */
	HTML_SELECTION_CONTENT		/** Selection in child content */
} html_selection_type;

/**
 * For getting at selections in this content or things in this content
 */
union html_selection_owner {
	bool none;
	struct box *textarea;
	struct box *content;
};

typedef enum {
	HTML_FOCUS_SELF,		/**< Focus is our own */
	HTML_FOCUS_CONTENT,		/**< Focus belongs to child content */
	HTML_FOCUS_TEXTAREA		/**< Focus belongs to textarea */
} html_focus_type;

/**
 * For directing input
 */
union html_focus_owner {
	bool self;
	struct box *textarea;
	struct box *content;
};

/**
 * Data specific to CONTENT_HTML.
 */
typedef struct html_content {
	struct content base;

	dom_hubbub_parser *parser; /**< Parser object handle */
	bool parse_completed; /**< Whether the parse has been completed */
	bool conversion_begun; /**< Whether or not the conversion has begun */

	/** Document tree */
	dom_document *document;
	/** Quirkyness of document */
	dom_document_quirks_mode quirks;

	/** Encoding of source, NULL if unknown. */
	char *encoding;
	/** Source of encoding information. */
	dom_hubbub_encoding_source encoding_source;

	/** Base URL (may be a copy of content->url). */
	struct nsurl *base_url;
	/** Base target */
	char *base_target;

	/** Content has been aborted in the LOADING state */
	bool aborted;

	/** Whether a meta refresh has been handled */
	bool refresh;

	/** Whether a layout (reflow) is in progress */
	bool reflowing;

	/** Whether an initial layout has been done */
	bool had_initial_layout;

	/** Whether scripts are enabled for this content */
	bool enable_scripting;

	/* Title element node */
	dom_node *title;

	/** A talloc context purely for the render box tree */
	int *bctx;
	/** A context pointer for the box conversion, NULL if no conversion
	 * is in progress.
	 */
	void *box_conversion_context;
	/** Box tree, or NULL. */
	struct box *layout;
	/** Previous box tree talloc context, kept alive while a live
	 * re-conversion (JS DOM mutation) builds its replacement; freed
	 * at the swap. */
	int *reconvert_old_bctx;
	/** A live re-conversion is in progress */
	bool reconverting;
	/** Mutations arrived while a re-conversion was in progress */
	bool reconvert_pending;
	/** Text gadget that claimed the caret DURING a live re-conversion,
	 * before its new box existed (a click landing mid-window):
	 * recorded by box_textarea_callback, honoured when construction
	 * recreates that gadget's widget.  Gadgets outlive the window (the
	 * forms own them), so the pointer cannot dangle inside it.  NULL
	 * outside a re-conversion.  Unlike drag and selection, the FOCUS
	 * itself is NOT surrendered for the window: it is the input
	 * routing table, the old box it names stays alive serving input
	 * until the swap by design, and html_reconvert_box_done re-binds
	 * it to the new tree at the swap. */
	struct form_control *reconvert_focus_claim;
	/** Document background colour. */
	colour background_colour;

	/** Font callback table */
	const struct gui_layout_table *font_func;

	/** Number of entries in scripts */
	unsigned int scripts_count;
	/** Scripts */
	struct html_script *scripts;
	/** javascript thread in use */
	struct jsthread *jsthread;

	/** Number of entries in stylesheet_content. */
	unsigned int stylesheet_count;
	/** Stylesheets. Each may be NULL. */
	struct html_stylesheet *stylesheets;
	/**< Style selection context */
	css_select_ctx *select_ctx;
	/**< Style selection media specification */
	css_media media;
	/** CSS length conversion context for document. */
	css_unit_ctx unit_len_ctx;
	/**< Universal selector */
	lwc_string *universal;

	/** Number of entries in object_list. */
	unsigned int num_objects;
	/** List of objects. */
	struct content_html_object *object_list;
	/** Forms, in reverse order to document. */
	struct form *forms;
	/** Controls belonging to no form, in reverse order to document.
	 * Kept so a control can be re-found by DOM node exactly like a
	 * form-owned one (live re-conversion re-binds gadgets that way),
	 * and so it has an owner to be freed by. */
	struct form_control *formless_controls;
	/** Hash table of imagemaps. */
	struct imagemap **imagemaps;

	/** Browser window containing this document, or NULL if not open. */
	struct browser_window *bw;

	/** Frameset information */
	struct content_html_frames *frameset;

	/** Inline frame information */
	struct content_html_iframe *iframe;

	/** Content of type CONTENT_HTML containing this, or NULL if not an
	 * object within a page. */
	struct html_content *page;

	/** The last DOM `mousedown` had preventDefault() called on it, so
	 * the native drag it would otherwise have started (page scroll,
	 * text selection) must not happen.  This is the standard browser
	 * contract, and it is what makes a drag-to-draw canvas possible:
	 * without it netsurf turns any press-and-move over a non-text box
	 * into a page-scroll drag, which swallows every later motion
	 * before the content ever sees it. */
	bool mouse_default_prevented;

	/** A button is down as far as the DOM is concerned.
	 *
	 * netsurf's model has no button-release event: a release that was
	 * not a drag arrives as BROWSER_MOUSE_CLICK_n, and one that ENDED a
	 * drag arrives as a plain track with nothing held.  Remembering that
	 * a press happened is what lets both be recognised as the `mouseup`
	 * they are — without it, the release that ends a drag is
	 * indistinguishable from an ordinary hover. */
	bool mouse_pressed;

	/** The deepest ELEMENT under the pointer, or NULL — the subject of
	 * the `:hover` chain (todos/0420).  A reference is held, because a
	 * script can remove the node from the document while the pointer
	 * still rests on it.  Kept as a DOM node rather than as a box so
	 * that it survives a live re-conversion: the box tree is replaced,
	 * the element is not. */
	dom_node *hover_node;

	/** The deepest ELEMENT the primary button went down on, or NULL —
	 * the subject of the `:active` chain.  Same ownership as
	 * hover_node. */
	dom_node *active_node;

	/** Current drag type */
	html_drag_type drag_type;
	/** Widget capturing all mouse events */
	union html_drag_owner drag_owner;

	/** Current selection state */
	html_selection_type selection_type;
	/** Current selection owner */
	union html_selection_owner selection_owner;

	/** Current input focus target type */
	html_focus_type focus_type;
	/** Current input focus target */
	union html_focus_owner focus_owner;

	/** HTML content's own text selection object */
	struct selection *sel;

	/**
	 * Open core-handled form SELECT menu, or NULL if none
	 *  currently open.
	 */
	struct form_control *visible_select_menu;

	/** Non-zero while the form code writes its OWN state back into
	 * the DOM (option `selected` flips).  Those writes are already
	 * fully rendered by the form code itself, so the mutation
	 * bridge must not schedule a re-conversion for them — a re-box
	 * would destroy the open select menu on every multi-select
	 * toggle (the TEXTAREA/INPUT value-edit precedent, todos/0422).
	 * JS-originated option mutations keep the reconvert path. */
	int form_selfmutation;

} html_content;

/**
 * Render padding and margin box outlines in html_redraw().
 */
extern bool html_redraw_debug;


/* in html/html.c */

/**
 * redraw a box
 *
 * \param htmlc HTML content
 * \param box The box to redraw.
 */
void html__redraw_a_box(html_content *htmlc, struct box *box);


/**
 * Complete conversion of an HTML document
 *
 * \param htmlc Content to convert
 */
void html_finish_conversion(html_content *htmlc);


/**
 * Schedule a live re-conversion (re-box + reflow + repaint) of a
 * converted document whose DOM has been mutated (e.g. by script).
 *
 * Coalesces: any number of calls before the scheduled pass runs
 * result in one re-conversion.  Safe to call at any time; ignored
 * until the initial conversion has produced a layout.
 */
void html_schedule_reconvert(html_content *htmlc);


/**
 * Test if an HTML content conversion can begin
 *
 * \param htmlc		html content to test
 * \return true iff the html content conversion can begin
 */
bool html_can_begin_conversion(html_content *htmlc);


/**
 * Begin conversion of an HTML document
 *
 * \param htmlc Content to convert
 */
bool html_begin_conversion(html_content *htmlc);


/**
 * execute some text as a script element
 */
bool html_exec(struct content *c, const char *src, size_t srclen);


/**
 * Attempt script execution for defer and async scripts
 *
 * execute scripts using algorithm found in:
 * http://www.whatwg.org/specs/web-apps/current-work/multipage/scripting-1.html#the-script-element
 *
 * \param htmlc html content.
 * \param allow_defer allow deferred execution, if not, only async scripts.
 * \return NSERROR_OK error code.
 */
nserror html_script_exec(html_content *htmlc, bool allow_defer);


/**
 * Free all script resources and references for a html content.
 *
 * \param htmlc html content.
 * \return NSERROR_OK or error code.
 */
nserror html_script_free(html_content *htmlc);


/**
 * Check if any of the scripts loaded were insecure
 */
bool html_saw_insecure_scripts(html_content *htmlc);


/**
 * Complete the HTML content state machine *iff* all scripts are finished
 */
nserror html_proceed_to_done(html_content *html);


/* in html/redraw.c */
bool html_redraw(struct content *c, struct content_redraw_data *data,
		const struct rect *clip, const struct redraw_context *ctx);


/* in html/redraw_border.c */
bool html_redraw_borders(struct box *box, int x_parent, int y_parent,
		int p_width, int p_height, const struct rect *clip, float scale,
		const struct redraw_context *ctx);


bool html_redraw_inline_borders(struct box *box, struct rect b,
		const struct rect *clip, float scale, bool first, bool last,
		const struct redraw_context *ctx);


/* in html/script.c */
dom_hubbub_error html_process_script(void *ctx, dom_node *node);


/* in html/forms.c */
struct form *html_forms_get_forms(const char *docenc, dom_html_document *doc);

/**
 * Find (or make) the form control that belongs to a DOM node.
 *
 * Box construction calls this for every control element; a node that
 * already has a control gets that SAME control back, which is what
 * lets gadget state (and everything the frontend hangs off a gadget)
 * survive a live re-conversion of the box tree.  A control invented
 * for a node outside any form is remembered on the content so it is
 * re-found — and freed — the same way.
 *
 * \param c     content the node belongs to
 * \param node  the control's DOM node
 * \return the control, or NULL on memory exhaustion
 */
struct form_control *html_forms_get_control_for_node(html_content *c,
		dom_node *node);

/**
 * Free every control the content adopted for want of a form.
 *
 * \param c  content whose formless controls are to be freed
 */
void html_forms_free_formless_controls(html_content *c);


/* in html/css_fetcher.c */
/**
 * Register the fetcher for the pseudo x-ns-css scheme.
 *
 * \return NSERROR_OK on successful registration or error code on failure.
 */
nserror html_css_fetcher_register(void);
nserror html_css_fetcher_add_item(dom_string *data, struct nsurl *base_url,
		uint32_t *key);


/* Events */
/**
 * Construct an event and fire it at the DOM
 *
 */
bool fire_generic_dom_event(dom_string *type, dom_node *target,
		    bool bubbles, bool cancelable);

/**
 * Modifier keys held when a UI event was generated.
 *
 * The core's browser_mouse_state has MOD_1..MOD_4 with a per-front-end
 * meaning; these are the DOM names those map onto.
 */
enum html_event_mod {
	HTML_MOD_SHIFT = (1 << 0),
	HTML_MOD_CTRL  = (1 << 1),
	HTML_MOD_ALT   = (1 << 2),
	HTML_MOD_META  = (1 << 3)
};

/**
 * Where a mouse event happened, in both coordinate spaces script can ask for.
 *
 * The core is handed DOCUMENT-relative coordinates; the viewport scroll
 * offset belongs to the front end (guit->window->get_scroll), so both are
 * carried explicitly rather than one being guessed from the other.
 */
struct dom_mouse_event_pos {
	int page_x;	/**< document-relative x (DOM pageX) */
	int page_y;	/**< document-relative y (DOM pageY) */
	int client_x;	/**< viewport-relative x (DOM clientX) */
	int client_y;	/**< viewport-relative y (DOM clientY) */
};

/**
 * Find the deepest DOM node under a document coordinate.
 *
 * Never NULL for a converted document: the root element is the floor.
 *
 * \param html the content
 * \param x    document-relative x
 * \param y    document-relative y
 */
dom_node *html_dom_node_at_point(html_content *html, int x, int y);

/**
 * Construct a MouseEvent and fire it at the DOM
 *
 * \param type       the event type, e.g. corestring_dom_mousedown
 * \param target     the node to dispatch at
 * \param bubbles    whether the event bubbles
 * \param cancelable whether preventDefault() means anything
 * \param pos        where it happened
 * \param button     DOM button number of the button that changed state
 * \param buttons    DOM bitmask of the buttons currently held
 * \param mods       \ref html_event_mod bitmask
 * \param detail     the UIEvent detail; the click count for click events
 * \return false if a listener called preventDefault(), true otherwise
 */
bool fire_dom_mouse_event(dom_string *type, dom_node *target,
		bool bubbles, bool cancelable,
		const struct dom_mouse_event_pos *pos,
		unsigned short button, unsigned short buttons,
		unsigned int mods, int detail);

/**
 * Construct a WheelEvent and fire it at the DOM
 *
 * \param delta_x  horizontal scroll step in pixels, positive = rightwards
 * \param delta_y  vertical scroll step in pixels, positive = downwards
 * \return false if a listener called preventDefault(), true otherwise
 */
bool fire_dom_wheel_event(dom_string *type, dom_node *target,
		bool bubbles, bool cancelable,
		const struct dom_mouse_event_pos *pos,
		unsigned int mods, int delta_x, int delta_y);

/**
 * Construct a keyboard event and fire it at the DOM
 */
bool fire_dom_keyboard_event(dom_string *type, dom_node *target,
		bool bubbles, bool cancelable, uint32_t key);

/* Useful dom_string pointers */
struct dom_string;

extern struct dom_string *html_dom_string_map;
extern struct dom_string *html_dom_string_id;
extern struct dom_string *html_dom_string_name;
extern struct dom_string *html_dom_string_area;
extern struct dom_string *html_dom_string_a;
extern struct dom_string *html_dom_string_nohref;
extern struct dom_string *html_dom_string_href;
extern struct dom_string *html_dom_string_target;
extern struct dom_string *html_dom_string_shape;
extern struct dom_string *html_dom_string_default;
extern struct dom_string *html_dom_string_rect;
extern struct dom_string *html_dom_string_rectangle;
extern struct dom_string *html_dom_string_coords;
extern struct dom_string *html_dom_string_circle;
extern struct dom_string *html_dom_string_poly;
extern struct dom_string *html_dom_string_polygon;
extern struct dom_string *html_dom_string_text_javascript;
extern struct dom_string *html_dom_string_type;
extern struct dom_string *html_dom_string_src;

#endif
