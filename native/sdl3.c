/* Repo-owned SDL3 binding, using only the stable C Node-API and SDL3.
 * Handles are validated, typed, never-reused integers; native pointers never
 * cross the JS boundary. Renderer/texture/child-window lifetimes are owned
 * here.
 */
#define _GNU_SOURCE
#include <node_api.h>
#ifdef __APPLE__
#include <pthread.h>
#else
#include <sys/syscall.h>
#include <unistd.h>
#endif
#include <SDL3/SDL.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* One inventory owns JS names, argument validation and dispatch ids. */
// clang-format off
#define METHODS(X) \
  X(SDL_Init, "u") \
  X(SDL_Quit, "") \
  X(SDL_InitSubSystem, "u") \
  X(SDL_QuitSubSystem, "u") \
  X(SDL_SetHint, "ss") \
  X(SDL_GetError, "") \
  X(SDL_GetVersion, "") \
  X(SDL_CreateWindow, "siiu") \
  X(SDL_CreatePopupWindow, "uiiiiu") \
  X(SDL_DestroyWindow, "u") \
  X(SDL_SetWindowTitle, "us") \
  X(SDL_SetWindowPosition, "uii") \
  X(SDL_SetWindowSize, "uii") \
  X(SDL_GetWindowSize, "u") \
  X(SDL_GetWindowFlags, "u") \
  X(SDL_GetWindowDisplayScale, "u") \
  X(SDL_ShowWindow, "u") \
  X(SDL_HideWindow, "u") \
  X(SDL_RaiseWindow, "u") \
  X(SDL_SetWindowParent, "uu") \
  X(SDL_GetDisplayBounds, "") \
  X(SDL_SetWindowRelativeMouseMode, "ui") \
  X(SDL_SetSystemCursor, "i") \
  X(SDL_UpdateWindowPixels, "ubiii") \
  X(SDL_SetWindowIconPixels, "ubiii") \
  X(SDL_CreateRenderer, "ui") \
  X(SDL_DestroyRenderer, "u") \
  X(SDL_SetRenderVSync, "ui") \
  X(SDL_SetRenderClipRect, "uiiiii") \
  X(SDL_GetRenderClipRect, "u") \
  X(SDL_CreateTexture, "uiii") \
  X(SDL_DestroyTexture, "u") \
  X(SDL_UpdateTexture, "ubiiiii") \
  X(SDL_SetTextureColorModFloat, "ufff") \
  X(SDL_SetTextureAlphaModFloat, "uf") \
  X(SDL_SetTextureBlendMode, "ui") \
  X(SDL_GetTextureBlendMode, "u") \
  X(SDL_SetTextureScaleMode, "ui") \
  X(SDL_GetTextureScaleMode, "u") \
  X(SDL_SetRenderDrawColorFloat, "uffff") \
  X(SDL_SetRenderDrawBlendMode, "ui") \
  X(SDL_RenderClear, "u") \
  X(SDL_RenderPresent, "u") \
  X(SDL_SetRenderTarget, "uu") \
  X(SDL_RenderGeometry, "uubi") \
  X(SDL_RenderReadPixels, "u") \
  X(SDL_OpenAudioDeviceStream, "iii") \
  X(SDL_DestroyAudioStream, "u") \
  X(SDL_PutAudioStreamData, "ub") \
  X(SDL_GetAudioStreamQueued, "u") \
  X(SDL_ClearAudioStream, "u") \
  X(SDL_PauseAudioStreamDevice, "ui") \
  X(SDL_GetAudioDeviceFormat, "u") \
  X(SDL_SetAudioStreamFormat, "uiii") \
  X(SDL_GetAudioStreamFormat, "u") \
  X(SDL_GetGlobalMouseState, "") \
  X(SDL_GetBasePath, "") \
  X(SDL_GetPrefPath, "ss") \
  X(SDL_GetTicks, "") \
  X(SDL_Delay, "u") \
  X(SDL_PollEvents, "i") \
  X(SDL_PushEvent, "b") \
  X(SDL_GetGamepads, "") \
  X(SDL_GetGamepadNameForID, "u") \
  X(SDL_SetClipboardText, "s") \
  X(SDL_GetClipboardText, "") \
  X(SDL_HasClipboardText, "") \
  X(SDL_ClearClipboardData, "")
// clang-format on
#define OP(name, sig) OP_##name,
typedef enum { METHODS(OP) OP_COUNT } Op;
#undef OP
#define SIG(name, sig) sig,
static const char *signatures[] = {METHODS(SIG)};
#undef SIG

#include "addon.h"

napi_value number(napi_env env, double n) {
  napi_value v;
  napi_create_double(env, n, &v);
  return v;
}
napi_value boolean(napi_env env, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  return v;
}
napi_value undefined(napi_env env) {
  napi_value v;
  napi_get_undefined(env, &v);
  return v;
}
napi_value string(napi_env env, const char *s) {
  napi_value v;
  napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &v);
  return v;
}
napi_value error(napi_env env, const char *s) {
  napi_throw_error(env, NULL, s);
  return NULL;
}
static napi_value sdl_error(napi_env env) { return error(env, SDL_GetError()); }
double num(napi_env env, napi_value v) {
  double n = 0;
  napi_get_value_double(env, v, &n);
  return n;
}
char *str(napi_env env, napi_value v) {
  size_t n;
  napi_get_value_string_utf8(env, v, NULL, 0, &n);
  char *s = malloc(n + 1);
  if (!s) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  napi_get_value_string_utf8(env, v, s, n + 1, &n);
  return s;
}
static napi_value array(napi_env env, const double *v, size_t n) {
  napi_value out;
  napi_create_array_with_length(env, n, &out);
  for (size_t i = 0; i < n; i++)
    napi_set_element(env, out, (uint32_t)i, number(env, v[i]));
  return out;
}
static void field(napi_env env, napi_value o, const char *key, double v) {
  napi_set_named_property(env, o, key, number(env, v));
}

uint32_t store(State *s, Kind kind, void *ptr, uint32_t parent) {
  if (!ptr)
    return 0;
  if (s->count == s->capacity) {
    uint32_t n = s->capacity ? s->capacity * 2 : 64;
    if (n < s->capacity)
      return 0;
    Resource *p = realloc(s->items, (size_t)n * sizeof(*p));
    if (!p)
      return 0;
    s->items = p;
    s->capacity = n;
  }
  uint32_t id = ++s->count;
  s->items[id - 1] = (Resource){ptr, kind, parent};
  return id;
}
Resource *resource(napi_env env, State *s, uint32_t id, Kind kind) {
  if (!id || id > s->count || s->items[id - 1].kind != kind ||
      !s->items[id - 1].ptr) {
    napi_throw_type_error(env, NULL,
                          "Invalid, destroyed, or wrong-type SDL handle");
    return NULL;
  }
  return &s->items[id - 1];
}
void destroy(State *s, uint32_t id) {
  if (!id || id > s->count)
    return;
  Resource *r = &s->items[id - 1];
  if (!r->ptr)
    return;
  for (uint32_t i = 1; i <= s->count; i++)
    if (s->items[i - 1].ptr && s->items[i - 1].parent == id)
      destroy(s, i);
  switch (r->kind) {
  case WINDOW:
    SDL_DestroyWindow(r->ptr);
    break;
  case RENDERER:
    SDL_DestroyRenderer(r->ptr);
    break;
  case TEXTURE:
    SDL_DestroyTexture(r->ptr);
    break;
  case AUDIO:
    SDL_DestroyAudioStream(r->ptr);
    break;
  case GAMEPAD:
    SDL_CloseGamepad(r->ptr);
    break;
  default:
    if (r->kind >= GPU_FIRST && r->kind <= GPU_LAST) {
      gpu_destroy(s, id, r);
      return;
    }
    break;
  }
  r->ptr = NULL;
  r->kind = NONE;
}
static void destroy_cursors(State *s) {
  if (s->initialized)
    SDL_SetCursor(NULL);
  for (int i = 0; i < SDL_SYSTEM_CURSOR_COUNT; i++) {
    if (s->cursors[i])
      SDL_DestroyCursor(s->cursors[i]);
    s->cursors[i] = NULL;
  }
}
static void quit(State *s) {
  gpu_shutdown(s);
  for (uint32_t i = 1; i <= s->count; i++)
    destroy(s, i);
  destroy_cursors(s);
  if (s->initialized)
    SDL_Quit();
  s->initialized = false;
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  State *s = data;
  quit(s);
  gpu_finalize(s);
  free(s->items);
  free(s);
}
static uint32_t window_handle(State *s, SDL_WindowID id) {
  for (uint32_t i = 1; i <= s->count; i++)
    if (s->items[i - 1].kind == WINDOW &&
        SDL_GetWindowID(s->items[i - 1].ptr) == id)
      return i;
  return 0;
}
static void open_gamepad(State *s, SDL_JoystickID id) {
  for (uint32_t i = 1; i <= s->count; i++)
    if (s->items[i - 1].kind == GAMEPAD &&
        SDL_GetGamepadID(s->items[i - 1].ptr) == id)
      return;
  SDL_Gamepad *p = SDL_OpenGamepad(id);
  if (p && !store(s, GAMEPAD, p, 0))
    SDL_CloseGamepad(p);
}
static napi_value event_object(napi_env env, State *s, SDL_Event *e) {
  napi_value o;
  napi_create_object(env, &o);
  field(env, o, "type", e->type);
  switch (e->type) {
  case SDL_EVENT_KEY_DOWN:
  case SDL_EVENT_KEY_UP:
    field(env, o, "window", window_handle(s, e->key.windowID));
    field(env, o, "scancode", e->key.scancode);
    field(env, o, "key", e->key.key);
    field(env, o, "mod", e->key.mod);
    field(env, o, "repeat", e->key.repeat);
    break;
  case SDL_EVENT_MOUSE_MOTION: {
    SDL_Window *w = SDL_GetWindowFromID(e->motion.windowID);
    field(env, o, "window", window_handle(s, e->motion.windowID));
    field(env, o, "x", e->motion.x);
    field(env, o, "y", e->motion.y);
    field(env, o, "dx", e->motion.xrel);
    field(env, o, "dy", e->motion.yrel);
    field(env, o, "state", e->motion.state);
    field(env, o, "relative", w && SDL_GetWindowRelativeMouseMode(w));
    break;
  }
  case SDL_EVENT_MOUSE_BUTTON_DOWN:
  case SDL_EVENT_MOUSE_BUTTON_UP:
    field(env, o, "window", window_handle(s, e->button.windowID));
    field(env, o, "button", e->button.button);
    field(env, o, "x", e->button.x);
    field(env, o, "y", e->button.y);
    break;
  case SDL_EVENT_MOUSE_WHEEL:
    field(env, o, "window", window_handle(s, e->wheel.windowID));
    field(env, o, "x", e->wheel.x);
    field(env, o, "y", e->wheel.y);
    field(env, o, "direction", e->wheel.direction);
    break;
  case SDL_EVENT_GAMEPAD_ADDED:
    open_gamepad(s, e->gdevice.which);
    field(env, o, "id", e->gdevice.which);
    break;
  case SDL_EVENT_GAMEPAD_REMOVED:
    field(env, o, "id", e->gdevice.which);
    for (uint32_t i = 1; i <= s->count; i++)
      if (s->items[i - 1].kind == GAMEPAD &&
          SDL_GetGamepadID(s->items[i - 1].ptr) == e->gdevice.which)
        destroy(s, i);
    break;
  case SDL_EVENT_GAMEPAD_AXIS_MOTION:
    field(env, o, "id", e->gaxis.which);
    field(env, o, "axis", e->gaxis.axis);
    field(env, o, "value", e->gaxis.value);
    break;
  case SDL_EVENT_GAMEPAD_BUTTON_DOWN:
  case SDL_EVENT_GAMEPAD_BUTTON_UP:
    field(env, o, "id", e->gbutton.which);
    field(env, o, "button", e->gbutton.button);
    break;
  default:
    if (e->type >= SDL_EVENT_WINDOW_FIRST && e->type <= SDL_EVENT_WINDOW_LAST) {
      field(env, o, "window", window_handle(s, e->window.windowID));
      field(env, o, "data1", e->window.data1);
      field(env, o, "data2", e->window.data2);
    }
    break;
  }
  return o;
}
static bool pixels_fit(size_t size, int w, int h, int pitch) {
  return w > 0 && h > 0 && w <= INT_MAX / 4 && pitch >= w * 4 &&
         (size_t)(h - 1) * (size_t)pitch + (size_t)w * 4 <= size;
}
#define N(i) num(env, v[i])
#define I(i) ((int)N(i))
#define U(i) ((uint32_t)N(i))
#define HANDLE(name, i, kind)                                                  \
  Resource *name = resource(env, s, U(i), kind);                               \
  if (!name)                                                                   \
  return NULL
#define WINDOW_AT(i) HANDLE(w, i, WINDOW)
#define RENDERER_AT(i) HANDLE(r, i, RENDERER)
#define TEXTURE_AT(i) HANDLE(t, i, TEXTURE)
#define AUDIO_AT(i) HANDLE(a, i, AUDIO)
#define OK(call) return boolean(env, (call))
#define BUFFER(i)                                                              \
  void *buffer;                                                                \
  size_t length;                                                               \
  napi_get_buffer_info(env, v[i], &buffer, &length)

static napi_value dispatch(napi_env env, napi_callback_info info) {
  napi_value v[20];
  size_t argc = 20;
  void *data;
  napi_get_cb_info(env, info, &argc, v, NULL, &data);
  Op op = (Op)(uintptr_t)data;
  State *s;
  napi_get_instance_data(env, (void **)&s);
  const char *sig = signatures[op];
  if (argc != strlen(sig)) {
    napi_throw_type_error(env, NULL, "Incorrect SDL argument count");
    return NULL;
  }
  for (size_t i = 0; i < argc; i++) {
    napi_valuetype type;
    napi_typeof(env, v[i], &type);
    bool valid = false;
    if (sig[i] == 's')
      valid = type == napi_string;
    else if (sig[i] == 'b')
      napi_is_buffer(env, v[i], &valid);
    else if (type == napi_number) {
      double n = N(i);
      valid = isfinite(n);
      if (sig[i] != 'f')
        valid = valid && floor(n) == n && n >= (sig[i] == 'u' ? 0 : INT_MIN) &&
                n <= (sig[i] == 'u' ? UINT32_MAX : INT_MAX);
    }
    if (!valid) {
      napi_throw_type_error(env, NULL,
                            "Invalid SDL argument type or numeric range");
      return NULL;
    }
  }
  // SDL video/event APIs require the process main thread. Node's adapter also
  // checks worker_threads.isMainThread before loading this addon.
  if (s->initialized && !SDL_IsMainThread())
    return error(env, "SDL calls must run on the main thread");
  switch (op) {
  case OP_SDL_GetVersion:
    return number(env, SDL_GetVersion());
  case OP_SDL_GetError:
    return string(env, SDL_GetError());
  case OP_SDL_SetHint: {
    char *a = str(env, v[0]), *b = str(env, v[1]);
    if (!a || !b) {
      free(a);
      free(b);
      return NULL;
    }
    bool ok = SDL_SetHint(a, b);
    free(a);
    free(b);
    OK(ok);
  }
  case OP_SDL_Init:
  case OP_SDL_InitSubSystem: {
    bool ok = op == OP_SDL_Init ? SDL_Init(U(0)) : SDL_InitSubSystem(U(0));
    if (ok)
      s->initialized = true;
    OK(ok);
  }
  case OP_SDL_Quit:
    quit(s);
    return undefined(env);
  case OP_SDL_QuitSubSystem:
    for (uint32_t i = 1; i <= s->count; i++) {
      Kind k = s->items[i - 1].kind;
      if (((U(0) & SDL_INIT_VIDEO) && k == WINDOW) ||
          ((U(0) & SDL_INIT_AUDIO) && k == AUDIO) ||
          ((U(0) & SDL_INIT_GAMEPAD) && k == GAMEPAD))
        destroy(s, i);
    }
    if (U(0) & SDL_INIT_VIDEO)
      destroy_cursors(s);
    SDL_QuitSubSystem(U(0));
    return undefined(env);
  case OP_SDL_CreateWindow: {
    char *title = str(env, v[0]);
    if (!title)
      return NULL;
    SDL_Window *p = SDL_CreateWindow(title, I(1), I(2), U(3));
    if (p) s->initialized = true; // SDL may initialize video implicitly.
    free(title);
    uint32_t h = store(s, WINDOW, p, 0);
    if (p && !h) {
      SDL_DestroyWindow(p);
      return error(env, "Out of memory");
    }
    return number(env, h);
  }
  case OP_SDL_CreatePopupWindow: {
    WINDOW_AT(0);
    SDL_Window *p = SDL_CreatePopupWindow(w->ptr, I(1), I(2), I(3), I(4), U(5));
    uint32_t h = store(s, WINDOW, p, U(0));
    if (p && !h) {
      SDL_DestroyWindow(p);
      return error(env, "Out of memory");
    }
    return number(env, h);
  }
  case OP_SDL_DestroyWindow: {
    WINDOW_AT(0);
    (void)w;
    destroy(s, U(0));
    return undefined(env);
  }
  case OP_SDL_SetWindowTitle: {
    WINDOW_AT(0);
    char *title = str(env, v[1]);
    if (!title)
      return NULL;
    bool ok = SDL_SetWindowTitle(w->ptr, title);
    free(title);
    OK(ok);
  }
  case OP_SDL_SetWindowPosition: {
    WINDOW_AT(0);
    OK(SDL_SetWindowPosition(w->ptr, I(1), I(2)));
  }
  case OP_SDL_SetWindowSize: {
    WINDOW_AT(0);
    OK(SDL_SetWindowSize(w->ptr, I(1), I(2)));
  }
  case OP_SDL_GetWindowSize: {
    WINDOW_AT(0);
    int width, height;
    if (!SDL_GetWindowSize(w->ptr, &width, &height))
      return sdl_error(env);
    double d[] = {width, height};
    return array(env, d, 2);
  }
  case OP_SDL_GetWindowFlags: {
    WINDOW_AT(0);
    return number(env, (double)SDL_GetWindowFlags(w->ptr));
  }
  case OP_SDL_GetWindowDisplayScale: {
    WINDOW_AT(0);
    return number(env, SDL_GetWindowDisplayScale(w->ptr));
  }
  case OP_SDL_ShowWindow: {
    WINDOW_AT(0);
    OK(SDL_ShowWindow(w->ptr));
  }
  case OP_SDL_HideWindow: {
    WINDOW_AT(0);
    OK(SDL_HideWindow(w->ptr));
  }
  case OP_SDL_RaiseWindow: {
    WINDOW_AT(0);
    OK(SDL_RaiseWindow(w->ptr));
  }
  case OP_SDL_SetWindowParent: {
    WINDOW_AT(0);
    Resource *p = U(1) ? resource(env, s, U(1), WINDOW) : NULL;
    if (U(1) && !p)
      return NULL;
    for (uint32_t id = U(1); id; id = s->items[id - 1].parent)
      if (id == U(0))
        return error(env, "Window parent cycle");
    bool ok = SDL_SetWindowParent(w->ptr, p ? p->ptr : NULL);
    if (ok)
      w->parent = U(1);
    OK(ok);
  }
  case OP_SDL_GetDisplayBounds: {
    SDL_Rect r;
    if (!SDL_GetDisplayBounds(SDL_GetPrimaryDisplay(), &r))
      return sdl_error(env);
    double d[] = {r.x, r.y, r.w, r.h};
    return array(env, d, 4);
  }
  case OP_SDL_SetWindowRelativeMouseMode: {
    WINDOW_AT(0);
    OK(SDL_SetWindowRelativeMouseMode(w->ptr, I(1) != 0));
  }
  case OP_SDL_SetSystemCursor: {
    int shape = I(0);
    if (shape == -1)
      OK(SDL_HideCursor());
    if (shape < 0 || shape >= SDL_SYSTEM_CURSOR_COUNT)
      return error(env, "Invalid system cursor");
    if (!s->cursors[shape])
      s->cursors[shape] = SDL_CreateSystemCursor(shape);
    if (!s->cursors[shape])
      return sdl_error(env);
    OK(SDL_SetCursor(s->cursors[shape]) && SDL_ShowCursor());
  }
  case OP_SDL_UpdateWindowPixels:
  case OP_SDL_SetWindowIconPixels: {
    WINDOW_AT(0);
    BUFFER(1);
    if (op == OP_SDL_UpdateWindowPixels && gpu_window_has_surface(s, U(0)))
      return error(env, "Window presents through a WebGPU surface");
    int width = I(2), height = I(3), pitch = I(4);
    if (!pixels_fit(length, width, height, pitch))
      return error(env, "Invalid pixel buffer dimensions/pitch");
    SDL_Surface *src = SDL_CreateSurfaceFrom(
        width, height, SDL_PIXELFORMAT_RGBA32, buffer, pitch);
    if (!src)
      return sdl_error(env);
    bool ok;
    if (op == OP_SDL_SetWindowIconPixels)
      ok = SDL_SetWindowIcon(w->ptr, src);
    else {
      SDL_Surface *dst = SDL_GetWindowSurface(w->ptr);
      ok = dst &&
           SDL_BlitSurfaceScaled(src, NULL, dst, NULL, SDL_SCALEMODE_NEAREST) &&
           SDL_UpdateWindowSurface(w->ptr);
    }
    SDL_DestroySurface(src);
    OK(ok);
  }
  case OP_SDL_CreateRenderer: {
    WINDOW_AT(0);
    if (gpu_window_has_surface(s, U(0)))
      return error(env, "Window presents through a WebGPU surface");
    SDL_Renderer *p = SDL_CreateRenderer(w->ptr, I(1) ? "software" : NULL);
    uint32_t h = store(s, RENDERER, p, U(0));
    if (p && !h) {
      SDL_DestroyRenderer(p);
      return error(env, "Out of memory");
    }
    return number(env, h);
  }
  case OP_SDL_DestroyRenderer: {
    RENDERER_AT(0);
    (void)r;
    destroy(s, U(0));
    return undefined(env);
  }
  case OP_SDL_SetRenderVSync: {
    RENDERER_AT(0);
    OK(SDL_SetRenderVSync(r->ptr, I(1)));
  }
  case OP_SDL_SetRenderClipRect: {
    RENDERER_AT(0);
    SDL_Rect clip = {I(2), I(3), I(4), I(5)};
    OK(SDL_SetRenderClipRect(r->ptr, I(1) ? &clip : NULL));
  }
  case OP_SDL_GetRenderClipRect: {
    RENDERER_AT(0);
    SDL_Rect clip;
    if (!SDL_GetRenderClipRect(r->ptr, &clip))
      return sdl_error(env);
    double d[] = {SDL_RenderClipEnabled(r->ptr), clip.x, clip.y, clip.w,
                  clip.h};
    return array(env, d, 5);
  }
  case OP_SDL_CreateTexture: {
    RENDERER_AT(0);
    SDL_Texture *p =
        SDL_CreateTexture(r->ptr, SDL_PIXELFORMAT_RGBA32, I(1), I(2), I(3));
    uint32_t h = store(s, TEXTURE, p, U(0));
    if (p && !h) {
      SDL_DestroyTexture(p);
      return error(env, "Out of memory");
    }
    return number(env, h);
  }
  case OP_SDL_DestroyTexture: {
    TEXTURE_AT(0);
    (void)t;
    destroy(s, U(0));
    return undefined(env);
  }
  case OP_SDL_UpdateTexture: {
    TEXTURE_AT(0);
    BUFFER(1);
    int pitch = I(2);
    SDL_Rect rect = {I(3), I(4), I(5), I(6)};
    if (!pixels_fit(length, rect.w, rect.h, pitch))
      return error(env, "Texture buffer is too short");
    SDL_Texture *texture = t->ptr;
    if (rect.x < 0 || rect.y < 0 || rect.x > texture->w - rect.w ||
        rect.y > texture->h - rect.h)
      return error(env, "Texture rectangle outside texture");
    OK(SDL_UpdateTexture(texture, &rect, buffer, pitch));
  }
  case OP_SDL_SetTextureColorModFloat: {
    TEXTURE_AT(0);
    OK(SDL_SetTextureColorModFloat(t->ptr, N(1), N(2), N(3)));
  }
  case OP_SDL_SetTextureAlphaModFloat: {
    TEXTURE_AT(0);
    OK(SDL_SetTextureAlphaModFloat(t->ptr, N(1)));
  }
  case OP_SDL_SetTextureBlendMode: {
    TEXTURE_AT(0);
    OK(SDL_SetTextureBlendMode(t->ptr, I(1)));
  }
  case OP_SDL_GetTextureBlendMode: {
    TEXTURE_AT(0);
    SDL_BlendMode mode;
    if (!SDL_GetTextureBlendMode(t->ptr, &mode))
      return sdl_error(env);
    return number(env, mode);
  }
  case OP_SDL_SetTextureScaleMode: {
    TEXTURE_AT(0);
    OK(SDL_SetTextureScaleMode(t->ptr, I(1)));
  }
  case OP_SDL_GetTextureScaleMode: {
    TEXTURE_AT(0);
    SDL_ScaleMode mode;
    if (!SDL_GetTextureScaleMode(t->ptr, &mode))
      return sdl_error(env);
    return number(env, mode);
  }
  case OP_SDL_SetRenderDrawColorFloat: {
    RENDERER_AT(0);
    OK(SDL_SetRenderDrawColorFloat(r->ptr, N(1), N(2), N(3), N(4)));
  }
  case OP_SDL_SetRenderDrawBlendMode: {
    RENDERER_AT(0);
    OK(SDL_SetRenderDrawBlendMode(r->ptr, I(1)));
  }
  case OP_SDL_RenderClear: {
    RENDERER_AT(0);
    OK(SDL_RenderClear(r->ptr));
  }
  case OP_SDL_RenderPresent: {
    RENDERER_AT(0);
    OK(SDL_RenderPresent(r->ptr));
  }
  case OP_SDL_SetRenderTarget: {
    RENDERER_AT(0);
    Resource *t = U(1) ? resource(env, s, U(1), TEXTURE) : NULL;
    if (U(1) && !t)
      return NULL;
    if (t && t->parent != U(0))
      return error(env, "Texture belongs to another renderer");
    OK(SDL_SetRenderTarget(r->ptr, t ? t->ptr : NULL));
  }
  case OP_SDL_RenderGeometry: {
    RENDERER_AT(0);
    Resource *t = U(1) ? resource(env, s, U(1), TEXTURE) : NULL;
    if (U(1) && !t)
      return NULL;
    if (t && t->parent != U(0))
      return error(env, "Texture belongs to another renderer");
    BUFFER(2);
    int count = I(3);
    if (count < 0 || count % 3 || (size_t)count > length / (8 * sizeof(float)))
      return error(env, "Invalid geometry buffer");
    if (!count)
      return boolean(env, true);
    // memcpy permits unaligned Buffer slices without an intermediate heap copy.
    SDL_Vertex small[96];
    SDL_Vertex *verts = count <= 96 ? small : malloc((size_t)count * sizeof(*verts));
    if (!verts) return error(env, "Out of memory");
    for (int i = 0; i < count; i++) {
      float p[8];
      memcpy(p, (const char *)buffer + (size_t)i * sizeof(p), sizeof(p));
      verts[i] = (SDL_Vertex){{p[0], p[1]}, {p[4], p[5], p[6], p[7]}, {p[2], p[3]}};
    }
    bool ok = SDL_RenderGeometry(r->ptr, t ? t->ptr : NULL, verts, count, NULL, 0);
    if (verts != small) free(verts);
    OK(ok);
  }
  case OP_SDL_RenderReadPixels: {
    RENDERER_AT(0);
    SDL_Surface *src = SDL_RenderReadPixels(r->ptr, NULL);
    if (!src)
      return sdl_error(env);
    SDL_Surface *rgba = SDL_ConvertSurface(src, SDL_PIXELFORMAT_RGBA32);
    SDL_DestroySurface(src);
    if (!rgba)
      return sdl_error(env);
    napi_value o, pixels;
    napi_create_object(env, &o);
    napi_create_buffer_copy(env, (size_t)rgba->pitch * rgba->h, rgba->pixels,
                            NULL, &pixels);
    napi_set_named_property(env, o, "pixels", pixels);
    field(env, o, "width", rgba->w);
    field(env, o, "height", rgba->h);
    field(env, o, "pitch", rgba->pitch);
    SDL_DestroySurface(rgba);
    return o;
  }
  case OP_SDL_OpenAudioDeviceStream: {
    SDL_AudioSpec spec = {I(1), I(2), I(0)};
    SDL_AudioStream *p = SDL_OpenAudioDeviceStream(
        SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, NULL, NULL);
    uint32_t h = store(s, AUDIO, p, 0);
    if (p && !h) {
      SDL_DestroyAudioStream(p);
      return error(env, "Out of memory");
    }
    return number(env, h);
  }
  case OP_SDL_DestroyAudioStream: {
    AUDIO_AT(0);
    (void)a;
    destroy(s, U(0));
    return undefined(env);
  }
  case OP_SDL_PutAudioStreamData: {
    AUDIO_AT(0);
    BUFFER(1);
    if (length > INT_MAX)
      return error(env, "Audio buffer too large");
    OK(SDL_PutAudioStreamData(a->ptr, buffer, (int)length));
  }
  case OP_SDL_GetAudioStreamQueued: {
    AUDIO_AT(0);
    return number(env, SDL_GetAudioStreamQueued(a->ptr));
  }
  case OP_SDL_ClearAudioStream: {
    AUDIO_AT(0);
    OK(SDL_ClearAudioStream(a->ptr));
  }
  case OP_SDL_PauseAudioStreamDevice: {
    AUDIO_AT(0);
    OK(I(1) ? SDL_PauseAudioStreamDevice(a->ptr)
            : SDL_ResumeAudioStreamDevice(a->ptr));
  }
  case OP_SDL_SetAudioStreamFormat: {
    AUDIO_AT(0);
    SDL_AudioSpec src = {I(2), I(3), I(1)};
    OK(SDL_SetAudioStreamFormat(a->ptr, &src, NULL));
  }
  case OP_SDL_GetAudioStreamFormat: {
    AUDIO_AT(0);
    SDL_AudioSpec src, dst;
    if (!SDL_GetAudioStreamFormat(a->ptr, &src, &dst))
      return sdl_error(env);
    double d[] = {src.format, src.channels, src.freq,
                  dst.format, dst.channels, dst.freq};
    return array(env, d, 6);
  }
  case OP_SDL_GetAudioDeviceFormat: {
    AUDIO_AT(0);
    SDL_AudioSpec spec;
    if (!SDL_GetAudioDeviceFormat(SDL_GetAudioStreamDevice(a->ptr), &spec,
                                  NULL))
      return sdl_error(env);
    double d[] = {spec.format, spec.channels, spec.freq};
    return array(env, d, 3);
  }
  case OP_SDL_GetGlobalMouseState: {
    float x, y;
    SDL_MouseButtonFlags mask = SDL_GetGlobalMouseState(&x, &y);
    double values[] = {mask, x, y};
    return array(env, values, 3);
  }
  case OP_SDL_GetBasePath: {
    const char *p = SDL_GetBasePath();
    if (!p) {
      napi_value n;
      napi_get_null(env, &n);
      return n;
    }
    return string(env, p);
  }
  case OP_SDL_GetPrefPath: {
    char *org = str(env, v[0]), *app = str(env, v[1]);
    if (!org || !app) {
      free(org);
      free(app);
      return NULL;
    }
    char *p = SDL_GetPrefPath(org, app);
    free(org);
    free(app);
    if (!p) {
      napi_value n;
      napi_get_null(env, &n);
      return n;
    }
    napi_value out = string(env, p);
    SDL_free(p);
    return out;
  }
  case OP_SDL_GetTicks:
    return number(env, (double)SDL_GetTicks());
  case OP_SDL_Delay:
    SDL_Delay(U(0));
    return undefined(env);
  case OP_SDL_PollEvents: {
    napi_value events;
    napi_create_array(env, &events);
    SDL_Event e;
    uint32_t n = 0;
    if (I(0) != 0) {
      SDL_ClearError();
      bool got = I(0) < 0 ? SDL_WaitEvent(&e) : SDL_WaitEventTimeout(&e, I(0));
      if (got)
        napi_set_element(env, events, n++, event_object(env, s, &e));
      else if (*SDL_GetError())
        return sdl_error(env);
    }
    while (n < 1024 && SDL_PollEvent(&e))
      napi_set_element(env, events, n++, event_object(env, s, &e));
    return events;
  }
  case OP_SDL_PushEvent: {
    BUFFER(0);
    if (length != sizeof(SDL_Event))
      return error(env, "SDL_Event buffer has incorrect size");
    SDL_Event e;
    memcpy(&e, buffer, sizeof(e));
    // Test injection only accepts value-only event types (never pointer
    // payloads).
    if (e.type != SDL_EVENT_QUIT && e.type != SDL_EVENT_KEY_DOWN &&
        e.type != SDL_EVENT_KEY_UP && e.type != SDL_EVENT_MOUSE_MOTION &&
        e.type != SDL_EVENT_MOUSE_BUTTON_DOWN &&
        e.type != SDL_EVENT_MOUSE_BUTTON_UP)
      return error(env, "Unsupported injected event type");
    OK(SDL_PushEvent(&e));
  }
  case OP_SDL_GetGamepads: {
    int count;
    SDL_JoystickID *ids = SDL_GetGamepads(&count);
    if (!ids)
      return sdl_error(env);
    napi_value out;
    napi_create_array_with_length(env, count, &out);
    for (int i = 0; i < count; i++) {
      open_gamepad(s, ids[i]);
      napi_set_element(env, out, i, number(env, ids[i]));
    }
    SDL_free(ids);
    return out;
  }
  case OP_SDL_GetGamepadNameForID:
    return string(env, SDL_GetGamepadNameForID(U(0)));
  case OP_SDL_SetClipboardText: {
    char *text = str(env, v[0]);
    if (!text)
      return NULL;
    bool ok = SDL_SetClipboardText(text);
    free(text);
    OK(ok);
  }
  case OP_SDL_GetClipboardText: {
    char *text = SDL_GetClipboardText();
    if (!text)
      return sdl_error(env);
    napi_value result = string(env, text);
    SDL_free(text);
    return result;
  }
  case OP_SDL_HasClipboardText:
    OK(SDL_HasClipboardText());
  case OP_SDL_ClearClipboardData:
    OK(SDL_ClearClipboardData());
  default:
    return error(env, "Unknown SDL operation");
  }
}
static napi_value init(napi_env env, napi_value exports) {
#ifdef __APPLE__
  if (!pthread_main_np())
    return error(env, "SDL3 addon must load on the process main thread");
#else
  if (syscall(SYS_gettid) != getpid())
    return error(env, "SDL3 addon must load on the process main thread");
#endif
  State *s = calloc(1, sizeof(*s));
  if (!s)
    return error(env, "Out of memory");
  napi_set_instance_data(env, s, finalize, NULL);
#define EXPORT(name, sig)                                                      \
  {#name, NULL, dispatch,     NULL,                                            \
   NULL,  NULL, napi_default, (void *)(uintptr_t)OP_##name},
  napi_property_descriptor props[] = {METHODS(EXPORT)};
#undef EXPORT
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  gpu_define(env, exports);
  field(env, exports, "eventSize", sizeof(SDL_Event));
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
