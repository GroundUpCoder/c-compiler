/*
 * in_sdl.c — SDL-based input driver for the C-to-WASM Quake port.
 *
 * Written from scratch for this port (not imported from upstream).
 * Replaces upstream's in_null.c / in_win.c / in_x.c.
 *
 * SDL events arrive from the host (browser keydown/keyup, mouse, etc.)
 * via the host-side push functions (__sdl_push_key_event etc.), which
 * deposit them in the C-side event queue. Each frame Sys_SendKeyEvents
 * drains the queue and calls Quake's Key_Event with the translated
 * Quake key codes. Mouse motion is accumulated into deltas that IN_Move
 * folds into the usercmd_t for the current frame.
 */
#include "quakedef.h"

#include <SDL.h>

// Accumulated mouse delta since last IN_Move call. SDL motion events
// already provide xrel/yrel (relative-motion mode); the host emits
// those when pointer-lock or relative motion is active.
static int   mouse_dx;
static int   mouse_dy;
static int   mouse_buttons;   // bitmask of pressed buttons

// Mouse/sensitivity cvars are defined and registered in cl_main.c.
// IN_Move reads them via these externs.
extern cvar_t  sensitivity;
extern cvar_t  m_pitch;
extern cvar_t  m_yaw;
extern cvar_t  m_forward;
extern cvar_t  m_side;

void IN_Init (void) {}

void IN_Shutdown (void) {}

void IN_Commands (void)
{
	// Mouse button states (left=1, right=2, middle=4 in our bitmask)
	// are turned into Key_Event calls so console binds work. Only edge
	// transitions are reported — we track the previous state ourselves.
	static int old_buttons;
	int        i;
	for (i = 0; i < 3; i++)
	{
		int mask = 1 << i;
		int now  = (mouse_buttons & mask) != 0;
		int was  = (old_buttons   & mask) != 0;
		if (now != was)
			Key_Event (K_MOUSE1 + i, now);
	}
	old_buttons = mouse_buttons;
}

void IN_Move (usercmd_t *cmd)
{
	float mx = mouse_dx * sensitivity.value;
	float my = mouse_dy * sensitivity.value;

	// Consume the accumulated delta now that we've folded it in.
	mouse_dx = 0;
	mouse_dy = 0;

	// in_strafe means "left mouse moves strafes instead of turning"
	if ((in_strafe.state & 1) || (lookstrafe.value && (in_mlook.state & 1)))
		cmd->sidemove += m_side.value * mx;
	else
		cl.viewangles[YAW] -= m_yaw.value * mx;

	if (in_mlook.state & 1)
		V_StopPitchDrift ();

	if ((in_mlook.state & 1) && !(in_strafe.state & 1))
	{
		cl.viewangles[PITCH] += m_pitch.value * my;
		if (cl.viewangles[PITCH] > 80)  cl.viewangles[PITCH] = 80;
		if (cl.viewangles[PITCH] < -70) cl.viewangles[PITCH] = -70;
	}
	else
	{
		if ((in_strafe.state & 1) && noclip_anglehack)
			cmd->upmove -= m_forward.value * my;
		else
			cmd->forwardmove -= m_forward.value * my;
	}
}

/*
 * SDL keysym → Quake K_* translation. Quake's key codes are mostly
 * ASCII for printable keys; the named keys (arrows, F1–F12, etc.) are
 * non-ASCII values in the 128–255 range. See keys.h. SDLK values
 * above 0x40000000 are scancode-based "named" keys in SDL2.
 */
static int sdlk_to_quakekey (int sym)
{
	switch (sym)
	{
		case SDLK_TAB:        return K_TAB;
		case SDLK_RETURN:     return K_ENTER;
		case SDLK_ESCAPE:     return K_ESCAPE;
		case SDLK_SPACE:      return K_SPACE;
		case SDLK_BACKSPACE:  return K_BACKSPACE;

		case SDLK_UP:         return K_UPARROW;
		case SDLK_DOWN:       return K_DOWNARROW;
		case SDLK_LEFT:       return K_LEFTARROW;
		case SDLK_RIGHT:      return K_RIGHTARROW;

		case SDLK_LALT:
		case SDLK_RALT:       return K_ALT;
		case SDLK_LCTRL:
		case SDLK_RCTRL:      return K_CTRL;
		case SDLK_LSHIFT:
		case SDLK_RSHIFT:     return K_SHIFT;

		case SDLK_F1:  return K_F1;
		case SDLK_F2:  return K_F2;
		case SDLK_F3:  return K_F3;
		case SDLK_F4:  return K_F4;
		case SDLK_F5:  return K_F5;
		case SDLK_F6:  return K_F6;
		case SDLK_F7:  return K_F7;
		case SDLK_F8:  return K_F8;
		case SDLK_F9:  return K_F9;
		case SDLK_F10: return K_F10;
		case SDLK_F11: return K_F11;
		case SDLK_F12: return K_F12;

		case SDLK_INSERT:     return K_INS;
		case SDLK_DELETE:     return K_DEL;
		case SDLK_PAGEDOWN:   return K_PGDN;
		case SDLK_PAGEUP:     return K_PGUP;
		case SDLK_HOME:       return K_HOME;
		case SDLK_END:        return K_END;
		case SDLK_PAUSE:      return K_PAUSE;
	}
	// Printable ASCII — Quake uses lowercase for letter keys.
	if (sym >= 32 && sym < 127) return sym;
	return 0; // unknown — drop on the floor
}

/*
 * Called once per frame from screen.c / host_cmd.c (via the Quake
 * core), and explicitly from main loop entry on some platforms. We
 * drain all queued SDL events, translate them, and call the right
 * Quake handlers.
 */
void Sys_SendKeyEvents (void)
{
	SDL_Event ev;
	while (SDL_PollEvent (&ev))
	{
		switch (ev.type)
		{
		case SDL_QUIT:
			Sys_Quit ();
			break;

		case SDL_KEYDOWN:
		case SDL_KEYUP:
		{
			int qk = sdlk_to_quakekey (ev.key.keysym.sym);
			if (qk)
				Key_Event (qk, ev.type == SDL_KEYDOWN);
			break;
		}

		case SDL_MOUSEMOTION:
			mouse_dx += ev.motion.xrel;
			mouse_dy += ev.motion.yrel;
			break;

		case SDL_MOUSEBUTTONDOWN:
		case SDL_MOUSEBUTTONUP:
		{
			int idx = ev.button.button - SDL_BUTTON_LEFT;
			if (idx >= 0 && idx < 3)
			{
				if (ev.type == SDL_MOUSEBUTTONDOWN)
					mouse_buttons |=  (1 << idx);
				else
					mouse_buttons &= ~(1 << idx);
			}
			break;
		}

		case SDL_MOUSEWHEEL:
			if (ev.wheel.y > 0) { Key_Event (K_MWHEELUP,   true);  Key_Event (K_MWHEELUP,   false); }
			if (ev.wheel.y < 0) { Key_Event (K_MWHEELDOWN, true);  Key_Event (K_MWHEELDOWN, false); }
			break;
		}
	}
}
