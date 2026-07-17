#ifndef MGP_NATIVE_SDL_H
#define MGP_NATIVE_SDL_H

/* Small SDL3 declaration surface used by sdlx.c.  SDL's public ABI keeps
 * SDL_Surface and event structures visible; keeping this local avoids making
 * the native oracle depend on an SDK/header installation. */
#include <stdbool.h>
#include <stdint.h>

typedef uint8_t Uint8;
typedef uint16_t Uint16;
typedef uint32_t Uint32;
typedef uint64_t Uint64;
typedef int32_t Sint32;
typedef Uint32 SDL_WindowID;
typedef Uint32 SDL_KeyboardID;
typedef Uint32 SDL_MouseID;
typedef Uint32 SDL_Scancode;
typedef Uint32 SDL_Keycode;
typedef Uint16 SDL_Keymod;
typedef Uint32 SDL_InitFlags;
typedef Uint64 SDL_WindowFlags;

typedef struct SDL_Window SDL_Window;
typedef struct SDL_Surface {
	Uint32 flags;
	Uint32 format;
	int w, h;
	int pitch;
	void *pixels;
	int refcount;
	void *reserved;
} SDL_Surface;

typedef struct SDL_CommonEvent {
	Uint32 type, reserved;
	Uint64 timestamp;
} SDL_CommonEvent;
typedef struct SDL_KeyboardEvent {
	Uint32 type, reserved;
	Uint64 timestamp;
	SDL_WindowID windowID;
	SDL_KeyboardID which;
	SDL_Scancode scancode;
	SDL_Keycode key;
	SDL_Keymod mod;
	Uint16 raw;
	bool down, repeat;
} SDL_KeyboardEvent;
typedef struct SDL_MouseMotionEvent {
	Uint32 type, reserved;
	Uint64 timestamp;
	SDL_WindowID windowID;
	SDL_MouseID which;
	Uint32 state;
	float x, y, xrel, yrel;
} SDL_MouseMotionEvent;
typedef struct SDL_MouseButtonEvent {
	Uint32 type, reserved;
	Uint64 timestamp;
	SDL_WindowID windowID;
	SDL_MouseID which;
	Uint8 button;
	bool down;
	Uint8 clicks, padding;
	float x, y;
} SDL_MouseButtonEvent;
typedef struct SDL_WindowEvent {
	Uint32 type, reserved;
	Uint64 timestamp;
	SDL_WindowID windowID;
	Sint32 data1, data2;
} SDL_WindowEvent;
typedef union SDL_Event {
	Uint32 type;
	SDL_CommonEvent common;
	SDL_KeyboardEvent key;
	SDL_MouseMotionEvent motion;
	SDL_MouseButtonEvent button;
	SDL_WindowEvent window;
	Uint8 padding[128];
} SDL_Event;

#define SDL_INIT_VIDEO 0x00000020u
#define SDL_WINDOW_RESIZABLE 0x0000000000000020ULL
#define SDL_EVENT_QUIT 0x100
#define SDL_EVENT_WINDOW_EXPOSED 0x204
#define SDL_EVENT_WINDOW_RESIZED 0x206
#define SDL_EVENT_WINDOW_CLOSE_REQUESTED 0x210
#define SDL_EVENT_KEY_DOWN 0x300
#define SDL_EVENT_KEY_UP 0x301
#define SDL_EVENT_MOUSE_MOTION 0x400
#define SDL_EVENT_MOUSE_BUTTON_DOWN 0x401
#define SDL_EVENT_MOUSE_BUTTON_UP 0x402
#define SDLK_BACKSPACE 8
#define SDLK_TAB 9
#define SDLK_RETURN 13
#define SDLK_ESCAPE 27
#define SDLK_DELETE 127
#define SDLK_HOME 1073741898
#define SDLK_PAGEUP 1073741899
#define SDLK_PAGEDOWN 1073741902
#define SDLK_RIGHT 1073741903
#define SDLK_LEFT 1073741904
#define SDLK_DOWN 1073741905
#define SDLK_UP 1073741906
#define SDLK_LCTRL 1073742048
#define SDLK_LSHIFT 1073742049
#define SDLK_RCTRL 1073742052
#define SDLK_RSHIFT 1073742053

bool SDL_Init(SDL_InitFlags flags);
SDL_Window *SDL_CreateWindow(const char *, int, int, SDL_WindowFlags);
SDL_Surface *SDL_GetWindowSurface(SDL_Window *);
bool SDL_UpdateWindowSurface(SDL_Window *);
bool SDL_SetWindowTitle(SDL_Window *, const char *);
bool SDL_PollEvent(SDL_Event *);
bool SDL_WaitEventTimeout(SDL_Event *, Sint32);
void SDL_DestroyWindow(SDL_Window *);
void SDL_Quit(void);
void SDL_Delay(Uint32);

#endif
