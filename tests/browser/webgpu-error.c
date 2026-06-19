/* WebGPU error scopes (Tier 3). Pushes a validation error scope, deliberately
   creates an INVALID buffer (usage MAP_READ|VERTEX — an illegal combo; MAP_READ
   may only pair with COPY_DST), and pops the scope: C must receive
   WGPUErrorType_Validation. A second clean scope must report NoError. The
   surface is painted GREEN only if BOTH behaved correctly (validation caught +
   clean scope clean), RED otherwise. Exercises wgpuDevicePushErrorScope /
   PopErrorScope (callback model). Driven by webgpu-error-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUTextureFormat format;
static int configured = 0;
static int resultBad = -1;   /* error type from the scope around the invalid op */
static int resultGood = -1;  /* error type from the clean scope */

static void on_popped_bad(WGPUPopErrorScopeStatus status, WGPUErrorType type,
                          WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    resultBad = (status == WGPUPopErrorScopeStatus_Success) ? (int)type : -2;
    printf("scope(invalid): status=%d type=%d\n", (int)status, (int)type);
}

static void on_popped_good(WGPUPopErrorScopeStatus status, WGPUErrorType type,
                           WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    resultGood = (status == WGPUPopErrorScopeStatus_Success) ? (int)type : -2;
    printf("scope(clean): status=%d type=%d\n", (int)status, (int)type);
}

static void run_error_scopes(void) {
    /* Scope 1: capture a real validation error. */
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    WGPUBufferDescriptor bd;
    bd.nextInChain = NULL; bd.label.data = NULL; bd.label.length = 0;
    bd.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_Vertex;  /* illegal combo */
    bd.size = 16;
    bd.mappedAtCreation = 0;
    WGPUBuffer bad = wgpuDeviceCreateBuffer(device, &bd);
    (void)bad;
    WGPUPopErrorScopeCallbackInfo ci1;
    ci1.nextInChain = NULL; ci1.mode = WGPUCallbackMode_AllowSpontaneous;
    ci1.callback = on_popped_bad; ci1.userdata1 = NULL; ci1.userdata2 = NULL;
    wgpuDevicePopErrorScope(device, ci1);

    /* Scope 2: nothing invalid -> NoError. */
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    WGPUPopErrorScopeCallbackInfo ci2;
    ci2.nextInChain = NULL; ci2.mode = WGPUCallbackMode_AllowSpontaneous;
    ci2.callback = on_popped_good; ci2.userdata1 = NULL; ci2.userdata2 = NULL;
    wgpuDevicePopErrorScope(device, ci2);
}

static void frame(void) {
    if (!configured) return;

    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;

    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    int done = (resultBad != -1 && resultGood != -1);
    int ok = (resultBad == WGPUErrorType_Validation && resultGood == WGPUErrorType_NoError);

    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL;
    att.view = view;
    att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL;
    att.loadOp = WGPULoadOp_Clear;
    att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = (done && !ok) ? 1.0 : 0.0;
    att.clearValue.g = (done && ok) ? 1.0 : 0.0;
    att.clearValue.b = 0.0;
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

    run_error_scopes();
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
    printf("webgpu error scopes: main done, waiting for adapter\n");
    return 0;
}
