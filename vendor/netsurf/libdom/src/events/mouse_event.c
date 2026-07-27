/*
 * This file is part of libdom.
 * Licensed under the MIT License,
 *                http://www.opensource.org/licenses/mit-license.php
 * Copyright 2009 Bo Yang <struggleyb.nku@gmail.com>
 */

#include <stdlib.h>
#include <string.h>

#include "events/mouse_event.h"
#include "core/document.h"

#include "../utils/utils.h"

static void _virtual_dom_mouse_event_destroy(struct dom_event *evt);

static const struct dom_event_private_vtable _event_vtable = {
	_virtual_dom_mouse_event_destroy
};

/* Constructor */
dom_exception _dom_mouse_event_create(struct dom_mouse_event **evt)
{
	*evt = malloc(sizeof(dom_mouse_event));
	if (*evt == NULL) 
		return DOM_NO_MEM_ERR;
	
	((struct dom_event *) *evt)->vtable = &_event_vtable;

	return _dom_mouse_event_initialise(*evt);
}

/* Destructor */
void _dom_mouse_event_destroy(struct dom_mouse_event *evt)
{
	_dom_mouse_event_finalise((dom_ui_event *) evt);

	free(evt);
}

/* Initialise function */
dom_exception _dom_mouse_event_initialise(struct dom_mouse_event *evt)
{
	dom_exception err;

	evt->modifier_state = 0;
	evt->buttons = 0;

	err = _dom_ui_event_initialise((dom_ui_event *) evt);

	/* Claim the class for _dom_event_is_mouse_event, AFTER the base
	 * class initialiser — which clears the flag — has run.  Every
	 * mouse-derived class (wheel, multi-wheel, drag) comes through
	 * here. */
	((struct dom_event *) evt)->is_mouse = true;

	return err;
}

/* The virtual destroy function */
void _virtual_dom_mouse_event_destroy(struct dom_event *evt)
{
	_dom_mouse_event_destroy((dom_mouse_event *) evt);
}

/*----------------------------------------------------------------------*/
/* The public API */

/**
 * Get screenX
 *
 * \param evt  The Event object
 * \param x    The returned screenX
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_screen_x(dom_mouse_event *evt,
		int32_t *x)
{
	*x = evt->sx;

	return DOM_NO_ERR;
}

/**
 * Get screenY
 *
 * \param evt  The Event object
 * \param y    The returned screenY
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_screen_y(dom_mouse_event *evt,
		int32_t *y)
{
	*y = evt->sy;

	return DOM_NO_ERR;
}

/**
 * Get clientX
 *
 * \param evt  The Event object
 * \param x    The returned clientX
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_client_x(dom_mouse_event *evt,
		int32_t *x)
{
	*x = evt->cx;

	return DOM_NO_ERR;
}

/**
 * Get clientY
 *
 * \param evt  The Event object
 * \param y    The returned clientY
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_client_y(dom_mouse_event *evt,
		int32_t *y)
{
	*y = evt->cy;

	return DOM_NO_ERR;
}

/**
 * Get the ctrl key state
 *
 * \param evt  The Event object
 * \param key  Whether the Control key is pressed down
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_ctrl_key(dom_mouse_event *evt,
		bool *key)
{
	*key = ((evt->modifier_state & DOM_MOD_CTRL) != 0);

	return DOM_NO_ERR;
}

/**
 * Get the shift key state
 *
 * \param evt  The Event object
 * \param key  Whether the Shift key is pressed down
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_shift_key(dom_mouse_event *evt,
		bool *key)
{
	*key = ((evt->modifier_state & DOM_MOD_SHIFT) != 0);

	return DOM_NO_ERR;
}
		
/**
 * Get the alt key state
 *
 * \param evt  The Event object
 * \param key  Whether the Alt key is pressed down
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_alt_key(dom_mouse_event *evt,
		bool *key)
{
	*key = ((evt->modifier_state & DOM_MOD_ALT) != 0);

	return DOM_NO_ERR;
}

/**
 * Get the meta key state
 *
 * \param evt  The Event object
 * \param key  Whether the Meta key is pressed down
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_meta_key(dom_mouse_event *evt,
		bool *key)
{
	*key = ((evt->modifier_state & DOM_MOD_META) != 0);

	return DOM_NO_ERR;
}

/**
 * Get the button which get pressed
 *
 * \param evt     The Event object
 * \param button  The pressed mouse button
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_button(dom_mouse_event *evt,
		unsigned short *button)
{
	*button = evt->button;

	return DOM_NO_ERR;
}

/**
 * Is this event really a mouse event?
 *
 * \param evt  The Event object
 * \param is   Set to whether evt is a dom_mouse_event or a subclass
 * \return DOM_NO_ERR.
 */
dom_exception _dom_event_is_mouse_event(dom_event *evt, bool *is)
{
	*is = evt->is_mouse;

	return DOM_NO_ERR;
}

/**
 * Get the bitmask of buttons currently held
 *
 * \param evt      The Event object
 * \param buttons  The bitmask (1 = primary, 2 = secondary, 4 = auxiliary)
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_buttons(dom_mouse_event *evt,
		unsigned short *buttons)
{
	*buttons = evt->buttons;

	return DOM_NO_ERR;
}

/**
 * Set the bitmask of buttons currently held
 *
 * `buttons` post-dates the DOM L3 init this class was written against, so
 * it has no slot in _dom_mouse_event_init; the dispatcher sets it after
 * initialising the event.
 *
 * \param evt      The Event object
 * \param buttons  The bitmask
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_set_buttons(dom_mouse_event *evt,
		unsigned short buttons)
{
	evt->buttons = buttons;

	return DOM_NO_ERR;
}

/**
 * Get the related target
 *
 * \param evt  The Event object
 * \param et   The related EventTarget
 * \return DOM_NO_ERR.
 */
dom_exception _dom_mouse_event_get_related_target(dom_mouse_event *evt,
		dom_event_target **et)
{
	*et = evt->related_target;

	return DOM_NO_ERR;
}

/**
 * Query the state of a modifier using a key identifier
 *
 * \param evt    The event object
 * \param ml     The modifier identifier, such as "Alt", "Control", "Meta", 
 *               "AltGraph", "CapsLock", "NumLock", "Scroll", "Shift".
 * \param state  Whether the modifier key is pressed
 * \return DOM_NO_ERR on success, appropriate dom_exception on failure.
 *
 * @note: If an application wishes to distinguish between right and left 
 * modifiers, this information could be deduced using keyboard events and 
 * KeyboardEvent.keyLocation.
 */
dom_exception _dom_mouse_event_get_modifier_state(dom_mouse_event *evt,
		dom_string *m, bool *state)
{
	const char *data;
	size_t len;

	if (m == NULL) {
		*state = false;
		return DOM_NO_ERR;
	}

	data = dom_string_data(m);
	len = dom_string_byte_length(m);

	if (len == SLEN("AltGraph") && strncmp(data, "AltGraph", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_ALT_GRAPH) != 0);
	} else if (len == SLEN("Alt") && strncmp(data, "Alt", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_ALT) != 0);
	} else if (len == SLEN("CapsLock") &&
			strncmp(data, "CapsLock", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_CAPS_LOCK) != 0);
	} else if (len == SLEN("Control") &&
			strncmp(data, "Control", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_CTRL) != 0);
	} else if (len == SLEN("Meta") && strncmp(data, "Meta", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_META) != 0);
	} else if (len == SLEN("NumLock") &&
			strncmp(data, "NumLock", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_NUM_LOCK) != 0);
	} else if (len == SLEN("Scroll") &&
			strncmp(data, "Scroll", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_SCROLL) != 0);
	} else if (len == SLEN("Shift") && strncmp(data, "Shift", len) == 0) {
		*state = ((evt->modifier_state & DOM_MOD_SHIFT) != 0);
	}

	return DOM_NO_ERR;
}

/**
 * Initialise this mouse event
 *
 * \param evt         The Event object
 * \param type        The event's type
 * \param bubble      Whether this is a bubbling event
 * \param cancelable  Whether this is a cancelable event
 * \param view        The AbstractView associated with this event
 * \param detail      The detail information of this mouse event
 * \param screen_x    The x position of the mouse pointer in screen
 * \param screen_y    The y position of the mouse pointer in screen
 * \param client_x    The x position of the mouse pointer in client window
 * \param client_y    The y position of the mouse pointer in client window
 * \param alt         The state of Alt key, true for pressed, false otherwise
 * \param shift       The state of Shift key, true for pressed, false otherwise
 * \param mata        The state of Meta key, true for pressed, false otherwise
 * \param button      The mouse button pressed
 * \param et          The related target of this event, may be NULL
 * \return DOM_NO_ERR on success, appropriate dom_exception on failure.
 */
dom_exception _dom_mouse_event_init(dom_mouse_event *evt, 
		dom_string *type, bool bubble, bool cancelable, 
		struct dom_abstract_view *view, int32_t detail, int32_t screen_x,
		int32_t screen_y, int32_t client_x, int32_t client_y, bool ctrl,
		bool alt, bool shift, bool meta, unsigned short button,
		dom_event_target *et)
{
	evt->sx = screen_x;
	evt->sy = screen_y;
	evt->cx = client_x;
	evt->cy = client_y;

	evt->modifier_state = 0;
	if (ctrl == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_CTRL;
	}
	if (alt == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_ALT;
	}
	if (shift == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_SHIFT;
	}
	if (meta == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_META;
	}
	
	evt->button = button;
	evt->related_target = et;

	return _dom_ui_event_init(&evt->base, type, bubble, cancelable, view,
			detail);
}

/**
 * Initialise the event with namespace
 *
 * \param evt         The Event object
 * \param namespace   The namespace of this event
 * \param type        The event's type
 * \param bubble      Whether this is a bubbling event
 * \param cancelable  Whether this is a cancelable event
 * \param view        The AbstractView associated with this event
 * \param detail      The detail information of this mouse event
 * \param screen_x    The x position of the mouse pointer in screen
 * \param screen_y    The y position of the mouse pointer in screen
 * \param client_x    The x position of the mouse pointer in client window
 * \param client_y    The y position of the mouse pointer in client window
 * \param alt         The state of Alt key, true for pressed, false otherwise
 * \param shift       The state of Shift key, true for pressed, false otherwise
 * \param mata        The state of Meta key, true for pressed, false otherwise
 * \param button      The mouse button pressed
 * \param et          The related target of this event, may be NULL
 * \return DOM_NO_ERR on success, appropriate dom_exception on failure.
 */
dom_exception _dom_mouse_event_init_ns(dom_mouse_event *evt,
		dom_string *namespace, dom_string *type,
		bool bubble, bool cancelable, struct dom_abstract_view *view,
		int32_t detail, int32_t screen_x, int32_t screen_y, int32_t client_x,
		int32_t client_y, bool ctrl, bool alt, bool shift, bool meta, 
		unsigned short button, dom_event_target *et)
{
	evt->sx = screen_x;
	evt->sy = screen_y;
	evt->cx = client_x;
	evt->cy = client_y;

	evt->modifier_state = 0;
	if (ctrl == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_CTRL;
	}
	if (alt == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_ALT;
	}
	if (shift == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_SHIFT;
	}
	if (meta == true) {
		evt->modifier_state = evt->modifier_state | DOM_MOD_META;
	}
	
	evt->button = button;
	evt->related_target = et;

	return _dom_ui_event_init_ns(&evt->base, namespace, type, bubble,
			cancelable, view, detail);
}

