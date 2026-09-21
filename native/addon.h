/* Shared state of the plain C Node-API addon: the typed handle table that
   sdl3.c (SDL3) and webgpu.c (wgpu-native) both use. Native pointers never
   cross into JavaScript; every resource is an integer handle in this table. */
#pragma once
#include <node_api.h>
#include <SDL3/SDL.h>
#include <stdbool.h>
#include <stdint.h>

typedef enum {
  NONE,
  WINDOW,
  RENDERER,
  TEXTURE,
  AUDIO,
  GAMEPAD,
  /* WebGPU kinds (webgpu.c). GPU_FIRST/GPU_LAST bracket them. */
  GPU_INSTANCE,
  GPU_ADAPTER,
  GPU_DEVICE,
  GPU_QUEUE,
  GPU_SURFACE,
  GPU_BUFFER,
  GPU_TEXTURE,
  GPU_TEXTURE_VIEW,
  GPU_SAMPLER,
  GPU_SHADER_MODULE,
  GPU_BIND_GROUP_LAYOUT,
  GPU_BIND_GROUP,
  GPU_PIPELINE_LAYOUT,
  GPU_RENDER_PIPELINE,
  GPU_COMPUTE_PIPELINE,
  GPU_COMMAND_ENCODER,
  GPU_RENDER_PASS,
  GPU_COMPUTE_PASS,
  GPU_COMMAND_BUFFER,
  KIND_COUNT
} Kind;
#define GPU_FIRST GPU_INSTANCE
#define GPU_LAST GPU_COMMAND_BUFFER

typedef struct {
  void *ptr;
  Kind kind;
  uint32_t parent;
} Resource;

struct GpuState;
typedef struct {
  Resource *items;
  uint32_t count, capacity;
  SDL_Cursor *cursors[SDL_SYSTEM_CURSOR_COUNT];
  bool initialized;
  struct GpuState *gpu; /* owned by webgpu.c; NULL until first use */
} State;

/* sdl3.c helpers shared with webgpu.c. */
napi_value number(napi_env env, double n);
napi_value boolean(napi_env env, bool b);
napi_value undefined(napi_env env);
napi_value string(napi_env env, const char *s);
napi_value error(napi_env env, const char *s);
double num(napi_env env, napi_value v);
char *str(napi_env env, napi_value v);
uint32_t store(State *s, Kind kind, void *ptr, uint32_t parent);
Resource *resource(napi_env env, State *s, uint32_t id, Kind kind);
void destroy(State *s, uint32_t id);

/* webgpu.c hooks called by sdl3.c. */
void gpu_define(napi_env env, napi_value exports);
void gpu_destroy(State *s, uint32_t id, Resource *r); /* GPU kinds only */
void gpu_finalize(State *s);
void gpu_shutdown(State *s);
/* True when a WebGPU surface is bound to the window handle. Such a window
   must not also present through SDL_UpdateWindowSurface or an SDL_Renderer. */
bool gpu_window_has_surface(State *s, uint32_t window);
