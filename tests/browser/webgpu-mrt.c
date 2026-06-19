/* WebGPU MRT + per-target write masks (A10) and multiple color attachments in
   one render pass (A11). One render pass writes TWO offscreen rgba8unorm
   targets at @location(0) and @location(1):
     - target 0: writeMask All       -> pink   (255, 51, 204, 255)
     - target 1: writeMask R|G|A      -> green; BLUE channel masked out, so it
                  keeps the (cleared) 0 -> (102, 153, 0, 255)
   Both targets are copied into one MAP_READ buffer (copyTextureToBuffer at two
   offsets), mapped async (callback model, NO JSPI), and their center pixels are
   verified in C. A correct MRT render + mask paints the surface GREEN (the pixel
   harness asserts it); a mismatch paints RED. Driven by webgpu-mrt-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define TEX_W 64
#define TEX_H 64
#define ROW_BYTES 256            /* 64 px * 4 bytes, already %256 aligned */
#define IMG_BYTES (ROW_BYTES * TEX_H)
#define BUF_BYTES (IMG_BYTES * 2) /* target0 at offset 0, target1 at IMG_BYTES */

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUTextureFormat format;
static WGPUBuffer readbackBuf;

static int passed = 0;     /* 1 = both targets matched */
static int rbReady = 0;
static int configured = 0;

static const char *shader =
    "struct VsOut { @builtin(position) pos: vec4f };\n"
    "@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {\n"
    "  var p = array<vec2f,3>(vec2f(-1.0,-3.0), vec2f(-1.0,1.0), vec2f(3.0,1.0));\n"
    "  var o: VsOut; o.pos = vec4f(p[i], 0.0, 1.0); return o;\n"
    "}\n"
    "struct FsOut { @location(0) c0: vec4f, @location(1) c1: vec4f };\n"
    "@fragment fn fs() -> FsOut {\n"
    "  var o: FsOut;\n"
    "  o.c0 = vec4f(1.0, 0.2, 0.8, 1.0);\n"
    "  o.c1 = vec4f(0.4, 0.6, 1.0, 1.0);\n"
    "  return o;\n"
    "}\n";

static int near(unsigned char v, int want) { int d = (int)v - want; return d < 0 ? -d <= 4 : d <= 4; }

static void on_mapped(WGPUMapAsyncStatus status, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPUMapAsyncStatus_Success) { printf("mapAsync failed: %d\n", (int)status); return; }
    const unsigned char *p = (const unsigned char *)wgpuBufferGetConstMappedRange(readbackBuf, 0, BUF_BYTES);
    int off = 32 * ROW_BYTES + 32 * 4;                 /* center pixel of each image */
    const unsigned char *t0 = p + off;
    const unsigned char *t1 = p + IMG_BYTES + off;
    printf("TARGET0 %d,%d,%d,%d\n", t0[0], t0[1], t0[2], t0[3]);
    printf("TARGET1 %d,%d,%d,%d\n", t1[0], t1[1], t1[2], t1[3]);
    int ok0 = near(t0[0], 255) && near(t0[1], 51) && near(t0[2], 204) && near(t0[3], 255);
    /* target1: blue masked out (writeMask R|G|A) -> retains cleared 0. */
    int ok1 = near(t1[0], 102) && near(t1[1], 153) && near(t1[2], 0) && near(t1[3], 255);
    passed = ok0 && ok1;
    rbReady = 1;
    wgpuBufferUnmap(readbackBuf);
}

static WGPUTexture make_target(void) {
    WGPUTextureDescriptor td;
    char *z = (char *)&td; for (size_t i = 0; i < sizeof(td); i++) z[i] = 0;
    td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    td.dimension = WGPUTextureDimension_2D;
    td.size.width = TEX_W; td.size.height = TEX_H; td.size.depthOrArrayLayers = 1;
    td.format = WGPUTextureFormat_RGBA8Unorm;
    td.mipLevelCount = 1; td.sampleCount = 1;
    return wgpuDeviceCreateTexture(device, &td);
}

static void do_mrt(void) {
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL; wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader; wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor smd;
    smd.nextInChain = (const WGPUChainedStruct *)&wgsl; smd.label.data = NULL; smd.label.length = 0;
    WGPUShaderModule mod = wgpuDeviceCreateShaderModule(device, &smd);

    /* Two color targets: target0 All, target1 masks out blue. */
    WGPUColorTargetState targets[2];
    char *z = (char *)targets; for (size_t i = 0; i < sizeof(targets); i++) z[i] = 0;
    targets[0].format = WGPUTextureFormat_RGBA8Unorm;
    targets[0].blend = NULL;
    targets[0].writeMask = WGPUColorWriteMask_All;
    targets[1].format = WGPUTextureFormat_RGBA8Unorm;
    targets[1].blend = NULL;
    targets[1].writeMask = WGPUColorWriteMask_Red | WGPUColorWriteMask_Green | WGPUColorWriteMask_Alpha;

    WGPUFragmentState fs;
    z = (char *)&fs; for (size_t i = 0; i < sizeof(fs); i++) z[i] = 0;
    fs.module = mod; fs.entryPoint.data = "fs"; fs.entryPoint.length = 2;
    fs.targetCount = 2; fs.targets = targets;

    WGPURenderPipelineDescriptor pd;
    z = (char *)&pd; for (size_t i = 0; i < sizeof(pd); i++) z[i] = 0;
    pd.layout = NULL;
    pd.vertex.module = mod; pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = 2;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.frontFace = WGPUFrontFace_CCW;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
    pd.fragment = &fs;
    WGPURenderPipeline pipe = wgpuDeviceCreateRenderPipeline(device, &pd);

    WGPUTexture tex0 = make_target(), tex1 = make_target();
    WGPUTextureView v0 = wgpuTextureCreateView(tex0, NULL), v1 = wgpuTextureCreateView(tex1, NULL);

    WGPUBufferDescriptor bd;
    bd.nextInChain = NULL; bd.label.data = NULL; bd.label.length = 0;
    bd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    bd.size = BUF_BYTES; bd.mappedAtCreation = 0;
    readbackBuf = wgpuDeviceCreateBuffer(device, &bd);

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    /* ONE render pass, TWO color attachments (A11). */
    WGPURenderPassColorAttachment att[2];
    z = (char *)att; for (size_t i = 0; i < sizeof(att); i++) z[i] = 0;
    att[0].view = v0; att[0].depthSlice = WGPU_DEPTH_SLICE_UNDEFINED; att[0].resolveTarget = NULL;
    att[0].loadOp = WGPULoadOp_Clear; att[0].storeOp = WGPUStoreOp_Store;
    att[0].clearValue.r = 0; att[0].clearValue.g = 0; att[0].clearValue.b = 0; att[0].clearValue.a = 1;
    att[1].view = v1; att[1].depthSlice = WGPU_DEPTH_SLICE_UNDEFINED; att[1].resolveTarget = NULL;
    att[1].loadOp = WGPULoadOp_Clear; att[1].storeOp = WGPUStoreOp_Store;
    att[1].clearValue.r = 0; att[1].clearValue.g = 0; att[1].clearValue.b = 0; att[1].clearValue.a = 1;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 2; rp.colorAttachments = att; rp.depthStencilAttachment = NULL;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderSetPipeline(pass, pipe);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass);

    /* Copy both targets into one readback buffer. */
    WGPUExtent3D copySize; copySize.width = TEX_W; copySize.height = TEX_H; copySize.depthOrArrayLayers = 1;
    for (int i = 0; i < 2; i++) {
        WGPUTexelCopyTextureInfo src;
        z = (char *)&src; for (size_t k = 0; k < sizeof(src); k++) z[k] = 0;
        src.texture = i ? tex1 : tex0; src.mipLevel = 0; src.aspect = WGPUTextureAspect_All;
        WGPUTexelCopyBufferInfo dst;
        z = (char *)&dst; for (size_t k = 0; k < sizeof(dst); k++) z[k] = 0;
        dst.buffer = readbackBuf;
        dst.layout.offset = i ? IMG_BYTES : 0;
        dst.layout.bytesPerRow = ROW_BYTES;
        dst.layout.rowsPerImage = TEX_H;
        wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &copySize);
    }

    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);

    WGPUBufferMapCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_mapped; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuBufferMapAsync(readbackBuf, WGPUMapMode_Read, 0, BUF_BYTES, ci);

    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(v0); wgpuTextureViewRelease(v1);
    wgpuTextureRelease(tex0); wgpuTextureRelease(tex1);
    wgpuRenderPipelineRelease(pipe);
    wgpuShaderModuleRelease(mod);
}

static void frame(void) {
    if (!configured) return;
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = (rbReady && !passed) ? 1.0 : 0.0;
    att.clearValue.g = (rbReady && passed) ? 1.0 : 0.0;
    att.clearValue.b = 0.0; att.clearValue.a = 1.0;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att; rp.depthStencilAttachment = NULL;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderEnd(pass);

    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuSurfacePresent(surface);

    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success) { printf("requestDevice failed\n"); return; }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surface, adapter);

    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = 640; cfg.height = 480;
    cfg.viewFormatCount = 0; cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);
    configured = 1;

    do_mrt();
    printf("webgpu ready\n");
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestAdapterStatus_Success) { printf("requestAdapter failed\n"); return; }
    adapter = ad;
    WGPURequestDeviceCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuAdapterRequestDevice(adapter, NULL, ci);
}

int main(void) {
    instance = wgpuCreateInstance(NULL);
    surface = wgpuInstanceCreateSurface(instance, NULL);

    WGPURequestAdapterOptions opts;
    opts.nextInChain = NULL; opts.compatibleSurface = surface;
    opts.powerPreference = WGPUPowerPreference_Undefined; opts.forceFallbackAdapter = 0;

    WGPURequestAdapterCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_adapter; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuInstanceRequestAdapter(instance, &opts, ci);

    wgpuSetMainLoopCallback(frame);
    printf("webgpu mrt: main done, waiting for adapter\n");
    return 0;
}
