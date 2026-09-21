// Native WebGPU for c.js: the __wgpu_* host imports on wgpu-native.
//
// c.js's C veneer (__webgpu.c) flattens every descriptor into primitives and
// packed int arrays. The JavaScript adapter (createNativeWebGPU) forwards them
// here unchanged, so this file re-inflates them into webgpu.h structs, maps
// the veneer's enum numbering onto wgpu-native's, and owns every GPU object
// lifetime through the shared handle table (addon.h). Native pointers never
// reach JavaScript.
//
// Async completions (adapter, device, buffer map, error scope) are queued and
// handed to JavaScript by WGPU_ProcessEvents, which the runtime calls from its
// frame loop; the adapter then invokes the wasm callback trampolines.
#include "addon.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef NO_WEBGPU
void gpu_define(napi_env env, napi_value exports) {
  (void)env;
  (void)exports;
}
void gpu_destroy(State *s, uint32_t id, Resource *r) {
  (void)s;
  (void)id;
  r->ptr = NULL;
  r->kind = NONE;
}
void gpu_finalize(State *s) { (void)s; }
void gpu_shutdown(State *s) { (void)s; }
bool gpu_window_has_surface(State *s, uint32_t window) {
  (void)s;
  (void)window;
  return false;
}
#else

#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>

// clang-format off
#define GPU_METHODS(X) \
  X(WGPU_CreateInstance, "") \
  X(WGPU_InstanceCreateSurface, "uu") \
  X(WGPU_InstanceRequestAdapter, "uiii") \
  X(WGPU_AdapterRequestDevice, "uiii") \
  X(WGPU_ProcessEvents, "") \
  X(WGPU_DevicePoll, "ui") \
  X(WGPU_DeviceGetQueue, "u") \
  X(WGPU_SurfaceGetPreferredFormat, "u") \
  X(WGPU_SurfaceConfigure, "uuiuiiiib") \
  X(WGPU_SurfaceGetCurrentTexture, "u") \
  X(WGPU_SurfacePresent, "u") \
  X(WGPU_TextureCreateView, "uiiuuuui") \
  X(WGPU_DeviceCreateShaderModuleWGSL, "ub") \
  X(WGPU_DeviceCreateRenderPipeline, "uususbiiiibuiiiiiffbiuibbbb") \
  X(WGPU_DeviceCreateBuffer, "uuui") \
  X(WGPU_QueueWriteBuffer, "uuub") \
  X(WGPU_RenderPassSetVertexBuffer, "uuuui") \
  X(WGPU_RenderPassSetIndexBuffer, "uuiui") \
  X(WGPU_RenderPassDrawIndexed, "uuuuiu") \
  X(WGPU_DeviceCreateBindGroupLayout, "ub") \
  X(WGPU_DeviceCreatePipelineLayout, "ub") \
  X(WGPU_DeviceCreateBindGroup, "uub") \
  X(WGPU_RenderPassSetBindGroup, "uuub") \
  X(WGPU_DeviceCreateTexture, "uuuuiuiuu") \
  X(WGPU_DeviceCreateSampler, "uiiiiiiffui") \
  X(WGPU_QueueWriteTexture, "uuuuuuibuuuuuu") \
  X(WGPU_CommandEncoderCopyTextureToBuffer, "uuuuuuuuuuuuu") \
  X(WGPU_BufferMapAsync, "uuuiiii") \
  X(WGPU_BufferGetSize, "u") \
  X(WGPU_BufferReadMappedRange, "uub") \
  X(WGPU_BufferWriteMappedRange, "uub") \
  X(WGPU_BufferUnmap, "u") \
  X(WGPU_CommandEncoderCopyBufferToBuffer, "uuuuuu") \
  X(WGPU_DeviceCreateComputePipeline, "uusubb") \
  X(WGPU_CommandEncoderBeginComputePass, "u") \
  X(WGPU_ComputePassSetPipeline, "uu") \
  X(WGPU_ComputePassSetBindGroup, "uuub") \
  X(WGPU_ComputePassDispatch, "uuuu") \
  X(WGPU_ComputePassEnd, "u") \
  X(WGPU_DevicePushErrorScope, "ui") \
  X(WGPU_DevicePopErrorScope, "uiii") \
  X(WGPU_DeviceCreateCommandEncoder, "u") \
  X(WGPU_CommandEncoderBeginRenderPass, "ubbuiifiiiui") \
  X(WGPU_RenderPassSetStencilReference, "uu") \
  X(WGPU_RenderPassSetPipeline, "uu") \
  X(WGPU_RenderPassDraw, "uuuuu") \
  X(WGPU_RenderPassEnd, "u") \
  X(WGPU_CommandEncoderFinish, "u") \
  X(WGPU_QueueSubmit, "uu") \
  X(WGPU_Release, "u") \
  X(WGPU_Shutdown, "") \
  X(WGPU_MapEnum, "si")
// clang-format on
#define OP(name, sig) OP_##name,
typedef enum { GPU_METHODS(OP) OP_GPU_COUNT } GpuOp;
#undef OP
#define SIG(name, sig) sig,
static const char *gpu_signatures[] = {GPU_METHODS(SIG)};
#undef SIG

enum { CB_ADAPTER, CB_DEVICE, CB_MAP, CB_POP_ERROR };
typedef struct {
  WGPUBuffer buffer;
  bool mapped, writable, mapping;
  uint64_t offset, size;
  void *range;
} GpuBuffer;

typedef struct Pending {
  struct Pending *next;
  int kind, cb, ud1, ud2;
  int status, type;
  uint32_t handle;
  char *message;
  GpuBuffer *buffer; // CB_MAP: marked mapped on success
  bool done;
} Pending;

struct GpuState {
  uint32_t *free_ids;
  uint32_t free_count, free_cap;
  Pending *pending; // every outstanding or undelivered callback record
  WGPUAdapter adapter; // last requested adapter (surface capabilities)
  bool log_set;
  WGPUDevice *devices;
  size_t device_count;
};

typedef struct {
  WGPUSurface surface;
#ifdef __APPLE__
  SDL_MetalView view;
#endif
  WGPUTexture current; // last texture from wgpuSurfaceGetCurrentTexture
  uint32_t current_handle;
  bool configured;
} GpuSurface;

static struct GpuState *gpu(State *s) {
  if (!s->gpu)
    s->gpu = calloc(1, sizeof(*s->gpu));
  return s->gpu;
}

// ---- handle table -----------------------------------------------------------

static uint32_t gpu_store(State *s, Kind kind, void *ptr, uint32_t parent) {
  if (!ptr)
    return 0;
  struct GpuState *g = gpu(s);
  if (g && g->free_count) {
    uint32_t id = g->free_ids[--g->free_count];
    s->items[id - 1] = (Resource){ptr, kind, parent};
    return id;
  }
  return store(s, kind, ptr, parent);
}

static void free_slot(State *s, uint32_t id, Resource *r) {
  r->ptr = NULL;
  r->kind = NONE;
  r->parent = 0;
  struct GpuState *g = gpu(s);
  if (!g || !id)
    return;
  if (g->free_count == g->free_cap) {
    uint32_t n = g->free_cap ? g->free_cap * 2 : 64;
    uint32_t *p = realloc(g->free_ids, (size_t)n * sizeof(*p));
    if (!p)
      return; // the slot simply stays retired
    g->free_ids = p;
    g->free_cap = n;
  }
  g->free_ids[g->free_count++] = id;
}

static void destroy_surface(GpuSurface *sf) {
  if (sf->configured)
    wgpuSurfaceUnconfigure(sf->surface);
  wgpuSurfaceRelease(sf->surface);
#ifdef __APPLE__
  if (sf->view)
    SDL_Metal_DestroyView(sf->view);
#endif
  free(sf);
}

void gpu_destroy(State *s, uint32_t id, Resource *r) {
  void *p = r->ptr;
  switch (r->kind) {
  case GPU_INSTANCE: wgpuInstanceRelease(p); break;
  case GPU_ADAPTER:
    if (s->gpu && s->gpu->adapter == p)
      s->gpu->adapter = NULL;
    wgpuAdapterRelease(p);
    break;
  case GPU_DEVICE: wgpuDeviceRelease(p); break;
  case GPU_QUEUE: wgpuQueueRelease(p); break;
  case GPU_SURFACE: destroy_surface(p); break;
  case GPU_BUFFER:
    if (s->gpu)
      for (Pending *q = s->gpu->pending; q; q = q->next)
        if (q->buffer == p)
          q->buffer = NULL;
    wgpuBufferRelease(((GpuBuffer *)p)->buffer);
    free(p);
    break;
  case GPU_TEXTURE: wgpuTextureRelease(p); break;
  case GPU_TEXTURE_VIEW: wgpuTextureViewRelease(p); break;
  case GPU_SAMPLER: wgpuSamplerRelease(p); break;
  case GPU_SHADER_MODULE: wgpuShaderModuleRelease(p); break;
  case GPU_BIND_GROUP_LAYOUT: wgpuBindGroupLayoutRelease(p); break;
  case GPU_BIND_GROUP: wgpuBindGroupRelease(p); break;
  case GPU_PIPELINE_LAYOUT: wgpuPipelineLayoutRelease(p); break;
  case GPU_RENDER_PIPELINE: wgpuRenderPipelineRelease(p); break;
  case GPU_COMPUTE_PIPELINE: wgpuComputePipelineRelease(p); break;
  case GPU_COMMAND_ENCODER: wgpuCommandEncoderRelease(p); break;
  case GPU_RENDER_PASS: wgpuRenderPassEncoderRelease(p); break;
  case GPU_COMPUTE_PASS: wgpuComputePassEncoderRelease(p); break;
  case GPU_COMMAND_BUFFER: wgpuCommandBufferRelease(p); break;
  default: break;
  }
  free_slot(s, id, r);
}

static void free_pending(struct GpuState *g) {
  while (g->pending) {
    Pending *p = g->pending;
    g->pending = p->next;
    free(p->message);
    free(p);
  }
}

void gpu_finalize(State *s) {
  if (!s->gpu)
    return;
  free_pending(s->gpu);
  free(s->gpu->free_ids);
  free(s->gpu);
  s->gpu = NULL;
}

bool gpu_window_has_surface(State *s, uint32_t window) {
  for (uint32_t i = 1; i <= s->count; i++)
    if (s->items[i - 1].kind == GPU_SURFACE && s->items[i - 1].parent == window)
      return true;
  return false;
}

void gpu_shutdown(State *s) {
  // Retain devices independently of public handles until pending callbacks
  // are drained. A program may release its last handle while a map is pending.
  if (s->gpu) {
    for (size_t i = 0; i < s->gpu->device_count; i++) {
      wgpuDevicePoll(s->gpu->devices[i], true, NULL);
      wgpuDeviceDestroy(s->gpu->devices[i]);
      wgpuDevicePoll(s->gpu->devices[i], true, NULL);
    }
  }
  for (uint32_t i = s->count; i >= 1; i--) {
    Resource *r = &s->items[i - 1];
    if (r->ptr && r->kind >= GPU_FIRST && r->kind <= GPU_LAST)
      destroy(s, i);
  }
  if (s->gpu) {
    for (size_t i = 0; i < s->gpu->device_count; i++) wgpuDeviceRelease(s->gpu->devices[i]);
    free(s->gpu->devices);
    s->gpu->devices = NULL;
    s->gpu->device_count = 0;
    free_pending(s->gpu);
    s->gpu->adapter = NULL;
  }
}

// ---- enum translation (veneer numbering -> wgpu-native) ---------------------
// The C veneer's webgpu.h defines its own self-consistent values; the NAME is
// the contract, so every table below is keyed by name. WGPU_MapEnum exposes
// them to tests, which cross-check both headers.

#define TEXTURE_FORMATS(X) \
  X(R8Unorm, 1) X(R8Snorm, 2) X(R8Uint, 3) X(R8Sint, 4) X(R16Uint, 5) \
  X(R16Sint, 6) X(R16Float, 7) X(RG8Unorm, 8) X(RG8Snorm, 9) X(RG8Uint, 10) \
  X(RG8Sint, 11) X(R32Float, 12) X(R32Uint, 13) X(R32Sint, 14) \
  X(RG16Uint, 15) X(RG16Sint, 16) X(RG16Float, 17) X(RGBA8Unorm, 18) \
  X(RGBA8UnormSrgb, 19) X(RGBA8Snorm, 20) X(RGBA8Uint, 21) X(RGBA8Sint, 22) \
  X(BGRA8Unorm, 23) X(BGRA8UnormSrgb, 24) X(RGB10A2Uint, 25) \
  X(RGB10A2Unorm, 26) X(RG11B10Ufloat, 27) X(RGB9E5Ufloat, 28) \
  X(RG32Float, 29) X(RG32Uint, 30) X(RG32Sint, 31) X(RGBA16Uint, 32) \
  X(RGBA16Sint, 33) X(RGBA16Float, 34) X(RGBA32Float, 35) X(RGBA32Uint, 36) \
  X(RGBA32Sint, 37) X(Stencil8, 38) X(Depth16Unorm, 40) X(Depth24Plus, 41) \
  X(Depth24PlusStencil8, 42) X(Depth32Float, 43) X(Depth32FloatStencil8, 44) \
  X(BC1RGBAUnorm, 100) X(BC1RGBAUnormSrgb, 101) X(BC2RGBAUnorm, 102) \
  X(BC2RGBAUnormSrgb, 103) X(BC3RGBAUnorm, 104) X(BC3RGBAUnormSrgb, 105) \
  X(BC4RUnorm, 106) X(BC4RSnorm, 107) X(BC5RGUnorm, 108) X(BC5RGSnorm, 109) \
  X(BC6HRGBUfloat, 110) X(BC6HRGBFloat, 111) X(BC7RGBAUnorm, 112) \
  X(BC7RGBAUnormSrgb, 113) X(ETC2RGB8Unorm, 114) X(ETC2RGB8UnormSrgb, 115) \
  X(ETC2RGB8A1Unorm, 116) X(ETC2RGB8A1UnormSrgb, 117) X(ETC2RGBA8Unorm, 118) \
  X(ETC2RGBA8UnormSrgb, 119) X(EACR11Unorm, 120) X(EACR11Snorm, 121) \
  X(EACRG11Unorm, 122) X(EACRG11Snorm, 123) X(ASTC4x4Unorm, 124) \
  X(ASTC4x4UnormSrgb, 125) X(ASTC5x4Unorm, 126) X(ASTC5x4UnormSrgb, 127) \
  X(ASTC5x5Unorm, 128) X(ASTC5x5UnormSrgb, 129) X(ASTC6x5Unorm, 130) \
  X(ASTC6x5UnormSrgb, 131) X(ASTC6x6Unorm, 132) X(ASTC6x6UnormSrgb, 133) \
  X(ASTC8x5Unorm, 134) X(ASTC8x5UnormSrgb, 135) X(ASTC8x6Unorm, 136) \
  X(ASTC8x6UnormSrgb, 137) X(ASTC8x8Unorm, 138) X(ASTC8x8UnormSrgb, 139) \
  X(ASTC10x5Unorm, 140) X(ASTC10x5UnormSrgb, 141) X(ASTC10x6Unorm, 142) \
  X(ASTC10x6UnormSrgb, 143) X(ASTC10x8Unorm, 144) X(ASTC10x8UnormSrgb, 145) \
  X(ASTC10x10Unorm, 146) X(ASTC10x10UnormSrgb, 147) X(ASTC12x10Unorm, 148) \
  X(ASTC12x10UnormSrgb, 149) X(ASTC12x12Unorm, 150) X(ASTC12x12UnormSrgb, 151)

#define VERTEX_FORMATS(X) \
  X(Float32, 1) X(Float32x2, 2) X(Float32x3, 3) X(Float32x4, 4) X(Uint32, 5) \
  X(Uint32x2, 6) X(Uint32x3, 7) X(Uint32x4, 8) X(Unorm8x4, 9) X(Uint8, 10) \
  X(Uint8x2, 11) X(Uint8x4, 12) X(Sint8, 13) X(Sint8x2, 14) X(Sint8x4, 15) \
  X(Unorm8, 16) X(Unorm8x2, 17) X(Snorm8, 18) X(Snorm8x2, 19) X(Snorm8x4, 20) \
  X(Uint16, 21) X(Uint16x2, 22) X(Uint16x4, 23) X(Sint16, 24) X(Sint16x2, 25) \
  X(Sint16x4, 26) X(Unorm16, 27) X(Unorm16x2, 28) X(Unorm16x4, 29) \
  X(Snorm16, 30) X(Snorm16x2, 31) X(Snorm16x4, 32) X(Float16, 33) \
  X(Float16x2, 34) X(Float16x4, 35) X(Sint32, 36) X(Sint32x2, 37) \
  X(Sint32x3, 38) X(Sint32x4, 39) X(Unorm10_10_10_2, 40) X(Unorm8x4BGRA, 41)

#define BLEND_FACTORS(X) \
  X(Zero, 0) X(One, 1) X(Src, 2) X(OneMinusSrc, 3) X(SrcAlpha, 4) \
  X(OneMinusSrcAlpha, 5) X(Dst, 6) X(OneMinusDst, 7) X(DstAlpha, 8) \
  X(OneMinusDstAlpha, 9)
#define BLEND_OPERATIONS(X) \
  X(Add, 1) X(Subtract, 2) X(ReverseSubtract, 3) X(Min, 4) X(Max, 5)
#define COMPARE_FUNCTIONS(X) \
  X(Never, 1) X(Less, 2) X(Equal, 3) X(LessEqual, 4) X(Greater, 5) \
  X(NotEqual, 6) X(GreaterEqual, 7) X(Always, 8)
#define STENCIL_OPERATIONS(X) \
  X(Keep, 1) X(Zero, 2) X(Replace, 3) X(Invert, 4) X(IncrementClamp, 5) \
  X(DecrementClamp, 6) X(IncrementWrap, 7) X(DecrementWrap, 8)
#define TOPOLOGIES(X) \
  X(PointList, 0) X(LineList, 1) X(LineStrip, 2) X(TriangleList, 3) \
  X(TriangleStrip, 4)
#define FRONT_FACES(X) X(CCW, 0) X(CW, 1)
#define CULL_MODES(X) X(None, 0) X(Front, 1) X(Back, 2)
#define INDEX_FORMATS(X) X(Uint16, 1) X(Uint32, 2)
#define LOAD_OPS(X) X(Clear, 1) X(Load, 2)
#define STORE_OPS(X) X(Store, 1) X(Discard, 2)
#define ADDRESS_MODES(X) X(ClampToEdge, 1) X(Repeat, 2) X(MirrorRepeat, 3)
#define FILTER_MODES(X) X(Nearest, 1) X(Linear, 2)
#define TEXTURE_DIMENSIONS(X) X(1D, 1) X(2D, 2) X(3D, 3)
#define VIEW_DIMENSIONS(X) \
  X(1D, 1) X(2D, 2) X(2DArray, 3) X(Cube, 4) X(CubeArray, 5) X(3D, 6)
#define ASPECTS(X) X(All, 1) X(StencilOnly, 2) X(DepthOnly, 3)
#define BUFFER_BINDING_TYPES(X) \
  X(Uniform, 1) X(Storage, 2) X(ReadOnlyStorage, 3)
#define SAMPLER_BINDING_TYPES(X) \
  X(Filtering, 1) X(NonFiltering, 2) X(Comparison, 3)
#define SAMPLE_TYPES(X) \
  X(Float, 1) X(UnfilterableFloat, 2) X(Depth, 3) X(Sint, 4) X(Uint, 5)
#define STORAGE_ACCESSES(X) X(WriteOnly, 1) X(ReadOnly, 2) X(ReadWrite, 3)
#define ALPHA_MODES(X) X(Auto, 0) X(Opaque, 1) X(Premultiplied, 2)
#define PRESENT_MODES(X) \
  X(Fifo, 1) X(FifoRelaxed, 2) X(Immediate, 3) X(Mailbox, 4)
#define ERROR_FILTERS(X) X(Validation, 1) X(OutOfMemory, 2) X(Internal, 3)
#define STEP_MODES(X) X(Vertex, 0) X(Instance, 1)

#define MAP_TO(fn, type, list, undefined_value) \
  static type fn(int v) { \
    switch (v) { \
    list(MAP_CASE_##type) \
    default: return undefined_value; \
    } \
  }
#define MAP_CASE_WGPUTextureFormat(n, o) case o: return WGPUTextureFormat_##n;
#define MAP_CASE_WGPUVertexFormat(n, o) case o: return WGPUVertexFormat_##n;
#define MAP_CASE_WGPUBlendFactor(n, o) case o: return WGPUBlendFactor_##n;
#define MAP_CASE_WGPUBlendOperation(n, o) case o: return WGPUBlendOperation_##n;
#define MAP_CASE_WGPUCompareFunction(n, o) case o: return WGPUCompareFunction_##n;
#define MAP_CASE_WGPUStencilOperation(n, o) case o: return WGPUStencilOperation_##n;
#define MAP_CASE_WGPUPrimitiveTopology(n, o) case o: return WGPUPrimitiveTopology_##n;
#define MAP_CASE_WGPUFrontFace(n, o) case o: return WGPUFrontFace_##n;
#define MAP_CASE_WGPUCullMode(n, o) case o: return WGPUCullMode_##n;
#define MAP_CASE_WGPUIndexFormat(n, o) case o: return WGPUIndexFormat_##n;
#define MAP_CASE_WGPULoadOp(n, o) case o: return WGPULoadOp_##n;
#define MAP_CASE_WGPUStoreOp(n, o) case o: return WGPUStoreOp_##n;
#define MAP_CASE_WGPUAddressMode(n, o) case o: return WGPUAddressMode_##n;
#define MAP_CASE_WGPUFilterMode(n, o) case o: return WGPUFilterMode_##n;
#define MAP_CASE_WGPUMipmapFilterMode(n, o) case o: return WGPUMipmapFilterMode_##n;
#define MAP_CASE_WGPUTextureDimension(n, o) case o: return WGPUTextureDimension_##n;
#define MAP_CASE_WGPUTextureViewDimension(n, o) case o: return WGPUTextureViewDimension_##n;
#define MAP_CASE_WGPUTextureAspect(n, o) case o: return WGPUTextureAspect_##n;
#define MAP_CASE_WGPUBufferBindingType(n, o) case o: return WGPUBufferBindingType_##n;
#define MAP_CASE_WGPUSamplerBindingType(n, o) case o: return WGPUSamplerBindingType_##n;
#define MAP_CASE_WGPUTextureSampleType(n, o) case o: return WGPUTextureSampleType_##n;
#define MAP_CASE_WGPUStorageTextureAccess(n, o) case o: return WGPUStorageTextureAccess_##n;
#define MAP_CASE_WGPUCompositeAlphaMode(n, o) case o: return WGPUCompositeAlphaMode_##n;
#define MAP_CASE_WGPUPresentMode(n, o) case o: return WGPUPresentMode_##n;
#define MAP_CASE_WGPUErrorFilter(n, o) case o: return WGPUErrorFilter_##n;
#define MAP_CASE_WGPUVertexStepMode(n, o) case o: return WGPUVertexStepMode_##n;

MAP_TO(texture_format, WGPUTextureFormat, TEXTURE_FORMATS, WGPUTextureFormat_Undefined)
MAP_TO(vertex_format, WGPUVertexFormat, VERTEX_FORMATS, WGPUVertexFormat_Force32)
MAP_TO(blend_factor, WGPUBlendFactor, BLEND_FACTORS, WGPUBlendFactor_Undefined)
MAP_TO(blend_operation, WGPUBlendOperation, BLEND_OPERATIONS, WGPUBlendOperation_Add)
MAP_TO(compare_function, WGPUCompareFunction, COMPARE_FUNCTIONS, WGPUCompareFunction_Undefined)
MAP_TO(stencil_operation, WGPUStencilOperation, STENCIL_OPERATIONS, WGPUStencilOperation_Keep)
MAP_TO(topology, WGPUPrimitiveTopology, TOPOLOGIES, WGPUPrimitiveTopology_Undefined)
MAP_TO(front_face, WGPUFrontFace, FRONT_FACES, WGPUFrontFace_Undefined)
MAP_TO(cull_mode, WGPUCullMode, CULL_MODES, WGPUCullMode_Undefined)
MAP_TO(index_format, WGPUIndexFormat, INDEX_FORMATS, WGPUIndexFormat_Undefined)
MAP_TO(load_op, WGPULoadOp, LOAD_OPS, WGPULoadOp_Undefined)
MAP_TO(store_op, WGPUStoreOp, STORE_OPS, WGPUStoreOp_Undefined)
MAP_TO(address_mode, WGPUAddressMode, ADDRESS_MODES, WGPUAddressMode_Undefined)
MAP_TO(filter_mode, WGPUFilterMode, FILTER_MODES, WGPUFilterMode_Undefined)
MAP_TO(mipmap_filter_mode, WGPUMipmapFilterMode, FILTER_MODES, WGPUMipmapFilterMode_Undefined)
MAP_TO(texture_dimension, WGPUTextureDimension, TEXTURE_DIMENSIONS, WGPUTextureDimension_Undefined)
MAP_TO(view_dimension, WGPUTextureViewDimension, VIEW_DIMENSIONS, WGPUTextureViewDimension_Undefined)
MAP_TO(aspect, WGPUTextureAspect, ASPECTS, WGPUTextureAspect_Undefined)
MAP_TO(buffer_binding_type, WGPUBufferBindingType, BUFFER_BINDING_TYPES, WGPUBufferBindingType_BindingNotUsed)
MAP_TO(sampler_binding_type, WGPUSamplerBindingType, SAMPLER_BINDING_TYPES, WGPUSamplerBindingType_BindingNotUsed)
MAP_TO(sample_type, WGPUTextureSampleType, SAMPLE_TYPES, WGPUTextureSampleType_BindingNotUsed)
MAP_TO(storage_access, WGPUStorageTextureAccess, STORAGE_ACCESSES, WGPUStorageTextureAccess_BindingNotUsed)
MAP_TO(alpha_mode, WGPUCompositeAlphaMode, ALPHA_MODES, WGPUCompositeAlphaMode_Auto)
MAP_TO(present_mode, WGPUPresentMode, PRESENT_MODES, WGPUPresentMode_Undefined)
MAP_TO(error_filter, WGPUErrorFilter, ERROR_FILTERS, WGPUErrorFilter_Validation)
MAP_TO(step_mode, WGPUVertexStepMode, STEP_MODES, WGPUVertexStepMode_Undefined)

// wgpu-native -> veneer texture format (surface capabilities). 0 = unknown.
static int texture_format_back(WGPUTextureFormat f) {
  switch (f) {
#define X(n, o) case WGPUTextureFormat_##n: return o;
    TEXTURE_FORMATS(X)
#undef X
  default: return 0;
  }
}

typedef struct {
  const char *name;
  int (*map)(int);
} EnumProbe;
#define PROBE(fn) static int probe_##fn(int v) { return (int)fn(v); }
PROBE(texture_format) PROBE(vertex_format) PROBE(blend_factor)
PROBE(blend_operation) PROBE(compare_function) PROBE(stencil_operation)
PROBE(topology) PROBE(front_face) PROBE(cull_mode) PROBE(index_format)
PROBE(load_op) PROBE(store_op) PROBE(address_mode) PROBE(filter_mode)
PROBE(mipmap_filter_mode) PROBE(texture_dimension) PROBE(view_dimension)
PROBE(aspect) PROBE(buffer_binding_type) PROBE(sampler_binding_type)
PROBE(sample_type) PROBE(storage_access) PROBE(alpha_mode) PROBE(present_mode)
PROBE(error_filter) PROBE(step_mode)
static const EnumProbe probes[] = {
    {"WGPUTextureFormat", probe_texture_format},
    {"WGPUVertexFormat", probe_vertex_format},
    {"WGPUBlendFactor", probe_blend_factor},
    {"WGPUBlendOperation", probe_blend_operation},
    {"WGPUCompareFunction", probe_compare_function},
    {"WGPUStencilOperation", probe_stencil_operation},
    {"WGPUPrimitiveTopology", probe_topology},
    {"WGPUFrontFace", probe_front_face},
    {"WGPUCullMode", probe_cull_mode},
    {"WGPUIndexFormat", probe_index_format},
    {"WGPULoadOp", probe_load_op},
    {"WGPUStoreOp", probe_store_op},
    {"WGPUAddressMode", probe_address_mode},
    {"WGPUFilterMode", probe_filter_mode},
    {"WGPUMipmapFilterMode", probe_mipmap_filter_mode},
    {"WGPUTextureDimension", probe_texture_dimension},
    {"WGPUTextureViewDimension", probe_view_dimension},
    {"WGPUTextureAspect", probe_aspect},
    {"WGPUBufferBindingType", probe_buffer_binding_type},
    {"WGPUSamplerBindingType", probe_sampler_binding_type},
    {"WGPUTextureSampleType", probe_sample_type},
    {"WGPUStorageTextureAccess", probe_storage_access},
    {"WGPUCompositeAlphaMode", probe_alpha_mode},
    {"WGPUPresentMode", probe_present_mode},
    {"WGPUErrorFilter", probe_error_filter},
    {"WGPUVertexStepMode", probe_step_mode},
};

// ---- callbacks --------------------------------------------------------------

static Pending *pending_new(State *s, int kind, int cb, int ud1, int ud2) {
  Pending *p = calloc(1, sizeof(*p));
  if (!p)
    return NULL;
  p->kind = kind;
  p->cb = cb;
  p->ud1 = ud1;
  p->ud2 = ud2;
  struct GpuState *g = gpu(s);
  p->next = g->pending;
  g->pending = p;
  return p;
}
static void pending_message(Pending *p, WGPUStringView m) {
  if (!m.data || !m.length)
    return;
  size_t n = m.length == WGPU_STRLEN ? strlen(m.data) : m.length;
  p->message = malloc(n + 1);
  if (!p->message)
    return;
  memcpy(p->message, m.data, n);
  p->message[n] = 0;
}
static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter adapter,
                       WGPUStringView message, void *ud1, void *ud2) {
  Pending *p = ud1;
  State *s = ud2;
  // Veneer statuses: Success 1, Unavailable 2, Error 3.
  p->status = status == WGPURequestAdapterStatus_Success ? 1
              : status == WGPURequestAdapterStatus_Unavailable ? 2 : 3;
  if (adapter) {
    p->handle = gpu_store(s, GPU_ADAPTER, adapter, 0);
    if (!p->handle) {
      wgpuAdapterRelease(adapter);
      p->status = 3;
    } else
      gpu(s)->adapter = adapter;
  }
  pending_message(p, message);
  p->done = true;
}

static void on_uncaptured_error(WGPUDevice const *device, WGPUErrorType type,
                                WGPUStringView message, void *ud1, void *ud2) {
  (void)device; (void)ud1; (void)ud2;
  fprintf(stderr, "WebGPU uncaptured error (%d): %.*s\n", (int)type,
          message.data ? (int)(message.length == WGPU_STRLEN ? strlen(message.data) : message.length) : 0,
          message.data ? message.data : "");
}
static void on_device_lost(WGPUDevice const *device, WGPUDeviceLostReason reason,
                           WGPUStringView message, void *ud1, void *ud2) {
  (void)device; (void)ud1; (void)ud2;
  if (reason == WGPUDeviceLostReason_Destroyed || reason == WGPUDeviceLostReason_CallbackCancelled)
    return;
  fprintf(stderr, "WebGPU device lost (%d): %.*s\n", (int)reason,
          message.data ? (int)(message.length == WGPU_STRLEN ? strlen(message.data) : message.length) : 0,
          message.data ? message.data : "");
}
static void on_log(WGPULogLevel level, WGPUStringView message, void *userdata) {
  (void)userdata;
  if (level > WGPULogLevel_Warn)
    return;
  fprintf(stderr, "wgpu %s: %.*s\n", level == WGPULogLevel_Error ? "error" : "warning",
          message.data ? (int)(message.length == WGPU_STRLEN ? strlen(message.data) : message.length) : 0,
          message.data ? message.data : "");
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice device,
                      WGPUStringView message, void *ud1, void *ud2) {
  Pending *p = ud1;
  State *s = ud2;
  p->status = status == WGPURequestDeviceStatus_Success ? 1 : 3;
  if (device) {
    struct GpuState *g = gpu(s);
    WGPUDevice *devices = realloc(g->devices, (g->device_count + 1) * sizeof(*devices));
    if (!devices) {
      wgpuDeviceRelease(device);
      p->status = 3;
      p->done = true;
      return;
    }
    g->devices = devices;
    wgpuDeviceAddRef(device);
    g->devices[g->device_count++] = device;
    p->handle = gpu_store(s, GPU_DEVICE, device, 0);
    if (!p->handle) {
      wgpuDeviceRelease(device);
      p->status = 3;
    }
  }
  pending_message(p, message);
  p->done = true;
}

static void on_map(WGPUMapAsyncStatus status, WGPUStringView message, void *ud1, void *ud2) {
  (void)ud2;
  Pending *p = ud1;
  p->status = status == WGPUMapAsyncStatus_Success ? 1
              : status == WGPUMapAsyncStatus_Aborted ? 4 : 3;
  if (p->buffer) {
    p->buffer->mapping = false;
    p->buffer->mapped = p->status == 1;
  }
  pending_message(p, message);
  p->done = true;
}

static void on_pop_error(WGPUPopErrorScopeStatus status, WGPUErrorType type,
                         WGPUStringView message, void *ud1, void *ud2) {
  (void)ud2;
  Pending *p = ud1;
  p->status = status == WGPUPopErrorScopeStatus_Success ? 1 : 3;
  p->type = (int)type ? (int)type : 5;
  pending_message(p, message);
  p->done = true;
}

// ---- surfaces ---------------------------------------------------------------

static GpuSurface *create_surface(State *s, WGPUInstance instance, Resource *w,
                                  const char **err) {
  GpuSurface *sf = calloc(1, sizeof(*sf));
  if (!sf) {
    *err = "Out of memory";
    return NULL;
  }
  WGPUSurfaceDescriptor d = WGPU_SURFACE_DESCRIPTOR_INIT;
#ifdef __APPLE__
  sf->view = SDL_Metal_CreateView(w->ptr);
  if (!sf->view) {
    *err = SDL_GetError();
    free(sf);
    return NULL;
  }
  WGPUSurfaceSourceMetalLayer src = WGPU_SURFACE_SOURCE_METAL_LAYER_INIT;
  src.layer = SDL_Metal_GetLayer(sf->view);
  d.nextInChain = &src.chain;
  sf->surface = wgpuInstanceCreateSurface(instance, &d);
#elif defined(__linux__)
  SDL_PropertiesID props = SDL_GetWindowProperties(w->ptr);
  const char *driver = SDL_GetCurrentVideoDriver();
  WGPUSurfaceSourceWaylandSurface wl = WGPU_SURFACE_SOURCE_WAYLAND_SURFACE_INIT;
  WGPUSurfaceSourceXlibWindow x11 = WGPU_SURFACE_SOURCE_XLIB_WINDOW_INIT;
  if (driver && strcmp(driver, "wayland") == 0) {
    wl.display = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WAYLAND_DISPLAY_POINTER, NULL);
    wl.surface = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WAYLAND_SURFACE_POINTER, NULL);
    d.nextInChain = &wl.chain;
  } else if (driver && strcmp(driver, "x11") == 0) {
    x11.display = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, NULL);
    x11.window = (uint64_t)SDL_GetNumberProperty(props, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0);
    d.nextInChain = &x11.chain;
  } else {
    *err = "WebGPU surfaces need the x11 or wayland video driver";
    free(sf);
    return NULL;
  }
  sf->surface = wgpuInstanceCreateSurface(instance, &d);
#else
  (void)instance;
  (void)w;
  *err = "WebGPU surfaces are not implemented on this platform";
  free(sf);
  return NULL;
#endif
  if (!sf->surface) {
    *err = "wgpuInstanceCreateSurface failed";
#ifdef __APPLE__
    SDL_Metal_DestroyView(sf->view);
#endif
    free(sf);
    return NULL;
  }
  (void)s;
  return sf;
}

// Drop the surface texture handed out by the previous frame when the program
// did not release it itself (browser code never has to).
static void retire_current(State *s, GpuSurface *sf) {
  if (!sf->current)
    return;
  uint32_t id = sf->current_handle;
  if (id && id <= s->count && s->items[id - 1].kind == GPU_TEXTURE &&
      s->items[id - 1].ptr == sf->current)
    destroy(s, id);
  sf->current = NULL;
  sf->current_handle = 0;
}

static int preferred_format(State *s, GpuSurface *sf) {
  struct GpuState *g = gpu(s);
  int out = 23; // BGRA8Unorm
  if (!g || !g->adapter)
    return out;
  WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
  if (wgpuSurfaceGetCapabilities(sf->surface, g->adapter, &caps) != WGPUStatus_Success)
    return out;
  for (size_t i = 0; i < caps.formatCount; i++) {
    int f = texture_format_back(caps.formats[i]);
    if (f) {
      out = f;
      break;
    }
  }
  wgpuSurfaceCapabilitiesFreeMembers(caps);
  return out;
}

// ---- argument helpers -------------------------------------------------------

#define N(i) num(env, v[i])
#define I(i) ((int)N(i))
#define U(i) ((uint32_t)N(i))
#define F(i) N(i)
#define GPU_AT(name, i, kind) \
  Resource *name = resource(env, s, U(i), kind); \
  if (!name) \
    return NULL
#define OPT_AT(name, i, kind) \
  Resource *name = U(i) ? resource(env, s, U(i), kind) : NULL; \
  if (U(i) && !name) \
    return NULL
#define PTR(r) ((r) ? (r)->ptr : NULL)
#define BUFFER_OF(r) ((r) ? ((GpuBuffer *)(r)->ptr)->buffer : NULL)
#define BUF(i, var, len) \
  void *var; \
  size_t len; \
  napi_get_buffer_info(env, v[i], &var, &len)
#define INTS(i, var, count) \
  BUF(i, var##_raw, var##_len); \
  if (var##_len % 4 || (uintptr_t)var##_raw % _Alignof(int32_t)) \
    return error(env, "Invalid packed integer buffer alignment or length"); \
  const int32_t *var = var##_raw; \
  size_t count = var##_len / 4
#define HANDLE_RESULT(kind, ptr, parent) \
  do { \
    void *p_ = (ptr); \
    if (!p_) \
      return number(env, 0); \
    uint32_t h_ = gpu_store(s, kind, p_, parent); \
    if (!h_) { \
      Resource tmp_ = {p_, kind, 0}; \
      gpu_destroy(s, 0, &tmp_); \
      return error(env, "Out of memory"); \
    } \
    return number(env, h_); \
  } while (0)

static WGPUStringView sv(const char *data, size_t length) {
  WGPUStringView r = {data, length};
  return r;
}
static WGPUStringView sv_optional(const char *data) {
  return data && *data ? sv(data, strlen(data)) : sv(NULL, 0);
}

// Packed [count][keys...] constants: keys arrive NUL separated, values as f64.
static size_t unpack_constants(napi_env env, napi_value keys, napi_value vals,
                               WGPUConstantEntry **out) {
  void *kdata, *vdata;
  size_t klen, vlen;
  napi_get_buffer_info(env, keys, &kdata, &klen);
  napi_get_buffer_info(env, vals, &vdata, &vlen);
  size_t count = vlen / 8;
  *out = NULL;
  if (!count)
    return 0;
  WGPUConstantEntry *e = calloc(count, sizeof(*e));
  if (!e)
    return 0;
  const char *k = kdata, *end = k + klen;
  const char *d = vdata;
  size_t n = 0;
  for (; n < count && k < end; n++) {
    size_t len = strnlen(k, (size_t)(end - k));
    e[n] = (WGPUConstantEntry)WGPU_CONSTANT_ENTRY_INIT;
    e[n].key = sv(k, len);
    memcpy(&e[n].value, d + n * sizeof(double), sizeof(double));
    k += len;
    if (k < end) k++;
  }
  *out = e;
  return n;
}

// ---- dispatch ---------------------------------------------------------------

static napi_value gpu_dispatch(napi_env env, napi_callback_info info) {
  napi_value v[32];
  size_t argc = 32;
  void *data;
  napi_get_cb_info(env, info, &argc, v, NULL, &data);
  GpuOp op = (GpuOp)(uintptr_t)data;
  State *s;
  napi_get_instance_data(env, (void **)&s);
  const char *sig = gpu_signatures[op];
  if (argc != strlen(sig)) {
    napi_throw_type_error(env, NULL, "Incorrect WebGPU argument count");
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
      valid = n == n && n - n == 0; // finite
      if (sig[i] != 'f')
        valid = valid && n >= (sig[i] == 'u' ? 0 : -2147483648.0) &&
                n <= (sig[i] == 'u' ? 4294967295.0 : 2147483647.0) &&
                (double)(int64_t)n == n;
    }
    if (!valid) {
      napi_throw_type_error(env, NULL, "Invalid WebGPU argument type or numeric range");
      return NULL;
    }
  }
  struct GpuState *g = gpu(s);
  if (!g)
    return error(env, "Out of memory");
  if (!g->log_set) {
    wgpuSetLogCallback(on_log, NULL);
    wgpuSetLogLevel(WGPULogLevel_Warn);
    g->log_set = true;
  }
  switch (op) {
  case OP_WGPU_CreateInstance: {
    WGPUInstanceDescriptor d = WGPU_INSTANCE_DESCRIPTOR_INIT;
    HANDLE_RESULT(GPU_INSTANCE, wgpuCreateInstance(&d), 0);
  }
  case OP_WGPU_InstanceCreateSurface: {
    GPU_AT(inst, 0, GPU_INSTANCE);
    uint32_t window = U(1);
    if (!window) // handle-less wgpuInstanceCreateSurface: newest live window
      for (uint32_t i = s->count; i >= 1; i--)
        if (s->items[i - 1].kind == WINDOW) {
          window = i;
          break;
        }
    if (!window)
      return error(env, "WebGPU surface needs an SDL window");
    Resource *w = resource(env, s, window, WINDOW);
    if (!w)
      return NULL;
    if (gpu_window_has_surface(s, window))
      return error(env, "Window already has a WebGPU surface");
    for (uint32_t i = 1; i <= s->count; i++)
      if (s->items[i - 1].kind == RENDERER && s->items[i - 1].parent == window)
        return error(env, "Window already presents through an SDL_Renderer");
    if (SDL_WindowHasSurface(w->ptr))
      return error(env, "Window already presents through SDL_UpdateWindowSurface");
    const char *err = "";
    GpuSurface *sf = create_surface(s, inst->ptr, w, &err);
    if (!sf)
      return error(env, err);
    uint32_t h = gpu_store(s, GPU_SURFACE, sf, window);
    if (!h) {
      destroy_surface(sf);
      return error(env, "Out of memory");
    }
    return number(env, h);
  }
  case OP_WGPU_InstanceRequestAdapter: {
    GPU_AT(inst, 0, GPU_INSTANCE);
    Pending *p = pending_new(s, CB_ADAPTER, I(1), I(2), I(3));
    if (!p)
      return error(env, "Out of memory");
    WGPURequestAdapterCallbackInfo cb = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    cb.mode = WGPUCallbackMode_AllowProcessEvents;
    cb.callback = on_adapter;
    cb.userdata1 = p;
    cb.userdata2 = s;
    WGPURequestAdapterOptions o = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    wgpuInstanceRequestAdapter(inst->ptr, &o, cb);
    return undefined(env);
  }
  case OP_WGPU_AdapterRequestDevice: {
    GPU_AT(ad, 0, GPU_ADAPTER);
    Pending *p = pending_new(s, CB_DEVICE, I(1), I(2), I(3));
    if (!p)
      return error(env, "Out of memory");
    WGPURequestDeviceCallbackInfo cb = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    cb.mode = WGPUCallbackMode_AllowProcessEvents;
    cb.callback = on_device;
    cb.userdata1 = p;
    cb.userdata2 = s;
    WGPUDeviceDescriptor d = WGPU_DEVICE_DESCRIPTOR_INIT;
    d.uncapturedErrorCallbackInfo.callback = on_uncaptured_error;
    d.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    d.deviceLostCallbackInfo.callback = on_device_lost;
    wgpuAdapterRequestDevice(ad->ptr, &d, cb);
    return undefined(env);
  }
  case OP_WGPU_ProcessEvents: {
    for (size_t i = 0; i < g->device_count; i++)
      wgpuDevicePoll(g->devices[i], false, NULL);
    for (uint32_t i = 1; i <= s->count; i++) {
      if (s->items[i - 1].kind == GPU_INSTANCE)
        wgpuInstanceProcessEvents(s->items[i - 1].ptr);
    }
    napi_value out;
    napi_create_array(env, &out);
    uint32_t n = 0;
    // Deliver in submission order: the list is newest-first, so collect
    // the completed records into a temporary reversed chain.
    Pending *done = NULL, **link = &g->pending;
    while (*link) {
      Pending *p = *link;
      if (p->done) {
        *link = p->next;
        p->next = done;
        done = p;
      } else
        link = &p->next;
    }
    while (done) {
      Pending *p = done;
      done = p->next;
      napi_value o;
      napi_create_object(env, &o);
      napi_set_named_property(env, o, "kind", number(env, p->kind));
      napi_set_named_property(env, o, "cb", number(env, p->cb));
      napi_set_named_property(env, o, "ud1", number(env, p->ud1));
      napi_set_named_property(env, o, "ud2", number(env, p->ud2));
      napi_set_named_property(env, o, "status", number(env, p->status));
      napi_set_named_property(env, o, "type", number(env, p->type));
      napi_set_named_property(env, o, "handle", number(env, p->handle));
      if (p->message)
        napi_set_named_property(env, o, "message", string(env, p->message));
      napi_set_element(env, out, n++, o);
      free(p->message);
      free(p);
    }
    return out;
  }
  case OP_WGPU_DevicePoll: {
    GPU_AT(dev, 0, GPU_DEVICE);
    return boolean(env, wgpuDevicePoll(dev->ptr, I(1) != 0, NULL));
  }
  case OP_WGPU_DeviceGetQueue: {
    GPU_AT(dev, 0, GPU_DEVICE);
    HANDLE_RESULT(GPU_QUEUE, wgpuDeviceGetQueue(dev->ptr), 0);
  }
  case OP_WGPU_SurfaceGetPreferredFormat: {
    GPU_AT(sf, 0, GPU_SURFACE);
    return number(env, preferred_format(s, sf->ptr));
  }
  case OP_WGPU_SurfaceConfigure: {
    GPU_AT(sfr, 0, GPU_SURFACE);
    GPU_AT(dev, 1, GPU_DEVICE);
    GpuSurface *sf = sfr->ptr;
    INTS(8, vf, vfn);
    WGPUSurfaceConfiguration c = WGPU_SURFACE_CONFIGURATION_INIT;
    c.device = dev->ptr;
    c.format = I(2) ? texture_format(I(2)) : texture_format(preferred_format(s, sf));
    if (c.format == WGPUTextureFormat_Undefined)
      return error(env, "wgpuSurfaceConfigure: unsupported texture format");
    c.usage = (WGPUTextureUsage)U(3) | WGPUTextureUsage_RenderAttachment;
    c.width = (uint32_t)I(4);
    c.height = (uint32_t)I(5);
    if (!c.width || !c.height) {
      Resource *w = resource(env, s, sfr->parent, WINDOW);
      if (!w)
        return NULL;
      int pw = 0, ph = 0;
      SDL_GetWindowSizeInPixels(w->ptr, &pw, &ph);
      c.width = (uint32_t)pw;
      c.height = (uint32_t)ph;
    }
    c.alphaMode = alpha_mode(I(6));
    c.presentMode = I(7) ? present_mode(I(7)) : WGPUPresentMode_Fifo;
    WGPUTextureFormat formats[16];
    size_t count = vfn && vf[0] > 0 ? (size_t)vf[0] : 0;
    if (count > 16 || count + 1 > vfn)
      return error(env, "wgpuSurfaceConfigure: bad viewFormats");
    for (size_t i = 0; i < count; i++)
      formats[i] = texture_format(vf[1 + i]);
    c.viewFormatCount = count;
    c.viewFormats = formats;
    retire_current(s, sf);
    wgpuSurfaceConfigure(sf->surface, &c);
    sf->configured = true;
    return undefined(env);
  }
  case OP_WGPU_SurfaceGetCurrentTexture: {
    GPU_AT(sfr, 0, GPU_SURFACE);
    GpuSurface *sf = sfr->ptr;
    if (!sf->configured)
      return error(env, "wgpuSurfaceGetCurrentTexture: surface not configured");
    retire_current(s, sf);
    WGPUSurfaceTexture st = WGPU_SURFACE_TEXTURE_INIT;
    wgpuSurfaceGetCurrentTexture(sf->surface, &st);
    if (st.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
        st.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
      if (st.texture)
        wgpuTextureRelease(st.texture);
      if ((int)st.status != WGPUSurfaceGetCurrentTextureStatus_Occluded &&
          st.status != WGPUSurfaceGetCurrentTextureStatus_Timeout)
        fprintf(stderr, "wgpuSurfaceGetCurrentTexture failed (status %d)\n", (int)st.status);
      return number(env, 0);
    }
    uint32_t h = gpu_store(s, GPU_TEXTURE, st.texture, U(0));
    if (!h) {
      wgpuTextureRelease(st.texture);
      return error(env, "Out of memory");
    }
    sf->current = st.texture;
    sf->current_handle = h;
    return number(env, h);
  }
  case OP_WGPU_SurfacePresent: {
    GPU_AT(sfr, 0, GPU_SURFACE);
    GpuSurface *sf = sfr->ptr;
    if (!sf->current)
      return error(env, "wgpuSurfacePresent: no current surface texture");
    WGPUStatus st = wgpuSurfacePresent(sf->surface);
    // Present consumes the drawable, not the caller's texture reference.
    sf->current = NULL;
    sf->current_handle = 0;
    return boolean(env, st == WGPUStatus_Success);
  }
  case OP_WGPU_TextureCreateView: {
    GPU_AT(t, 0, GPU_TEXTURE);
    bool any = I(1) || I(2) || U(3) || U(4) || U(5) || U(6) || I(7);
    WGPUTextureViewDescriptor d = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    if (I(1)) {
      d.format = texture_format(I(1));
      if (d.format == WGPUTextureFormat_Undefined)
        return error(env, "wgpuTextureCreateView: unsupported format");
    }
    d.dimension = view_dimension(I(2));
    d.baseMipLevel = U(3);
    if (U(4))
      d.mipLevelCount = U(4);
    d.baseArrayLayer = U(5);
    if (U(6))
      d.arrayLayerCount = U(6);
    d.aspect = aspect(I(7));
    HANDLE_RESULT(GPU_TEXTURE_VIEW, wgpuTextureCreateView(t->ptr, any ? &d : NULL), 0);
  }
  case OP_WGPU_DeviceCreateShaderModuleWGSL: {
    GPU_AT(dev, 0, GPU_DEVICE);
    BUF(1, code, len);
    WGPUShaderSourceWGSL src = WGPU_SHADER_SOURCE_WGSL_INIT;
    src.code = sv(code, len);
    WGPUShaderModuleDescriptor d = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    d.nextInChain = &src.chain;
    HANDLE_RESULT(GPU_SHADER_MODULE, wgpuDeviceCreateShaderModule(dev->ptr, &d), 0);
  }
  case OP_WGPU_DeviceCreateRenderPipeline: {
    GPU_AT(dev, 0, GPU_DEVICE);
    GPU_AT(vs, 1, GPU_SHADER_MODULE);
    OPT_AT(fs, 3, GPU_SHADER_MODULE);
    OPT_AT(layout, 11, GPU_PIPELINE_LAYOUT);
    char *vsEntry = str(env, v[2]), *fsEntry = str(env, v[4]);
    if (!vsEntry || !fsEntry) {
      free(vsEntry);
      free(fsEntry);
      return NULL;
    }
    napi_value result = NULL;
    const char *err = NULL;
    WGPUVertexBufferLayout *buffers = NULL;
    WGPUVertexAttribute *attrs = NULL;
    WGPUColorTargetState *targets = NULL;
    WGPUBlendState *blends = NULL;
    WGPUConstantEntry *vsc = NULL, *fsc = NULL;

    WGPURenderPipelineDescriptor d = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    d.layout = PTR(layout);
    d.vertex.module = vs->ptr;
    d.vertex.entryPoint = sv_optional(vsEntry);
    d.vertex.constantCount = unpack_constants(env, v[23], v[24], &vsc);
    d.vertex.constants = vsc;
    d.primitive.topology = topology(I(6));
    if (d.primitive.topology == WGPUPrimitiveTopology_Undefined)
      err = "wgpuDeviceCreateRenderPipeline: unsupported topology";
    d.primitive.stripIndexFormat = index_format(I(7));
    d.primitive.cullMode = cull_mode(I(8));
    d.primitive.frontFace = front_face(I(9));

    // Vertex layout: [ bufferCount, per buffer: arrayStride, stepMode,
    // attrCount, per attr: format, byteOffset, shaderLocation ].
    INTS(10, vb, vbn);
    size_t i = 1;
    size_t bufferCount = vbn && vb[0] > 0 ? (size_t)vb[0] : 0;
    if (bufferCount) {
      size_t attrTotal = 0;
      size_t j = i;
      for (size_t b = 0; b < bufferCount && !err; b++) {
        if (j + 3 > vbn) { err = "vertex layout truncated"; break; }
        int ac = vb[j + 2];
        if (ac < 0 || j + 3 + (size_t)ac * 3 > vbn) { err = "vertex layout truncated"; break; }
        attrTotal += (size_t)ac;
        j += 3 + (size_t)ac * 3;
      }
      if (!err) {
        buffers = calloc(bufferCount, sizeof(*buffers));
        attrs = calloc(attrTotal ? attrTotal : 1, sizeof(*attrs));
        if (!buffers || !attrs)
          err = "Out of memory";
      }
      size_t a = 0;
      for (size_t b = 0; b < bufferCount && !err; b++) {
        buffers[b] = (WGPUVertexBufferLayout)WGPU_VERTEX_BUFFER_LAYOUT_INIT;
        buffers[b].arrayStride = (uint64_t)(uint32_t)vb[i++];
        buffers[b].stepMode = step_mode(vb[i++]);
        int ac = vb[i++];
        buffers[b].attributeCount = (size_t)ac;
        buffers[b].attributes = &attrs[a];
        for (int k = 0; k < ac; k++) {
          attrs[a] = (WGPUVertexAttribute)WGPU_VERTEX_ATTRIBUTE_INIT;
          attrs[a].format = vertex_format(vb[i++]);
          if (attrs[a].format == WGPUVertexFormat_Force32)
            err = "wgpuDeviceCreateRenderPipeline: unsupported WGPUVertexFormat";
          attrs[a].offset = (uint64_t)(uint32_t)vb[i++];
          attrs[a].shaderLocation = (uint32_t)vb[i++];
          a++;
        }
      }
      d.vertex.bufferCount = bufferCount;
      d.vertex.buffers = buffers;
    }

    // Color targets: [ targetCount, per target: format, writeMask,
    // blendEnabled, colorOp, colorSrc, colorDst, alphaOp, alphaSrc, alphaDst ].
    WGPUFragmentState frag = WGPU_FRAGMENT_STATE_INIT;
    if (fs && !err) {
      INTS(5, ct, ctn);
      size_t tc = ctn && ct[0] > 0 ? (size_t)ct[0] : 0;
      if (1 + tc * 9 > ctn)
        err = "color targets truncated";
      else {
        targets = calloc(tc ? tc : 1, sizeof(*targets));
        blends = calloc(tc ? tc : 1, sizeof(*blends));
        if (!targets || !blends)
          err = "Out of memory";
      }
      size_t k = 1;
      for (size_t t = 0; t < tc && !err; t++) {
        targets[t] = (WGPUColorTargetState)WGPU_COLOR_TARGET_STATE_INIT;
        int fmt = ct[k++];
        targets[t].format = fmt ? texture_format(fmt) : texture_format(23);
        if (targets[t].format == WGPUTextureFormat_Undefined)
          err = "wgpuDeviceCreateRenderPipeline: unsupported color target format";
        targets[t].writeMask = (WGPUColorWriteMask)(uint32_t)ct[k++];
        int enabled = ct[k++];
        blends[t].color.operation = blend_operation(ct[k++]);
        blends[t].color.srcFactor = blend_factor(ct[k++]);
        blends[t].color.dstFactor = blend_factor(ct[k++]);
        blends[t].alpha.operation = blend_operation(ct[k++]);
        blends[t].alpha.srcFactor = blend_factor(ct[k++]);
        blends[t].alpha.dstFactor = blend_factor(ct[k++]);
        if (enabled)
          targets[t].blend = &blends[t];
      }
      frag.module = fs->ptr;
      frag.entryPoint = sv_optional(fsEntry);
      frag.constantCount = unpack_constants(env, v[25], v[26], &fsc);
      frag.constants = fsc;
      frag.targetCount = tc;
      frag.targets = targets;
      d.fragment = &frag;
    }

    WGPUDepthStencilState ds = WGPU_DEPTH_STENCIL_STATE_INIT;
    if (I(12) && !err) {
      ds.format = texture_format(I(13));
      if (ds.format == WGPUTextureFormat_Undefined)
        err = "wgpuDeviceCreateRenderPipeline: unsupported depthStencil format";
      ds.depthWriteEnabled = I(14) ? WGPUOptionalBool_True : WGPUOptionalBool_False;
      ds.depthCompare = I(15) ? compare_function(I(15)) : WGPUCompareFunction_Always;
      ds.depthBias = I(16);
      ds.depthBiasSlopeScale = (float)F(17);
      ds.depthBiasClamp = (float)F(18);
      // Stencil: [ frontCompare, frontFail, frontDepthFail, frontPass,
      // backCompare, backFail, backDepthFail, backPass, readMask, writeMask ].
      INTS(19, st, stn);
      ds.stencilFront.compare = ds.stencilBack.compare = WGPUCompareFunction_Always;
      ds.stencilFront.failOp = ds.stencilFront.depthFailOp = ds.stencilFront.passOp = WGPUStencilOperation_Keep;
      ds.stencilBack = ds.stencilFront;
      if (stn >= 10) {
        ds.stencilFront.compare = st[0] ? compare_function(st[0]) : WGPUCompareFunction_Always;
        ds.stencilFront.failOp = stencil_operation(st[1]);
        ds.stencilFront.depthFailOp = stencil_operation(st[2]);
        ds.stencilFront.passOp = stencil_operation(st[3]);
        ds.stencilBack.compare = st[4] ? compare_function(st[4]) : WGPUCompareFunction_Always;
        ds.stencilBack.failOp = stencil_operation(st[5]);
        ds.stencilBack.depthFailOp = stencil_operation(st[6]);
        ds.stencilBack.passOp = stencil_operation(st[7]);
        ds.stencilReadMask = (uint32_t)st[8];
        ds.stencilWriteMask = (uint32_t)st[9];
      }
      d.depthStencil = &ds;
    }
    d.multisample.count = I(20) > 0 ? (uint32_t)I(20) : 1;
    d.multisample.mask = U(21) ? U(21) : 0xFFFFFFFFu;
    d.multisample.alphaToCoverageEnabled = I(22) != 0;

    if (err)
      result = error(env, err);
    else {
      WGPURenderPipeline p = wgpuDeviceCreateRenderPipeline(dev->ptr, &d);
      uint32_t h = gpu_store(s, GPU_RENDER_PIPELINE, p, 0);
      if (p && !h) {
        wgpuRenderPipelineRelease(p);
        result = error(env, "Out of memory");
      } else
        result = number(env, h);
    }
    free(vsEntry);
    free(fsEntry);
    free(buffers);
    free(attrs);
    free(targets);
    free(blends);
    free(vsc);
    free(fsc);
    return result;
  }
  case OP_WGPU_DeviceCreateBuffer: {
    GPU_AT(dev, 0, GPU_DEVICE);
    WGPUBufferDescriptor d = WGPU_BUFFER_DESCRIPTOR_INIT;
    d.size = U(1);
    d.usage = (WGPUBufferUsage)U(2);
    d.mappedAtCreation = I(3) != 0;
    GpuBuffer *b = calloc(1, sizeof(*b));
    if (!b)
      return error(env, "Out of memory");
    b->buffer = wgpuDeviceCreateBuffer(dev->ptr, &d);
    if (!b->buffer) {
      free(b);
      return number(env, 0);
    }
    b->mapped = d.mappedAtCreation;
    b->writable = d.mappedAtCreation;
    b->size = d.size;
    HANDLE_RESULT(GPU_BUFFER, b, 0);
  }
  case OP_WGPU_QueueWriteBuffer: {
    GPU_AT(q, 0, GPU_QUEUE);
    GPU_AT(b, 1, GPU_BUFFER);
    BUF(3, data, len);
    wgpuQueueWriteBuffer(q->ptr, BUFFER_OF(b), U(2), data, len);
    return undefined(env);
  }
  case OP_WGPU_RenderPassSetVertexBuffer: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    OPT_AT(b, 2, GPU_BUFFER);
    wgpuRenderPassEncoderSetVertexBuffer(p->ptr, U(1), BUFFER_OF(b), U(3), I(4) < 0 ? WGPU_WHOLE_SIZE : (uint64_t)I(4));
    return undefined(env);
  }
  case OP_WGPU_RenderPassSetIndexBuffer: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    GPU_AT(b, 1, GPU_BUFFER);
    WGPUIndexFormat f = index_format(I(2));
    if (f == WGPUIndexFormat_Undefined)
      return error(env, "wgpuRenderPassEncoderSetIndexBuffer: unsupported index format");
    wgpuRenderPassEncoderSetIndexBuffer(p->ptr, BUFFER_OF(b), f, U(3), I(4) < 0 ? WGPU_WHOLE_SIZE : (uint64_t)I(4));
    return undefined(env);
  }
  case OP_WGPU_RenderPassDrawIndexed: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    wgpuRenderPassEncoderDrawIndexed(p->ptr, U(1), U(2), U(3), I(4), U(5));
    return undefined(env);
  }
  case OP_WGPU_DeviceCreateBindGroupLayout: {
    GPU_AT(dev, 0, GPU_DEVICE);
    // [ entryCount, per entry: binding, visibility, kind, detail, e0, e1, e2 ]
    INTS(1, a, an);
    size_t count = an && a[0] > 0 ? (size_t)a[0] : 0;
    if (1 + count * 7 > an)
      return error(env, "wgpuDeviceCreateBindGroupLayout: packed entries truncated");
    WGPUBindGroupLayoutEntry *entries = calloc(count ? count : 1, sizeof(*entries));
    if (!entries)
      return error(env, "Out of memory");
    const char *err = NULL;
    size_t i = 1;
    for (size_t e = 0; e < count && !err; e++) {
      WGPUBindGroupLayoutEntry *E = &entries[e];
      *E = (WGPUBindGroupLayoutEntry)WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT;
      E->buffer.type = WGPUBufferBindingType_BindingNotUsed;
      E->sampler.type = WGPUSamplerBindingType_BindingNotUsed;
      E->texture.sampleType = WGPUTextureSampleType_BindingNotUsed;
      E->storageTexture.access = WGPUStorageTextureAccess_BindingNotUsed;
      E->binding = (uint32_t)a[i++];
      E->visibility = (WGPUShaderStage)(uint32_t)a[i++];
      int kind = a[i++], detail = a[i++], e0 = a[i++], e1 = a[i++];
      i++; // e2 reserved
      if (kind == 0) {
        E->buffer.type = buffer_binding_type(detail);
        if (E->buffer.type == WGPUBufferBindingType_BindingNotUsed)
          err = "createBindGroupLayout: unsupported buffer binding type";
        E->buffer.hasDynamicOffset = e0 != 0;
      } else if (kind == 1) {
        E->sampler.type = sampler_binding_type(detail);
        if (E->sampler.type == WGPUSamplerBindingType_BindingNotUsed)
          err = "createBindGroupLayout: unsupported sampler binding type";
      } else if (kind == 2) {
        E->texture.sampleType = sample_type(detail);
        if (E->texture.sampleType == WGPUTextureSampleType_BindingNotUsed)
          err = "createBindGroupLayout: unsupported texture sample type";
        E->texture.viewDimension = e0 ? view_dimension(e0) : WGPUTextureViewDimension_2D;
        E->texture.multisampled = e1 != 0;
      } else if (kind == 3) {
        E->storageTexture.access = storage_access(detail);
        E->storageTexture.format = texture_format(e0);
        if (E->storageTexture.access == WGPUStorageTextureAccess_BindingNotUsed ||
            E->storageTexture.format == WGPUTextureFormat_Undefined)
          err = "createBindGroupLayout: unsupported storage texture entry";
        E->storageTexture.viewDimension = e1 ? view_dimension(e1) : WGPUTextureViewDimension_2D;
      } else
        err = "createBindGroupLayout: unknown entry kind";
    }
    if (err) {
      free(entries);
      return error(env, err);
    }
    WGPUBindGroupLayoutDescriptor d = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
    d.entryCount = count;
    d.entries = entries;
    WGPUBindGroupLayout p = wgpuDeviceCreateBindGroupLayout(dev->ptr, &d);
    free(entries);
    HANDLE_RESULT(GPU_BIND_GROUP_LAYOUT, p, 0);
  }
  case OP_WGPU_DeviceCreatePipelineLayout: {
    GPU_AT(dev, 0, GPU_DEVICE);
    INTS(1, a, an);
    WGPUBindGroupLayout layouts[64];
    if (an > 64)
      return error(env, "wgpuDeviceCreatePipelineLayout: too many bind group layouts");
    for (size_t i = 0; i < an; i++) {
      Resource *r = resource(env, s, (uint32_t)a[i], GPU_BIND_GROUP_LAYOUT);
      if (!r)
        return NULL;
      layouts[i] = r->ptr;
    }
    WGPUPipelineLayoutDescriptor d = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
    d.bindGroupLayoutCount = an;
    d.bindGroupLayouts = layouts;
    HANDLE_RESULT(GPU_PIPELINE_LAYOUT, wgpuDeviceCreatePipelineLayout(dev->ptr, &d), 0);
  }
  case OP_WGPU_DeviceCreateBindGroup: {
    GPU_AT(dev, 0, GPU_DEVICE);
    GPU_AT(layout, 1, GPU_BIND_GROUP_LAYOUT);
    // [ entryCount, per entry: binding, kind, handle, offset, size ]
    INTS(2, a, an);
    size_t count = an && a[0] > 0 ? (size_t)a[0] : 0;
    if (1 + count * 5 > an)
      return error(env, "wgpuDeviceCreateBindGroup: packed entries truncated");
    WGPUBindGroupEntry *entries = calloc(count ? count : 1, sizeof(*entries));
    if (!entries)
      return error(env, "Out of memory");
    size_t i = 1;
    for (size_t e = 0; e < count; e++) {
      WGPUBindGroupEntry *E = &entries[e];
      *E = (WGPUBindGroupEntry)WGPU_BIND_GROUP_ENTRY_INIT;
      E->binding = (uint32_t)a[i++];
      int kind = a[i++];
      uint32_t handle = (uint32_t)a[i++];
      uint32_t offset = (uint32_t)a[i++];
      int size = a[i++];
      Kind k = kind == 0 ? GPU_BUFFER : kind == 1 ? GPU_SAMPLER : kind == 2 ? GPU_TEXTURE_VIEW : NONE;
      Resource *r = k == NONE ? NULL : resource(env, s, handle, k);
      if (!r) {
        free(entries);
        return k == NONE ? error(env, "wgpuDeviceCreateBindGroup: unknown entry kind") : NULL;
      }
      if (kind == 0) {
        E->buffer = BUFFER_OF(r);
        E->offset = offset;
        E->size = size > 0 ? (uint64_t)size : WGPU_WHOLE_SIZE;
      } else if (kind == 1)
        E->sampler = r->ptr;
      else
        E->textureView = r->ptr;
    }
    WGPUBindGroupDescriptor d = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    d.layout = layout->ptr;
    d.entryCount = count;
    d.entries = entries;
    WGPUBindGroup p = wgpuDeviceCreateBindGroup(dev->ptr, &d);
    free(entries);
    HANDLE_RESULT(GPU_BIND_GROUP, p, 0);
  }
  case OP_WGPU_RenderPassSetBindGroup:
  case OP_WGPU_ComputePassSetBindGroup: {
    GPU_AT(p, 0, op == OP_WGPU_RenderPassSetBindGroup ? GPU_RENDER_PASS : GPU_COMPUTE_PASS);
    GPU_AT(grp, 2, GPU_BIND_GROUP);
    INTS(3, offs, n);
    if (op == OP_WGPU_RenderPassSetBindGroup)
      wgpuRenderPassEncoderSetBindGroup(p->ptr, U(1), grp->ptr, n, (const uint32_t *)offs);
    else
      wgpuComputePassEncoderSetBindGroup(p->ptr, U(1), grp->ptr, n, (const uint32_t *)offs);
    return undefined(env);
  }
  case OP_WGPU_DeviceCreateTexture: {
    GPU_AT(dev, 0, GPU_DEVICE);
    WGPUTextureDescriptor d = WGPU_TEXTURE_DESCRIPTOR_INIT;
    d.size.width = U(1);
    d.size.height = U(2);
    d.size.depthOrArrayLayers = U(3) ? U(3) : 1;
    d.format = texture_format(I(4));
    if (d.format == WGPUTextureFormat_Undefined)
      return error(env, "wgpuDeviceCreateTexture: unsupported format");
    d.usage = (WGPUTextureUsage)U(5);
    d.dimension = I(6) ? texture_dimension(I(6)) : WGPUTextureDimension_2D;
    d.mipLevelCount = U(7) ? U(7) : 1;
    d.sampleCount = U(8) ? U(8) : 1;
    HANDLE_RESULT(GPU_TEXTURE, wgpuDeviceCreateTexture(dev->ptr, &d), 0);
  }
  case OP_WGPU_DeviceCreateSampler: {
    GPU_AT(dev, 0, GPU_DEVICE);
    WGPUSamplerDescriptor d = WGPU_SAMPLER_DESCRIPTOR_INIT;
    d.addressModeU = address_mode(I(1));
    d.addressModeV = address_mode(I(2));
    d.addressModeW = address_mode(I(3));
    d.magFilter = filter_mode(I(4));
    d.minFilter = filter_mode(I(5));
    d.mipmapFilter = mipmap_filter_mode(I(6));
    d.lodMinClamp = (float)F(7);
    d.lodMaxClamp = (float)F(8);
    d.maxAnisotropy = U(9) ? (uint16_t)U(9) : 1;
    d.compare = compare_function(I(10));
    HANDLE_RESULT(GPU_SAMPLER, wgpuDeviceCreateSampler(dev->ptr, &d), 0);
  }
  case OP_WGPU_QueueWriteTexture: {
    GPU_AT(q, 0, GPU_QUEUE);
    GPU_AT(t, 1, GPU_TEXTURE);
    BUF(7, data, len);
    WGPUTexelCopyTextureInfo dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    dst.texture = t->ptr;
    dst.mipLevel = U(2);
    dst.origin.x = U(3);
    dst.origin.y = U(4);
    dst.origin.z = U(5);
    dst.aspect = I(6) ? aspect(I(6)) : WGPUTextureAspect_All;
    WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    layout.offset = U(8);
    layout.bytesPerRow = U(9);
    if (U(10))
      layout.rowsPerImage = U(10);
    WGPUExtent3D size = {U(11), U(12), U(13) ? U(13) : 1};
    wgpuQueueWriteTexture(q->ptr, &dst, data, len, &layout, &size);
    return undefined(env);
  }
  case OP_WGPU_CommandEncoderCopyTextureToBuffer: {
    GPU_AT(enc, 0, GPU_COMMAND_ENCODER);
    GPU_AT(t, 1, GPU_TEXTURE);
    GPU_AT(b, 6, GPU_BUFFER);
    WGPUTexelCopyTextureInfo src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    src.texture = t->ptr;
    src.mipLevel = U(2);
    src.origin.x = U(3);
    src.origin.y = U(4);
    src.origin.z = U(5);
    src.aspect = WGPUTextureAspect_All;
    WGPUTexelCopyBufferInfo dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    dst.buffer = BUFFER_OF(b);
    dst.layout.offset = U(7);
    dst.layout.bytesPerRow = U(8);
    if (U(9))
      dst.layout.rowsPerImage = U(9);
    WGPUExtent3D size = {U(10), U(11), U(12) ? U(12) : 1};
    wgpuCommandEncoderCopyTextureToBuffer(enc->ptr, &src, &dst, &size);
    return undefined(env);
  }
  case OP_WGPU_BufferMapAsync: {
    GPU_AT(b, 0, GPU_BUFFER);
    GpuBuffer *buffer = b->ptr;
    if (buffer->mapped || buffer->mapping) return error(env, "Buffer is already mapped or mapping");
    uint64_t total = wgpuBufferGetSize(buffer->buffer), offset = U(2);
    uint64_t size = I(3) < 0 ? (offset <= total ? total - offset : 0) : (uint64_t)I(3);
    if ((U(1) != 1 && U(1) != 2) || offset > total || size > total - offset || offset % 8 || size % 4)
      return error(env, "Invalid buffer map mode, alignment, or range");
    Pending *p = pending_new(s, CB_MAP, I(4), I(5), I(6));
    if (!p)
      return error(env, "Out of memory");
    WGPUBufferMapCallbackInfo cb = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    cb.mode = WGPUCallbackMode_AllowProcessEvents;
    cb.callback = on_map;
    cb.userdata1 = p;
    cb.userdata2 = s;
    p->buffer = buffer;
    buffer->mapping = true;
    buffer->writable = U(1) == 2;
    buffer->offset = offset;
    buffer->size = size;
    buffer->range = NULL;
    wgpuBufferMapAsync(BUFFER_OF(b), (WGPUMapMode)U(1), U(2), I(3) < 0 ? WGPU_WHOLE_MAP_SIZE : (size_t)I(3), cb);
    return undefined(env);
  }
  case OP_WGPU_BufferGetSize: {
    GPU_AT(b, 0, GPU_BUFFER);
    return number(env, (double)wgpuBufferGetSize(BUFFER_OF(b)));
  }
  case OP_WGPU_BufferReadMappedRange:
  case OP_WGPU_BufferWriteMappedRange: {
    GPU_AT(b, 0, GPU_BUFFER);
    BUF(2, data, len);
    GpuBuffer *buffer = b->ptr;
    if (!buffer->mapped) return error(env, "Buffer is not mapped");
    uint64_t offset = U(1);
    if (offset < buffer->offset || offset - buffer->offset > buffer->size ||
        len > buffer->size - (offset - buffer->offset) || offset % 8 || len % 4)
      return error(env, "Invalid mapped buffer alignment or range");
    if (op == OP_WGPU_BufferWriteMappedRange && !buffer->writable)
      return error(env, "Buffer is mapped for reading");
    if (!len) return undefined(env);
    // Acquire once: repeated getMappedRange calls for overlapping ranges are
    // invalid in WebGPU, but our staging bridge reads then writes the same bytes.
    if (!buffer->range)
      buffer->range = wgpuBufferGetMappedRange(buffer->buffer, buffer->offset, buffer->size);
    if (!buffer->range) return error(env, "wgpuBufferGetMappedRange failed");
    char *range = (char *)buffer->range + (offset - buffer->offset);
    if (op == OP_WGPU_BufferReadMappedRange) memcpy(data, range, len);
    else memcpy(range, data, len);
    return undefined(env);
  }
  case OP_WGPU_BufferUnmap: {
    GPU_AT(b, 0, GPU_BUFFER);
    GpuBuffer *buffer = b->ptr;
    if (buffer->mapped || buffer->mapping) {
      wgpuBufferUnmap(buffer->buffer);
      buffer->mapped = buffer->mapping = false;
      buffer->range = NULL;
    }
    return undefined(env);
  }
  case OP_WGPU_CommandEncoderCopyBufferToBuffer: {
    GPU_AT(enc, 0, GPU_COMMAND_ENCODER);
    GPU_AT(src, 1, GPU_BUFFER);
    GPU_AT(dst, 3, GPU_BUFFER);
    wgpuCommandEncoderCopyBufferToBuffer(enc->ptr, BUFFER_OF(src), U(2), BUFFER_OF(dst), U(4), U(5));
    return undefined(env);
  }
  case OP_WGPU_DeviceCreateComputePipeline: {
    GPU_AT(dev, 0, GPU_DEVICE);
    GPU_AT(mod, 1, GPU_SHADER_MODULE);
    OPT_AT(layout, 3, GPU_PIPELINE_LAYOUT);
    char *entry = str(env, v[2]);
    if (!entry)
      return NULL;
    WGPUConstantEntry *consts = NULL;
    WGPUComputePipelineDescriptor d = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    d.layout = PTR(layout);
    d.compute.module = mod->ptr;
    d.compute.entryPoint = sv_optional(entry);
    d.compute.constantCount = unpack_constants(env, v[4], v[5], &consts);
    d.compute.constants = consts;
    WGPUComputePipeline p = wgpuDeviceCreateComputePipeline(dev->ptr, &d);
    free(entry);
    free(consts);
    HANDLE_RESULT(GPU_COMPUTE_PIPELINE, p, 0);
  }
  case OP_WGPU_CommandEncoderBeginComputePass: {
    GPU_AT(enc, 0, GPU_COMMAND_ENCODER);
    WGPUComputePassDescriptor d = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
    HANDLE_RESULT(GPU_COMPUTE_PASS, wgpuCommandEncoderBeginComputePass(enc->ptr, &d), 0);
  }
  case OP_WGPU_ComputePassSetPipeline: {
    GPU_AT(p, 0, GPU_COMPUTE_PASS);
    GPU_AT(pipe, 1, GPU_COMPUTE_PIPELINE);
    wgpuComputePassEncoderSetPipeline(p->ptr, pipe->ptr);
    return undefined(env);
  }
  case OP_WGPU_ComputePassDispatch: {
    GPU_AT(p, 0, GPU_COMPUTE_PASS);
    wgpuComputePassEncoderDispatchWorkgroups(p->ptr, U(1), U(2), U(3));
    return undefined(env);
  }
  case OP_WGPU_ComputePassEnd: {
    GPU_AT(p, 0, GPU_COMPUTE_PASS);
    wgpuComputePassEncoderEnd(p->ptr);
    return undefined(env);
  }
  case OP_WGPU_DevicePushErrorScope: {
    GPU_AT(dev, 0, GPU_DEVICE);
    wgpuDevicePushErrorScope(dev->ptr, error_filter(I(1)));
    return undefined(env);
  }
  case OP_WGPU_DevicePopErrorScope: {
    GPU_AT(dev, 0, GPU_DEVICE);
    Pending *p = pending_new(s, CB_POP_ERROR, I(1), I(2), I(3));
    if (!p)
      return error(env, "Out of memory");
    WGPUPopErrorScopeCallbackInfo cb = WGPU_POP_ERROR_SCOPE_CALLBACK_INFO_INIT;
    cb.mode = WGPUCallbackMode_AllowProcessEvents;
    cb.callback = on_pop_error;
    cb.userdata1 = p;
    cb.userdata2 = s;
    wgpuDevicePopErrorScope(dev->ptr, cb);
    return undefined(env);
  }
  case OP_WGPU_DeviceCreateCommandEncoder: {
    GPU_AT(dev, 0, GPU_DEVICE);
    WGPUCommandEncoderDescriptor d = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    HANDLE_RESULT(GPU_COMMAND_ENCODER, wgpuDeviceCreateCommandEncoder(dev->ptr, &d), 0);
  }
  case OP_WGPU_CommandEncoderBeginRenderPass: {
    GPU_AT(enc, 0, GPU_COMMAND_ENCODER);
    OPT_AT(depth, 3, GPU_TEXTURE_VIEW);
    // Ints: [ count, per attachment: view, resolveTarget, loadOp, storeOp,
    // depthSlice ]; clear values ride a parallel f64 array (4 per attachment).
    INTS(1, a, an);
    BUF(2, cv_raw, cv_len);
    if (cv_len % 8 || (uintptr_t)cv_raw % _Alignof(double))
      return error(env, "Invalid clear color buffer alignment or length");
    const double *cv = cv_raw;
    size_t count = an && a[0] > 0 ? (size_t)a[0] : 0;
    if (1 + count * 5 > an || count * 4 * 8 > cv_len || count > 8)
      return error(env, "wgpuCommandEncoderBeginRenderPass: packed attachments truncated");
    WGPURenderPassColorAttachment color[8];
    size_t i = 1;
    for (size_t k = 0; k < count; k++) {
      color[k] = (WGPURenderPassColorAttachment)WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
      Resource *view = resource(env, s, (uint32_t)a[i++], GPU_TEXTURE_VIEW);
      if (!view)
        return NULL;
      color[k].view = view->ptr;
      uint32_t resolve = (uint32_t)a[i++];
      if (resolve) {
        Resource *r = resource(env, s, resolve, GPU_TEXTURE_VIEW);
        if (!r)
          return NULL;
        color[k].resolveTarget = r->ptr;
      }
      int loadOp = a[i++], storeOp = a[i++];
      color[k].loadOp = loadOp ? load_op(loadOp) : WGPULoadOp_Clear;
      color[k].storeOp = storeOp ? store_op(storeOp) : WGPUStoreOp_Store;
      color[k].depthSlice = (uint32_t)a[i++];
      color[k].clearValue.r = cv[k * 4];
      color[k].clearValue.g = cv[k * 4 + 1];
      color[k].clearValue.b = cv[k * 4 + 2];
      color[k].clearValue.a = cv[k * 4 + 3];
    }
    WGPURenderPassDescriptor d = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
    d.colorAttachmentCount = count;
    d.colorAttachments = color;
    WGPURenderPassDepthStencilAttachment ds = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
    if (depth) {
      ds.view = depth->ptr;
      if (I(7))
        ds.depthReadOnly = true;
      else {
        ds.depthClearValue = (float)F(6);
        ds.depthLoadOp = I(4) ? load_op(I(4)) : WGPULoadOp_Clear;
        ds.depthStoreOp = I(5) ? store_op(I(5)) : WGPUStoreOp_Store;
      }
      if (I(11))
        ds.stencilReadOnly = true;
      else if (I(8)) {
        ds.stencilLoadOp = load_op(I(8));
        ds.stencilStoreOp = I(9) ? store_op(I(9)) : WGPUStoreOp_Store;
        ds.stencilClearValue = U(10);
      }
      d.depthStencilAttachment = &ds;
    }
    HANDLE_RESULT(GPU_RENDER_PASS, wgpuCommandEncoderBeginRenderPass(enc->ptr, &d), 0);
  }
  case OP_WGPU_RenderPassSetStencilReference: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    wgpuRenderPassEncoderSetStencilReference(p->ptr, U(1));
    return undefined(env);
  }
  case OP_WGPU_RenderPassSetPipeline: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    GPU_AT(pipe, 1, GPU_RENDER_PIPELINE);
    wgpuRenderPassEncoderSetPipeline(p->ptr, pipe->ptr);
    return undefined(env);
  }
  case OP_WGPU_RenderPassDraw: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    wgpuRenderPassEncoderDraw(p->ptr, U(1), U(2), U(3), U(4));
    return undefined(env);
  }
  case OP_WGPU_RenderPassEnd: {
    GPU_AT(p, 0, GPU_RENDER_PASS);
    wgpuRenderPassEncoderEnd(p->ptr);
    return undefined(env);
  }
  case OP_WGPU_CommandEncoderFinish: {
    GPU_AT(enc, 0, GPU_COMMAND_ENCODER);
    WGPUCommandBufferDescriptor d = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
    HANDLE_RESULT(GPU_COMMAND_BUFFER, wgpuCommandEncoderFinish(enc->ptr, &d), 0);
  }
  case OP_WGPU_QueueSubmit: {
    GPU_AT(q, 0, GPU_QUEUE);
    GPU_AT(cmd, 1, GPU_COMMAND_BUFFER);
    WGPUCommandBuffer c = cmd->ptr;
    wgpuQueueSubmit(q->ptr, 1, &c);
    return undefined(env);
  }
  case OP_WGPU_Release: {
    uint32_t id = U(0);
    if (id && id <= s->count && s->items[id - 1].ptr &&
        s->items[id - 1].kind >= GPU_FIRST && s->items[id - 1].kind <= GPU_LAST)
      destroy(s, id);
    return undefined(env);
  }
  case OP_WGPU_Shutdown:
    gpu_shutdown(s);
    return undefined(env);
  case OP_WGPU_MapEnum: {
    char *name = str(env, v[0]);
    if (!name)
      return NULL;
    for (size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); i++)
      if (strcmp(probes[i].name, name) == 0) {
        free(name);
        return number(env, probes[i].map(I(1)));
      }
    free(name);
    return error(env, "Unknown WebGPU enum");
  }
  default:
    return error(env, "Unknown WebGPU operation");
  }
}

void gpu_define(napi_env env, napi_value exports) {
#define EXPORT(name, sig) \
  {#name, NULL, gpu_dispatch, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)OP_##name},
  napi_property_descriptor props[] = {GPU_METHODS(EXPORT)};
#undef EXPORT
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
}
#endif
