# gucOS SDL API index — every symbol the shipped `<SDL.h>` surface has

> GENERATED FILE — do not edit. `node tools/mksdlindex.js` (host repo)
> regenerates it from the compiler’s builtin SDL headers, and the host
> suite fails if it drifts. In-OS, this file describes exactly what
> `/usr/include/SDL.h` ships.

This platform is a documented SUBSET of SDL3, spelled like SDL3 (bool
returns, float mouse coords, flat key events, Uint64 ticks). Everything
listed below EXISTS today; the last section lists what notably does NOT.
Main-loop, audio-backlog and text RULES: `/usr/share/doc/sdl-gucos.md` —
read it before writing SDL code.

Includes: `#include <SDL.h>` (or `<SDL3/SDL.h>` — same header).
`#define SDL_MAIN_USE_CALLBACKS` before the include opts into the
callback main loop. Optional subsidiary headers: `<SDL_popup.h>`,
`<SDL3_image/SDL_image.h>`, `<SDL3_ttf/SDL_ttf.h>`, `<sdl3webgpu.h>`
(each pulls its own implementation; sections below).

## Functions

### Init & lifecycle

```c
bool SDL_Init(SDL_InitFlags flags);
bool SDL_InitSubSystem(SDL_InitFlags flags);
void SDL_QuitSubSystem(SDL_InitFlags flags);
SDL_InitFlags SDL_WasInit(SDL_InitFlags flags);
void SDL_Quit(void);
```

### Main loop (callback model — #define SDL_MAIN_USE_CALLBACKS, no main())

THE sanctioned loop for GPU-presenting apps: SDL_AppIterate runs once per composited frame (~60 Hz). A blocking loop that presents GPU frames is killed at its second present (exit 69) — see sdl-gucos.md. __setAnimationFrameFunc is the low-level frame seam the callback model rides.

```c
void __setAnimationFrameFunc(void (*callback)(void));
SDL_AppResult SDL_AppInit(void **appstate, int argc, char *argv[]);
SDL_AppResult SDL_AppIterate(void *appstate);
SDL_AppResult SDL_AppEvent(void *appstate, SDL_Event *event);
void SDL_AppQuit(void *appstate, SDL_AppResult result);
```

### Events

event.key.key is the MODIFIER-APPLIED ASCII char for printable keys (compare 'r', 'R', '3'); physical keys are event.key.scancode (SDL_SCANCODE_*). SDLK_* constants exist only for special keys — see the constants section.

```c
bool SDL_PollEvent(SDL_Event *event);
bool SDL_WaitEvent(SDL_Event *event);
bool SDL_WaitEventTimeout(SDL_Event *event, Sint32 timeoutMS);
void SDL_PumpEvents(void);
bool SDL_PushEvent(SDL_Event *event);
Uint32 SDL_RegisterEvents(int numevents);
bool SDL_HasEvent(Uint32 type);
bool SDL_HasEvents(Uint32 minType, Uint32 maxType);
void SDL_FlushEvent(Uint32 type);
void SDL_FlushEvents(Uint32 minType, Uint32 maxType);
int SDL_PeepEvents(SDL_Event *events, int numevents, SDL_EventAction action, Uint32 minType, Uint32 maxType);
```

### Input state (keyboard / mouse snapshots)

Snapshots advance as events are pumped. SDL_GetGlobalMouseState ALWAYS fails by design (0 mask + SDL error): a process only sees pointer events routed to its own windows.

```c
const bool *SDL_GetKeyboardState(int *numkeys);
SDL_Keymod SDL_GetModState(void);
SDL_MouseButtonFlags SDL_GetMouseState(float *x, float *y);
SDL_MouseButtonFlags SDL_GetGlobalMouseState(float *x, float *y);
bool SDL_SetWindowRelativeMouseMode(SDL_Window *window, bool enabled);
bool SDL_GetWindowRelativeMouseMode(SDL_Window *window);
```

### Window & window surface

SDL_SetWindowPosition and SDL_SetWindowIcon are honest accept-and-succeed no-ops — the WM owns placement; no taskbar-icon pipe yet.

```c
SDL_Window *SDL_CreateWindow(const char *title, int w, int h, SDL_WindowFlags flags);
SDL_WindowID SDL_GetWindowID(SDL_Window *window);
SDL_Surface *SDL_GetWindowSurface(SDL_Window *window);
bool SDL_UpdateWindowSurface(SDL_Window *window);
bool SDL_GetWindowSize(SDL_Window *window, int *w, int *h);
bool SDL_SetWindowSize(SDL_Window *window, int w, int h);
SDL_WindowFlags SDL_GetWindowFlags(SDL_Window *window);
bool SDL_SetWindowPosition(SDL_Window *window, int x, int y);
bool SDL_SetWindowIcon(SDL_Window *window, SDL_Surface *icon);
void SDL_DestroySurface(SDL_Surface *surface);
void SDL_DestroyWindow(SDL_Window *window);
bool SDL_SetWindowTitle(SDL_Window *window, const char *title);
```

### Renderer & textures (2D accelerated)

SDL_CreateRenderer(win, NULL) = the GPU tier (requires the callback main loop). "software" (or SDL_RENDER_DRIVER=software) = CPU into the window surface, blocking loops legal. Any other driver name fails.

```c
SDL_Renderer *SDL_CreateRenderer(SDL_Window *window, const char *name);
void SDL_DestroyRenderer(SDL_Renderer *renderer);
SDL_Texture *SDL_CreateTexture(SDL_Renderer *renderer, SDL_PixelFormat format, SDL_TextureAccess access, int w, int h);
SDL_Texture *SDL_CreateTextureFromSurface(SDL_Renderer *renderer, SDL_Surface *surface);
void SDL_DestroyTexture(SDL_Texture *texture);
bool SDL_UpdateTexture(SDL_Texture *texture, const SDL_Rect *rect, const void *pixels, int pitch);
bool SDL_SetTextureColorMod(SDL_Texture *texture, Uint8 r, Uint8 g, Uint8 b);
bool SDL_SetTextureAlphaMod(SDL_Texture *texture, Uint8 alpha);
bool SDL_SetTextureBlendMode(SDL_Texture *texture, SDL_BlendMode blendMode);
bool SDL_GetTextureBlendMode(SDL_Texture *texture, SDL_BlendMode *blendMode);
bool SDL_SetTextureScaleMode(SDL_Texture *texture, SDL_ScaleMode scaleMode);
bool SDL_GetTextureScaleMode(SDL_Texture *texture, SDL_ScaleMode *scaleMode);
bool SDL_SetRenderDrawColor(SDL_Renderer *renderer, Uint8 r, Uint8 g, Uint8 b, Uint8 a);
bool SDL_GetRenderDrawColor(SDL_Renderer *renderer, Uint8 *r, Uint8 *g, Uint8 *b, Uint8 *a);
bool SDL_SetRenderDrawBlendMode(SDL_Renderer *renderer, SDL_BlendMode blendMode);
bool SDL_RenderClear(SDL_Renderer *renderer);
bool SDL_RenderTexture(SDL_Renderer *renderer, SDL_Texture *texture, const SDL_FRect *srcrect, const SDL_FRect *dstrect);
bool SDL_RenderTextureRotated(SDL_Renderer *renderer, SDL_Texture *texture, const SDL_FRect *srcrect, const SDL_FRect *dstrect, double angle, const SDL_FPoint *center, SDL_FlipMode flip);
bool SDL_RenderFillRect(SDL_Renderer *renderer, const SDL_FRect *rect);
bool SDL_RenderRect(SDL_Renderer *renderer, const SDL_FRect *rect);
bool SDL_RenderLine(SDL_Renderer *renderer, float x1, float y1, float x2, float y2);
bool SDL_RenderPoint(SDL_Renderer *renderer, float x, float y);
bool SDL_RenderFillRects(SDL_Renderer *renderer, const SDL_FRect *rects, int count);
bool SDL_RenderRects(SDL_Renderer *renderer, const SDL_FRect *rects, int count);
bool SDL_RenderLines(SDL_Renderer *renderer, const SDL_FPoint *points, int count);
bool SDL_RenderPoints(SDL_Renderer *renderer, const SDL_FPoint *points, int count);
bool SDL_RenderGeometry(SDL_Renderer *renderer, SDL_Texture *texture, const SDL_Vertex *vertices, int num_vertices, const int *indices, int num_indices);
void SDL_RenderPresent(SDL_Renderer *renderer);
```

### Timing

SDL_GetPerformanceFrequency() == 1000000000 (ns units). SDL_Delay waits AT LEAST the asked time.

```c
void SDL_Delay(Uint32 ms);
Uint64 SDL_GetTicks(void);
Uint64 SDL_GetTicksNS(void);
Uint64 SDL_GetPerformanceCounter(void);
Uint64 SDL_GetPerformanceFrequency(void);
```

### Audio (push model)

Push PCM with SDL_PutAudioStreamData. On a HEADLESS boot the queue never drains — top up only while SDL_GetAudioStreamQueued is below a cap, never wait for drain (sdl-gucos.md).

```c
SDL_AudioStream *SDL_OpenAudioDeviceStream(SDL_AudioDeviceID devid, const SDL_AudioSpec *spec, SDL_AudioStreamCallback callback, void *userdata);
bool SDL_PutAudioStreamData(SDL_AudioStream *stream, const void *buf, int len);
int SDL_GetAudioStreamQueued(SDL_AudioStream *stream);
bool SDL_ClearAudioStream(SDL_AudioStream *stream);
bool SDL_ResumeAudioStreamDevice(SDL_AudioStream *stream);
bool SDL_PauseAudioStreamDevice(SDL_AudioStream *stream);
void SDL_DestroyAudioStream(SDL_AudioStream *stream);
```

### Clipboard

Text only; one system-wide slot. SDL_GetClipboardText never returns NULL ("" when empty); free the result with SDL_free.

```c
bool SDL_SetClipboardText(const char *text);
char *SDL_GetClipboardText(void);
bool SDL_HasClipboardText(void);
bool SDL_ClearClipboardData(void);
```

### Cursors (system shapes only)

```c
SDL_Cursor *SDL_CreateSystemCursor(SDL_SystemCursor id);
bool SDL_SetCursor(SDL_Cursor *cursor);
SDL_Cursor *SDL_GetCursor(void);
SDL_Cursor *SDL_GetDefaultCursor(void);
void SDL_DestroyCursor(SDL_Cursor *cursor);
bool SDL_ShowCursor(void);
bool SDL_HideCursor(void);
bool SDL_CursorVisible(void);
```

### Error handling

```c
const char *SDL_GetError(void);
bool SDL_SetError(const char *fmt, ...);
bool SDL_ClearError(void);
```

### Hints

```c
bool SDL_SetHint(const char *name, const char *value);
const char *SDL_GetHint(const char *name);
```

### Filesystem paths

SDL_GetBasePath is cached/SDL-owned (do not free); SDL_GetPrefPath ($HOME/.local/share/<org>/<app>/) is caller-freed with SDL_free.

```c
const char *SDL_GetBasePath(void);
char *SDL_GetPrefPath(const char *org, const char *app);
```

### Memory, random, log

SDL and libc pointers are interchangeable here (one heap). SDL_rand(n) is upstream’s exact generator, uniform over [0, n).

```c
void SDL_free(void *mem);
void *SDL_malloc(size_t size);
void *SDL_calloc(size_t nmemb, size_t size);
void *SDL_realloc(void *mem, size_t size);
void SDL_srand(Uint64 seed);
Sint32 SDL_rand(Sint32 n);
Uint32 SDL_rand_bits(void);
float SDL_randf(void);
void SDL_Log(const char *fmt, ...);
```

### Popup windows — `#include <SDL_popup.h>`

Anchored borderless child windows (menus/tooltips). Flags must include SDL_WINDOW_POPUP_MENU (holds the grab; outside press dismisses via SDL_EVENT_WINDOW_CLOSE_REQUESTED) or SDL_WINDOW_TOOLTIP (no grab).

```c
SDL_Window *SDL_CreatePopupWindow(SDL_Window *parent, int offset_x, int offset_y, int w, int h, SDL_WindowFlags flags);
bool SDL_GetDisplayBounds(Uint32 displayID, SDL_Rect *rect);
```

### Image loading (SDL_image) — `#include <SDL3_image/SDL_image.h>`

PNG is the only decoder shipped (libpng). IMG_Load returns a heap SDL_Surface (free with SDL_DestroySurface); on a minimal boot `gucman install libpng` first.

```c
SDL_Surface *IMG_Load(const char *file);
SDL_Texture *IMG_LoadTexture(SDL_Renderer *renderer, const char *file);
const char *IMG_GetError(void);
```

### Text rendering (SDL_ttf, classic API) — `#include <SDL3_ttf/SDL_ttf.h>`

The classic render-to-surface half of SDL3_ttf over FreeType (on a minimal boot `gucman install freetype` first). Renderers return RGBA32 heap surfaces (free with SDL_DestroySurface; no palettized surfaces here) — render once and cache the texture. `length` params are bytes, 0 = null-terminated UTF-8. The modern TTF_Text/TTF_TextEngine API, the LCD renderers, TTF_OpenFontIO and TTF_SetFontOutline are absent. Fonts: /usr/share/fonts/{mono,sans,serif}.ttf + bold/italic variants.

```c
bool TTF_Init(void);
void TTF_Quit(void);
int TTF_WasInit(void);
TTF_Font *TTF_OpenFont(const char *file, float ptsize);
void TTF_CloseFont(TTF_Font *font);
bool TTF_SetFontSize(TTF_Font *font, float ptsize);
bool TTF_SetFontSizeDPI(TTF_Font *font, float ptsize, int hdpi, int vdpi);
float TTF_GetFontSize(TTF_Font *font);
bool TTF_GetFontDPI(TTF_Font *font, int *hdpi, int *vdpi);
void TTF_SetFontStyle(TTF_Font *font, TTF_FontStyleFlags style);
TTF_FontStyleFlags TTF_GetFontStyle(const TTF_Font *font);
void TTF_SetFontHinting(TTF_Font *font, TTF_HintingFlags hinting);
TTF_HintingFlags TTF_GetFontHinting(const TTF_Font *font);
void TTF_SetFontKerning(TTF_Font *font, bool enabled);
bool TTF_GetFontKerning(const TTF_Font *font);
int TTF_GetFontHeight(const TTF_Font *font);
int TTF_GetFontAscent(const TTF_Font *font);
int TTF_GetFontDescent(const TTF_Font *font);
int TTF_GetFontLineSkip(const TTF_Font *font);
void TTF_SetFontLineSkip(TTF_Font *font, int lineskip);
bool TTF_FontIsFixedWidth(const TTF_Font *font);
const char *TTF_GetFontFamilyName(const TTF_Font *font);
const char *TTF_GetFontStyleName(const TTF_Font *font);
bool TTF_FontHasGlyph(TTF_Font *font, Uint32 ch);
bool TTF_GetGlyphMetrics(TTF_Font *font, Uint32 ch, int *minx, int *maxx, int *miny, int *maxy, int *advance);
bool TTF_GetGlyphKerning(TTF_Font *font, Uint32 previous_ch, Uint32 ch, int *kerning);
bool TTF_GetStringSize(TTF_Font *font, const char *text, size_t length, int *w, int *h);
bool TTF_GetStringSizeWrapped(TTF_Font *font, const char *text, size_t length, int wrap_width, int *w, int *h);
bool TTF_MeasureString(TTF_Font *font, const char *text, size_t length, int max_width, int *measured_width, size_t *measured_length);
SDL_Surface *TTF_RenderText_Solid(TTF_Font *font, const char *text, size_t length, SDL_Color fg);
SDL_Surface *TTF_RenderText_Solid_Wrapped(TTF_Font *font, const char *text, size_t length, SDL_Color fg, int wrapLength);
SDL_Surface *TTF_RenderText_Shaded(TTF_Font *font, const char *text, size_t length, SDL_Color fg, SDL_Color bg);
SDL_Surface *TTF_RenderText_Shaded_Wrapped(TTF_Font *font, const char *text, size_t length, SDL_Color fg, SDL_Color bg, int wrap_width);
SDL_Surface *TTF_RenderText_Blended(TTF_Font *font, const char *text, size_t length, SDL_Color fg);
SDL_Surface *TTF_RenderText_Blended_Wrapped(TTF_Font *font, const char *text, size_t length, SDL_Color fg, int wrap_width);
SDL_Surface *TTF_RenderGlyph_Solid(TTF_Font *font, Uint32 ch, SDL_Color fg);
SDL_Surface *TTF_RenderGlyph_Shaded(TTF_Font *font, Uint32 ch, SDL_Color fg, SDL_Color bg);
SDL_Surface *TTF_RenderGlyph_Blended(TTF_Font *font, Uint32 ch, SDL_Color fg);
const char *TTF_GetError(void);
```

```
TTF_STYLE_NORMAL 0x00
TTF_STYLE_BOLD 0x01
TTF_STYLE_ITALIC 0x02
TTF_STYLE_UNDERLINE 0x04
TTF_STYLE_STRIKETHROUGH 0x08
```

### WebGPU bridge — `#include <sdl3webgpu.h>`

Raw GPU access for an SDL window (with <webgpu.h>). A window uses EITHER SDL_UpdateWindowSurface/SDL_Renderer OR WebGPU, never both.

```c
WGPUSurface SDL_GetWGPUSurface(WGPUInstance instance, SDL_Window *window);
```

## Types

```c
typedef _Bool bool;
typedef unsigned long long Uint64;
typedef unsigned int Uint32;
typedef unsigned short Uint16;
typedef unsigned char Uint8;
typedef int Sint32;
typedef Uint32 SDL_WindowID;
typedef Uint32 SDL_KeyboardID;
typedef Uint32 SDL_MouseID;
typedef Uint32 SDL_Scancode;
typedef Uint32 SDL_Keycode;
typedef Uint16 SDL_Keymod;
typedef Uint32 SDL_PixelFormat;
typedef Uint32 SDL_SurfaceFlags;
typedef struct SDL_Surface { SDL_SurfaceFlags flags; SDL_PixelFormat format; int w, h; int pitch; void *pixels; int refcount; void *reserved; } SDL_Surface;
typedef struct SDL_Window SDL_Window;   /* opaque */
typedef struct SDL_Rect { int x, y, w, h; } SDL_Rect;
typedef struct SDL_FRect { float x, y, w, h; } SDL_FRect;
typedef struct SDL_FPoint { float x, y; } SDL_FPoint;
typedef struct SDL_FColor { float r, g, b, a; } SDL_FColor;
typedef struct SDL_Color { Uint8 r, g, b, a; } SDL_Color;
typedef struct SDL_Vertex { SDL_FPoint position; SDL_FColor color; SDL_FPoint tex_coord; } SDL_Vertex;
typedef struct SDL_Renderer SDL_Renderer;   /* opaque */
typedef struct SDL_Texture { SDL_PixelFormat format; int w; int h; int __handle; Uint32 __magic; } SDL_Texture;
typedef struct SDL_CommonEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; } SDL_CommonEvent;
typedef struct SDL_KeyboardEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; SDL_WindowID windowID; SDL_KeyboardID which; SDL_Scancode scancode; SDL_Keycode key; SDL_Keymod mod; Uint16 raw; bool down; bool repeat; } SDL_KeyboardEvent;
typedef struct SDL_MouseMotionEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; SDL_WindowID windowID; SDL_MouseID which; Uint32 state; float x; float y; float xrel; float yrel; } SDL_MouseMotionEvent;
typedef struct SDL_MouseButtonEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; SDL_WindowID windowID; SDL_MouseID which; Uint8 button; bool down; Uint8 clicks; Uint8 padding; float x; float y; } SDL_MouseButtonEvent;
typedef struct SDL_MouseWheelEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; SDL_WindowID windowID; SDL_MouseID which; float x; float y; Uint32 direction; float mouse_x; float mouse_y; } SDL_MouseWheelEvent;
typedef struct SDL_WindowEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; SDL_WindowID windowID; Sint32 data1; Sint32 data2; } SDL_WindowEvent;
typedef struct SDL_UserEvent { Uint32 type; Uint32 reserved; Uint64 timestamp; SDL_WindowID windowID; Sint32 code; void *data1; void *data2; } SDL_UserEvent;
typedef union SDL_Event { Uint32 type; SDL_CommonEvent common; SDL_KeyboardEvent key; SDL_MouseMotionEvent motion; SDL_MouseButtonEvent button; SDL_MouseWheelEvent wheel; SDL_WindowEvent window; SDL_UserEvent user; Uint8 padding[128]; } SDL_Event;
typedef Uint32 SDL_InitFlags;
typedef Uint64 SDL_WindowFlags;
typedef Uint32 SDL_MouseButtonFlags;
typedef int SDL_AudioFormat;
typedef Uint32 SDL_AudioDeviceID;
typedef struct SDL_AudioSpec { SDL_AudioFormat format; int channels; int freq; } SDL_AudioSpec;
typedef struct SDL_AudioStream SDL_AudioStream;   /* opaque */
typedef void (*SDL_AudioStreamCallback)(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount);
typedef struct SDL_Cursor SDL_Cursor;   /* opaque */
typedef struct TTF_Font TTF_Font;   /* opaque */
typedef Uint32 TTF_FontStyleFlags;
```

Enums:

```c
typedef enum SDL_TextureAccess { SDL_TEXTUREACCESS_STATIC = 0, SDL_TEXTUREACCESS_STREAMING = 1, SDL_TEXTUREACCESS_TARGET = 2 } SDL_TextureAccess;
typedef enum SDL_BlendMode { SDL_BLENDMODE_NONE = 0, SDL_BLENDMODE_BLEND = 1, SDL_BLENDMODE_ADD = 2, SDL_BLENDMODE_MOD = 4 } SDL_BlendMode;
typedef enum SDL_ScaleMode { SDL_SCALEMODE_NEAREST = 0, SDL_SCALEMODE_LINEAR = 1 } SDL_ScaleMode;
typedef enum SDL_FlipMode { SDL_FLIP_NONE = 0, SDL_FLIP_HORIZONTAL = 1, SDL_FLIP_VERTICAL = 2 } SDL_FlipMode;
typedef enum SDL_EventAction { SDL_ADDEVENT, SDL_PEEKEVENT, SDL_GETEVENT } SDL_EventAction;
typedef enum SDL_SystemCursor { SDL_SYSTEM_CURSOR_DEFAULT, SDL_SYSTEM_CURSOR_TEXT, SDL_SYSTEM_CURSOR_WAIT, SDL_SYSTEM_CURSOR_CROSSHAIR, SDL_SYSTEM_CURSOR_PROGRESS, SDL_SYSTEM_CURSOR_NWSE_RESIZE, SDL_SYSTEM_CURSOR_NESW_RESIZE, SDL_SYSTEM_CURSOR_EW_RESIZE, SDL_SYSTEM_CURSOR_NS_RESIZE, SDL_SYSTEM_CURSOR_MOVE, SDL_SYSTEM_CURSOR_NOT_ALLOWED, SDL_SYSTEM_CURSOR_POINTER, SDL_SYSTEM_CURSOR_NW_RESIZE, SDL_SYSTEM_CURSOR_N_RESIZE, SDL_SYSTEM_CURSOR_NE_RESIZE, SDL_SYSTEM_CURSOR_E_RESIZE, SDL_SYSTEM_CURSOR_SE_RESIZE, SDL_SYSTEM_CURSOR_S_RESIZE, SDL_SYSTEM_CURSOR_SW_RESIZE, SDL_SYSTEM_CURSOR_W_RESIZE, SDL_SYSTEM_CURSOR_COUNT } SDL_SystemCursor;
typedef enum SDL_AppResult { SDL_APP_CONTINUE, SDL_APP_SUCCESS, SDL_APP_FAILURE } SDL_AppResult;
typedef enum TTF_HintingFlags { TTF_HINTING_INVALID = -1, TTF_HINTING_NORMAL = 0, TTF_HINTING_LIGHT = 1, TTF_HINTING_MONO = 2, TTF_HINTING_NONE = 3 } TTF_HintingFlags;
```

## Constants

### SDL_INIT_* — SDL_Init subsystem flags

```
SDL_INIT_AUDIO=0x00000010u  SDL_INIT_VIDEO=0x00000020u  SDL_INIT_JOYSTICK=0x00000200u
SDL_INIT_HAPTIC=0x00001000u  SDL_INIT_GAMEPAD=0x00002000u  SDL_INIT_EVENTS=0x00004000u
SDL_INIT_SENSOR=0x00008000u  SDL_INIT_CAMERA=0x00010000u
```

### SDL_WINDOWPOS_*

```
SDL_WINDOWPOS_CENTERED=0x2FFF0000  SDL_WINDOWPOS_UNDEFINED=0x1FFF0000
```

### SDL_WINDOW_* — window create flags

```
SDL_WINDOW_FULLSCREEN=0x0000000000000001ULL  SDL_WINDOW_BORDERLESS=0x0000000000000010ULL
SDL_WINDOW_RESIZABLE=0x0000000000000020ULL  SDL_WINDOW_TRANSPARENT=0x0000000040000000ULL
SDL_WINDOW_UTILITY=0x0000000000020000ULL  SDL_WINDOW_TOOLTIP=0x0000000000040000ULL
SDL_WINDOW_POPUP_MENU=0x0000000000080000ULL
```

### SDL_EVENT_* — event types (event.type)

```
SDL_EVENT_QUIT=0x100  SDL_EVENT_WINDOW_SHOWN=0x202  SDL_EVENT_WINDOW_HIDDEN=0x203
SDL_EVENT_WINDOW_EXPOSED=0x204  SDL_EVENT_WINDOW_MOVED=0x205
SDL_EVENT_WINDOW_RESIZED=0x206  SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED=0x207
SDL_EVENT_WINDOW_FOCUS_GAINED=0x20E  SDL_EVENT_WINDOW_FOCUS_LOST=0x20F
SDL_EVENT_WINDOW_CLOSE_REQUESTED=0x210  SDL_EVENT_KEY_DOWN=0x300  SDL_EVENT_KEY_UP=0x301
SDL_EVENT_MOUSE_MOTION=0x400  SDL_EVENT_MOUSE_BUTTON_DOWN=0x401
SDL_EVENT_MOUSE_BUTTON_UP=0x402  SDL_EVENT_MOUSE_WHEEL=0x403  SDL_EVENT_FIRST=0x0
SDL_EVENT_USER=0x8000  SDL_EVENT_LAST=0xFFFF
```

Of the WINDOW_* block only RESIZED, FOCUS_GAINED/LOST and CLOSE_REQUESTED are delivered today; the rest exist for source compatibility.

### SDLK_* — special-key keysyms (event.key.key): the COMPLETE list

```
SDLK_BACKSPACE=8  SDLK_TAB=9  SDLK_RETURN=13  SDLK_ESCAPE=27  SDLK_SPACE=32
SDLK_PLUS=43  SDLK_MINUS=45  SDLK_EQUALS=61  SDLK_DELETE=127  SDLK_CAPSLOCK=1073741881
SDLK_F1=1073741882  SDLK_F2=1073741883  SDLK_F3=1073741884  SDLK_F4=1073741885
SDLK_F5=1073741886  SDLK_F6=1073741887  SDLK_F7=1073741888  SDLK_F8=1073741889
SDLK_F9=1073741890  SDLK_F10=1073741891  SDLK_F11=1073741892  SDLK_F12=1073741893
SDLK_PRINTSCREEN=1073741894  SDLK_SCROLLLOCK=1073741895  SDLK_PAUSE=1073741896
SDLK_INSERT=1073741897  SDLK_HOME=1073741898  SDLK_PAGEUP=1073741899
SDLK_END=1073741901  SDLK_PAGEDOWN=1073741902  SDLK_RIGHT=1073741903
SDLK_LEFT=1073741904  SDLK_DOWN=1073741905  SDLK_UP=1073741906
SDLK_NUMLOCKCLEAR=1073741907  SDLK_LCTRL=1073742048  SDLK_LSHIFT=1073742049
SDLK_LALT=1073742050  SDLK_LGUI=1073742051  SDLK_RCTRL=1073742052
SDLK_RSHIFT=1073742053  SDLK_RALT=1073742054  SDLK_RGUI=1073742055
```

Only the names above exist. Letters, digits and punctuation have NO SDLK_ constants — event.key.key carries the modifier-applied ASCII char, so compare char literals ('a', 'R', '3'). There are no SDLK_KP_* keypad constants.

### SDL_KMOD_* — modifier flags (event.key.mod)

```
SDL_KMOD_CTRL = (SDL_KMOD_LCTRL | SDL_KMOD_RCTRL)
SDL_KMOD_SHIFT = (SDL_KMOD_LSHIFT | SDL_KMOD_RSHIFT)
SDL_KMOD_ALT = (SDL_KMOD_LALT | SDL_KMOD_RALT)
SDL_KMOD_GUI = (SDL_KMOD_LGUI | SDL_KMOD_RGUI)
SDL_KMOD_NONE=0x0000  SDL_KMOD_LSHIFT=0x0001  SDL_KMOD_RSHIFT=0x0002
SDL_KMOD_LCTRL=0x0040  SDL_KMOD_RCTRL=0x0080  SDL_KMOD_LALT=0x0100  SDL_KMOD_RALT=0x0200
SDL_KMOD_LGUI=0x0400  SDL_KMOD_RGUI=0x0800  SDL_KMOD_NUM=0x1000  SDL_KMOD_CAPS=0x2000
SDL_KMOD_MODE=0x4000  SDL_KMOD_SCROLL=0x8000
```

### SDL_SCANCODE_* — physical keys (event.key.scancode), full USB-HID table

```
SDL_SCANCODE_UNKNOWN=0  SDL_SCANCODE_A=4  SDL_SCANCODE_B=5  SDL_SCANCODE_C=6
SDL_SCANCODE_D=7  SDL_SCANCODE_E=8  SDL_SCANCODE_F=9  SDL_SCANCODE_G=10
SDL_SCANCODE_H=11  SDL_SCANCODE_I=12  SDL_SCANCODE_J=13  SDL_SCANCODE_K=14
SDL_SCANCODE_L=15  SDL_SCANCODE_M=16  SDL_SCANCODE_N=17  SDL_SCANCODE_O=18
SDL_SCANCODE_P=19  SDL_SCANCODE_Q=20  SDL_SCANCODE_R=21  SDL_SCANCODE_S=22
SDL_SCANCODE_T=23  SDL_SCANCODE_U=24  SDL_SCANCODE_V=25  SDL_SCANCODE_W=26
SDL_SCANCODE_X=27  SDL_SCANCODE_Y=28  SDL_SCANCODE_Z=29  SDL_SCANCODE_1=30
SDL_SCANCODE_2=31  SDL_SCANCODE_3=32  SDL_SCANCODE_4=33  SDL_SCANCODE_5=34
SDL_SCANCODE_6=35  SDL_SCANCODE_7=36  SDL_SCANCODE_8=37  SDL_SCANCODE_9=38
SDL_SCANCODE_0=39  SDL_SCANCODE_RETURN=40  SDL_SCANCODE_ESCAPE=41
SDL_SCANCODE_BACKSPACE=42  SDL_SCANCODE_TAB=43  SDL_SCANCODE_SPACE=44
SDL_SCANCODE_MINUS=45  SDL_SCANCODE_EQUALS=46  SDL_SCANCODE_LEFTBRACKET=47
SDL_SCANCODE_RIGHTBRACKET=48  SDL_SCANCODE_BACKSLASH=49  SDL_SCANCODE_NONUSHASH=50
SDL_SCANCODE_SEMICOLON=51  SDL_SCANCODE_APOSTROPHE=52  SDL_SCANCODE_GRAVE=53
SDL_SCANCODE_COMMA=54  SDL_SCANCODE_PERIOD=55  SDL_SCANCODE_SLASH=56
SDL_SCANCODE_CAPSLOCK=57  SDL_SCANCODE_F1=58  SDL_SCANCODE_F2=59  SDL_SCANCODE_F3=60
SDL_SCANCODE_F4=61  SDL_SCANCODE_F5=62  SDL_SCANCODE_F6=63  SDL_SCANCODE_F7=64
SDL_SCANCODE_F8=65  SDL_SCANCODE_F9=66  SDL_SCANCODE_F10=67  SDL_SCANCODE_F11=68
SDL_SCANCODE_F12=69  SDL_SCANCODE_PRINTSCREEN=70  SDL_SCANCODE_SCROLLLOCK=71
SDL_SCANCODE_PAUSE=72  SDL_SCANCODE_INSERT=73  SDL_SCANCODE_HOME=74
SDL_SCANCODE_PAGEUP=75  SDL_SCANCODE_DELETE=76  SDL_SCANCODE_END=77
SDL_SCANCODE_PAGEDOWN=78  SDL_SCANCODE_RIGHT=79  SDL_SCANCODE_LEFT=80
SDL_SCANCODE_DOWN=81  SDL_SCANCODE_UP=82  SDL_SCANCODE_NUMLOCKCLEAR=83
SDL_SCANCODE_KP_DIVIDE=84  SDL_SCANCODE_KP_MULTIPLY=85  SDL_SCANCODE_KP_MINUS=86
SDL_SCANCODE_KP_PLUS=87  SDL_SCANCODE_KP_ENTER=88  SDL_SCANCODE_KP_1=89
SDL_SCANCODE_KP_2=90  SDL_SCANCODE_KP_3=91  SDL_SCANCODE_KP_4=92  SDL_SCANCODE_KP_5=93
SDL_SCANCODE_KP_6=94  SDL_SCANCODE_KP_7=95  SDL_SCANCODE_KP_8=96  SDL_SCANCODE_KP_9=97
SDL_SCANCODE_KP_0=98  SDL_SCANCODE_KP_PERIOD=99  SDL_SCANCODE_NONUSBACKSLASH=100
SDL_SCANCODE_APPLICATION=101  SDL_SCANCODE_POWER=102  SDL_SCANCODE_KP_EQUALS=103
SDL_SCANCODE_F13=104  SDL_SCANCODE_F14=105  SDL_SCANCODE_F15=106  SDL_SCANCODE_F16=107
SDL_SCANCODE_F17=108  SDL_SCANCODE_F18=109  SDL_SCANCODE_F19=110  SDL_SCANCODE_F20=111
SDL_SCANCODE_F21=112  SDL_SCANCODE_F22=113  SDL_SCANCODE_F23=114  SDL_SCANCODE_F24=115
SDL_SCANCODE_EXECUTE=116  SDL_SCANCODE_HELP=117  SDL_SCANCODE_MENU=118
SDL_SCANCODE_SELECT=119  SDL_SCANCODE_STOP=120  SDL_SCANCODE_AGAIN=121
SDL_SCANCODE_UNDO=122  SDL_SCANCODE_CUT=123  SDL_SCANCODE_COPY=124
SDL_SCANCODE_PASTE=125  SDL_SCANCODE_FIND=126  SDL_SCANCODE_MUTE=127
SDL_SCANCODE_VOLUMEUP=128  SDL_SCANCODE_VOLUMEDOWN=129  SDL_SCANCODE_KP_COMMA=133
SDL_SCANCODE_KP_EQUALSAS400=134  SDL_SCANCODE_INTERNATIONAL1=135
SDL_SCANCODE_INTERNATIONAL2=136  SDL_SCANCODE_INTERNATIONAL3=137
SDL_SCANCODE_INTERNATIONAL4=138  SDL_SCANCODE_INTERNATIONAL5=139
SDL_SCANCODE_INTERNATIONAL6=140  SDL_SCANCODE_INTERNATIONAL7=141
SDL_SCANCODE_INTERNATIONAL8=142  SDL_SCANCODE_INTERNATIONAL9=143  SDL_SCANCODE_LANG1=144
SDL_SCANCODE_LANG2=145  SDL_SCANCODE_LANG3=146  SDL_SCANCODE_LANG4=147
SDL_SCANCODE_LANG5=148  SDL_SCANCODE_LANG6=149  SDL_SCANCODE_LANG7=150
SDL_SCANCODE_LANG8=151  SDL_SCANCODE_LANG9=152  SDL_SCANCODE_ALTERASE=153
SDL_SCANCODE_SYSREQ=154  SDL_SCANCODE_CANCEL=155  SDL_SCANCODE_CLEAR=156
SDL_SCANCODE_PRIOR=157  SDL_SCANCODE_RETURN2=158  SDL_SCANCODE_SEPARATOR=159
SDL_SCANCODE_OUT=160  SDL_SCANCODE_OPER=161  SDL_SCANCODE_CLEARAGAIN=162
SDL_SCANCODE_CRSEL=163  SDL_SCANCODE_EXSEL=164  SDL_SCANCODE_KP_00=176
SDL_SCANCODE_KP_000=177  SDL_SCANCODE_THOUSANDSSEPARATOR=178
SDL_SCANCODE_DECIMALSEPARATOR=179  SDL_SCANCODE_CURRENCYUNIT=180
SDL_SCANCODE_CURRENCYSUBUNIT=181  SDL_SCANCODE_KP_LEFTPAREN=182
SDL_SCANCODE_KP_RIGHTPAREN=183  SDL_SCANCODE_KP_LEFTBRACE=184
SDL_SCANCODE_KP_RIGHTBRACE=185  SDL_SCANCODE_KP_TAB=186  SDL_SCANCODE_KP_BACKSPACE=187
SDL_SCANCODE_KP_A=188  SDL_SCANCODE_KP_B=189  SDL_SCANCODE_KP_C=190
SDL_SCANCODE_KP_D=191  SDL_SCANCODE_KP_E=192  SDL_SCANCODE_KP_F=193
SDL_SCANCODE_KP_XOR=194  SDL_SCANCODE_KP_POWER=195  SDL_SCANCODE_KP_PERCENT=196
SDL_SCANCODE_KP_LESS=197  SDL_SCANCODE_KP_GREATER=198  SDL_SCANCODE_KP_AMPERSAND=199
SDL_SCANCODE_KP_DBLAMPERSAND=200  SDL_SCANCODE_KP_VERTICALBAR=201
SDL_SCANCODE_KP_DBLVERTICALBAR=202  SDL_SCANCODE_KP_COLON=203  SDL_SCANCODE_KP_HASH=204
SDL_SCANCODE_KP_SPACE=205  SDL_SCANCODE_KP_AT=206  SDL_SCANCODE_KP_EXCLAM=207
SDL_SCANCODE_KP_MEMSTORE=208  SDL_SCANCODE_KP_MEMRECALL=209
SDL_SCANCODE_KP_MEMCLEAR=210  SDL_SCANCODE_KP_MEMADD=211
SDL_SCANCODE_KP_MEMSUBTRACT=212  SDL_SCANCODE_KP_MEMMULTIPLY=213
SDL_SCANCODE_KP_MEMDIVIDE=214  SDL_SCANCODE_KP_PLUSMINUS=215  SDL_SCANCODE_KP_CLEAR=216
SDL_SCANCODE_KP_CLEARENTRY=217  SDL_SCANCODE_KP_BINARY=218  SDL_SCANCODE_KP_OCTAL=219
SDL_SCANCODE_KP_DECIMAL=220  SDL_SCANCODE_KP_HEXADECIMAL=221  SDL_SCANCODE_LCTRL=224
SDL_SCANCODE_LSHIFT=225  SDL_SCANCODE_LALT=226  SDL_SCANCODE_LGUI=227
SDL_SCANCODE_RCTRL=228  SDL_SCANCODE_RSHIFT=229  SDL_SCANCODE_RALT=230
SDL_SCANCODE_RGUI=231  SDL_SCANCODE_MODE=257  SDL_SCANCODE_COUNT=512
```

### Mouse buttons & wheel

```
SDL_BUTTON_MASK(X) (1u << ((X) - 1))
SDL_BUTTON_LEFT=1  SDL_BUTTON_MIDDLE=2  SDL_BUTTON_RIGHT=3  SDL_MOUSEWHEEL_NORMAL=0
SDL_MOUSEWHEEL_FLIPPED=1  SDL_BUTTON_LMASK=SDL_BUTTON_MASK(SDL_BUTTON_LEFT)
SDL_BUTTON_MMASK=SDL_BUTTON_MASK(SDL_BUTTON_MIDDLE)
SDL_BUTTON_RMASK=SDL_BUTTON_MASK(SDL_BUTTON_RIGHT)
```

### Audio formats & device

```
SDL_AUDIO_U8=0x0008  SDL_AUDIO_S8=0x8008  SDL_AUDIO_S16=0x8010  SDL_AUDIO_S32=0x8020
SDL_AUDIO_F32=0x8120  SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK=0xFFFFFFFFu
```

### Pixel formats & helpers

```
SDL_PIXELFLAG(X) (((X) >> 28) & 0x0F)
SDL_PIXELTYPE(X) (((X) >> 24) & 0x0F)
SDL_PIXELORDER(X) (((X) >> 20) & 0x0F)
SDL_ISPIXELFORMAT_FOURCC(format) ((format) && (SDL_PIXELFLAG(format) != 1))
SDL_ISPIXELFORMAT_PACKED(format) (!SDL_ISPIXELFORMAT_FOURCC(format) && ((SDL_PIXELTYPE(format) == SDL_PIXELTYPE_PACKED8) || (SDL_PIXELTYPE(format) == SDL_PIXELTYPE_PACKED16) || (SDL_PIXELTYPE(format) == SDL_PIXELTYPE_PACKED32)))
SDL_ISPIXELFORMAT_ALPHA(format) (SDL_ISPIXELFORMAT_PACKED(format) && ((SDL_PIXELORDER(format) == SDL_PACKEDORDER_ARGB) || (SDL_PIXELORDER(format) == SDL_PACKEDORDER_RGBA) || (SDL_PIXELORDER(format) == SDL_PACKEDORDER_ABGR) || (SDL_PIXELORDER(format) == SDL_PACKEDORDER_BGRA)))
SDL_PIXELFORMAT_RGBA8888=0x16462004u  SDL_PIXELFORMAT_ABGR8888=0x16762004u
SDL_PIXELTYPE_PACKED8=4  SDL_PIXELTYPE_PACKED16=5  SDL_PIXELTYPE_PACKED32=6
SDL_PACKEDORDER_ARGB=3  SDL_PACKEDORDER_RGBA=4  SDL_PACKEDORDER_ABGR=7
SDL_PACKEDORDER_BGRA=8  SDL_PIXELFORMAT_RGBA32=0x16762004u
SDL_PIXELFORMAT_XRGB8888=0x16161804u
```

Every texture/surface is RGBA bytes in memory; use SDL_PIXELFORMAT_RGBA32.

### Hint names

```
SDL_HINT_RENDER_DRIVER="SDL_RENDER_DRIVER"
```

### Error helper

```
SDL_InvalidParamError(param) SDL_SetError("Parameter '%s' is invalid", (param))
```

### Veneer sentinel

```
IMG_SURFACE_OWNED=0x80000000u
```

Set in SDL_Surface.flags on heap surfaces this runtime owns (IMG_Load results) — how SDL_DestroySurface knows to free.

## Notably ABSENT (do not assume stock SDL3)

Every claim in this list is re-verified against the header surface each
time this file is generated — an entry here is absent TODAY, not folklore.
An absent symbol fails loud at compile time (“Undeclared identifier”).

- SDL_ttf modern API: `TTF_Text` / `TTF_TextEngine` (`TTF_CreateText`, `TTF_CreateSurfaceTextEngine`, `TTF_CreateRendererTextEngine`, `TTF_DrawSurfaceText`, `TTF_DrawRendererText`) do not exist — only the classic render-to-surface API above. Also absent: `TTF_OpenFontIO` (no SDL_IOStream), `TTF_SetFontOutline`, the `TTF_RenderText_LCD*` family, and `TTF_HINTING_LIGHT_SUBPIXEL`.
- Render targets: `SDL_SetRenderTarget` / `SDL_GetRenderTarget`. SDL_TEXTUREACCESS_TARGET is defined, but rendering INTO a texture is not available — compose CPU-side and upload with SDL_UpdateTexture.
- Texture pixel access: `SDL_LockTexture` / `SDL_UnlockTexture` — upload with SDL_UpdateTexture instead.
- Renderer state: `SDL_SetRenderViewport`, `SDL_SetRenderClipRect`, `SDL_SetRenderScale`, `SDL_SetRenderLogicalPresentation`, `SDL_RenderReadPixels`, `SDL_GetRenderOutputSize` — none exist; draw in window pixels 1:1.
- Gamepad / joystick: no device API at all (`SDL_OpenGamepad`, `SDL_GetGamepads`, `SDL_OpenJoystick`, …). The SDL_INIT_GAMEPAD / SDL_INIT_JOYSTICK flag constants exist, but input is keyboard + mouse only.
- Surface toolkit: `SDL_CreateSurface`, `SDL_BlitSurface`, `SDL_FillSurfaceRect`, `SDL_ConvertSurface`, `SDL_LoadBMP` — the only SDL_Surfaces are window surfaces and IMG_Load results; write `->pixels` directly.
- Audio files & mixing: `SDL_LoadWAV` and SDL_mixer (`Mix_*`) — parse audio data yourself and push PCM through SDL_PutAudioStreamData (one stream per concurrent sound; the OS mixes).
- Window management: `SDL_ShowWindow`, `SDL_HideWindow`, `SDL_RaiseWindow`, `SDL_MinimizeWindow`, `SDL_MaximizeWindow`, `SDL_SetWindowFullscreen` — the WM owns placement and chrome.
- Text input & custom cursors: `SDL_StartTextInput` (use key events — event.key.key is already the applied character) and `SDL_CreateCursor` (system cursor shapes only, via SDL_CreateSystemCursor).
- stdinc wrappers: `SDL_snprintf`, `SDL_strlcpy`, `SDL_memcpy`, `SDL_sinf`, … — use libc (`<stdio.h>`, `<string.h>`, `<math.h>`); SDL and libc share one heap here.
- Threads, IO abstraction, properties, message boxes, GL: `SDL_CreateThread` (single-threaded platform), `SDL_IOStream`/`SDL_RWops` (use stdio), `SDL_GetWindowProperties`, `SDL_ShowSimpleMessageBox`, `SDL_GL_*` — GPU access is `<webgpu.h>` + `<sdl3webgpu.h>`.
- `SDL_RenderDebugText` — absent; debug/HUD text is FreeType or a bitmap font.
