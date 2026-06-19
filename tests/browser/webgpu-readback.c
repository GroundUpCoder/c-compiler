/* WebGPU GPU->CPU readback (Tier 3). Renders pink into an OFFSCREEN 64x64
   rgba8unorm texture (no surface), copies it to a MAP_READ buffer
   (copyTextureToBuffer), maps it async (callback model, NO JSPI), reads the
   center pixel back into C, prints it, and then presents that read-back color
   to the surface — so a correct readback paints the canvas pink (the existing
   pixel harness asserts it). Exercises wgpuCommandEncoderCopyTextureToBuffer /
   wgpuBufferMapAsync / wgpuBufferGetMappedRange / wgpuBufferUnmap.
   Driven by webgpu-readback-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define TEX_W 64
#define TEX_H 64
#define ROW_BYTES 256            /* 64 px * 4 bytes, already %256 aligned */
#define BUF_BYTES (ROW_BYTES * TEX_H)

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUTextureFormat format;
static WGPUBuffer readbackBuf;

static float rbR = 0, rbG = 0, rbB = 0;
static int rbReady = 0;
static int configured = 0;

static void on_mapped(WGPUMapAsyncStatus status, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPUMapAsyncStatus_Success) {
        printf("mapAsync failed: %d\n", (int)status);
        return;
    }
    const unsigned char *p = (const unsigned char *)wgpuBufferGetConstMappedRange(readbackBuf, 0, BUF_BYTES);
    /* Center pixel (32,32): row 32 at byte 32*256, pixel 32 at +32*4. */
    int off = 32 * ROW_BYTES + 32 * 4;
    unsigned char r = p[off], g = p[off + 1], b = p[off + 2], a = p[off + 3];
    printf("PIXEL %d,%d,%d,%d\n", r, g, b, a);
    rbR = r / 255.0f; rbG = g / 255.0f; rbB = b / 255.0f;
    rbReady = 1;
    wgpuBufferUnmap(readbackBuf);
}

static void do_readback(void) {
    /* Offscreen render target. */
    WGPUTextureDescriptor td;
    char *z = (char *)&td; for (size_t i = 0; i < sizeof(td); i++) z[i] = 0;
    td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    td.dimension = WGPUTextureDimension_2D;
    td.size.width = TEX_W; td.size.height = TEX_H; td.size.depthOrArrayLayers = 1;
    td.format = WGPUTextureFormat_RGBA8Unorm;
    td.mipLevelCount = 1; td.sampleCount = 1;
    WGPUTexture tex = wgpuDeviceCreateTexture(device, &td);
    WGPUTextureView view = wgpuTextureCreateView(tex, NULL);

    WGPUBufferDescriptor bd;
    bd.nextInChain = NULL; bd.label.data = NULL; bd.label.length = 0;
    bd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    bd.size = BUF_BYTES; bd.mappedAtCreation = 0;
    readbackBuf = wgpuDeviceCreateBuffer(device, &bd);

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    /* Render pass: clear the offscreen texture to pink (no draw needed). */
    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL;
    att.view = view;
    att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL;
    att.loadOp = WGPULoadOp_Clear;
    att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 1.0; att.clearValue.g = 0.2; att.clearValue.b = 0.8; att.clearValue.a = 1.0;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att; rp.depthStencilAttachment = NULL;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderEnd(pass);

    /* Copy the rendered texture into the readback buffer. */
    WGPUTexelCopyTextureInfo src;
    z = (char *)&src; for (size_t i = 0; i < sizeof(src); i++) z[i] = 0;
    src.texture = tex; src.mipLevel = 0; src.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferInfo dst;
    z = (char *)&dst; for (size_t i = 0; i < sizeof(dst); i++) z[i] = 0;
    dst.buffer = readbackBuf;
    dst.layout.offset = 0;
    dst.layout.bytesPerRow = ROW_BYTES;
    dst.layout.rowsPerImage = TEX_H;

    WGPUExtent3D copySize;
    copySize.width = TEX_W; copySize.height = TEX_H; copySize.depthOrArrayLayers = 1;
    wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &copySize);

    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);

    /* Map the readback buffer; the callback reads the center pixel. */
    WGPUBufferMapCallbackInfo ci;
    ci.nextInChain = NULL;
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_mapped;
    ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuBufferMapAsync(readbackBuf, WGPUMapMode_Read, 0, BUF_BYTES, ci);

    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(tex);
}

static void frame(void) {
    if (!configured) return;

    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;

    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    /* Present the read-back color to the surface (black until the map lands). */
    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL;
    att.view = view;
    att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL;
    att.loadOp = WGPULoadOp_Clear;
    att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = rbReady ? rbR : 0.0;
    att.clearValue.g = rbReady ? rbG : 0.0;
    att.clearValue.b = rbReady ? rbB : 0.0;
    att.clearValue.a = 1.0;

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

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev,
                      WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success) { printf("requestDevice failed\n"); return; }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surface, adapter);

    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL;
    cfg.device = device;
    cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = 640; cfg.height = 480;
    cfg.viewFormatCount = 0; cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);
    configured = 1;

    do_readback();
    printf("webgpu ready\n");
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad,
                       WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestAdapterStatus_Success) { printf("requestAdapter failed\n"); return; }
    adapter = ad;
    WGPURequestDeviceCallbackInfo ci;
    ci.nextInChain = NULL;
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device;
    ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuAdapterRequestDevice(adapter, NULL, ci);
}

int main(void) {
    instance = wgpuCreateInstance(NULL);
    surface = wgpuInstanceCreateSurface(instance, NULL);

    WGPURequestAdapterOptions opts;
    opts.nextInChain = NULL;
    opts.compatibleSurface = surface;
    opts.powerPreference = WGPUPowerPreference_Undefined;
    opts.forceFallbackAdapter = 0;

    WGPURequestAdapterCallbackInfo ci;
    ci.nextInChain = NULL;
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_adapter;
    ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuInstanceRequestAdapter(instance, &opts, ci);

    wgpuSetMainLoopCallback(frame);
    printf("webgpu readback: main done, waiting for adapter\n");
    return 0;
}
