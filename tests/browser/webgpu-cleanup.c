/* WebGPU teardown coverage. Renders one green frame, maps a buffer via the
   non-const wgpuBufferGetMappedRange, then RELEASES the whole object graph
   (pipeline, queue, device, adapter, surface, instance) — the release wrappers
   and the non-const getMappedRange that the feature tests keep alive and so
   never exercise by name. The last presented frame stays on the canvas after
   teardown (release frees only the host handle, not the GPU object), so a green
   center proves it rendered AND tore down without error. Driven by
   webgpu-cleanup-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static WGPUBuffer buf;

static const char *shader =
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  var p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));\n"
"  return vec4f(p[i], 0.0, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }\n";

static void noop(void) {}

static void render_one_green_frame(void) {
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 0.0; att.clearValue.g = 1.0; att.clearValue.b = 0.0; att.clearValue.a = 1.0;
    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att; rp.depthStencilAttachment = NULL;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
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

static void on_mapped(WGPUMapAsyncStatus status, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status == WGPUMapAsyncStatus_Success) {
        /* non-const getMappedRange (read path); content is zero-init, just exercise it. */
        unsigned char *p = (unsigned char *)wgpuBufferGetMappedRange(buf, 0, 16);
        printf("mapped[0]=%d\n", (int)p[0]);
        wgpuBufferUnmap(buf);
    } else {
        printf("map failed %d\n", (int)status);
    }
    /* Tear down the whole object graph (the release wrappers under test). */
    wgpuBufferRelease(buf);
    wgpuRenderPipelineRelease(pipeline);
    wgpuQueueRelease(queue);
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    wgpuSurfaceRelease(surface);
    wgpuInstanceRelease(instance);
    printf("RELEASE OK\n");
    wgpuSetMainLoopCallback(NULL);   /* stop -> program exits */
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev,
                      WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success) { printf("requestDevice failed\n"); return; }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    WGPUTextureFormat format = wgpuSurfaceGetPreferredFormat(surface, adapter);

    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment; cfg.width = 640; cfg.height = 480;
    cfg.viewFormatCount = 0; cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque; cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);

    /* green fullscreen-triangle pipeline */
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL; wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader; wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor smd;
    smd.nextInChain = (const WGPUChainedStruct *)&wgsl; smd.label.data = NULL; smd.label.length = 0;
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &smd);
    WGPUColorTargetState target;
    target.nextInChain = NULL; target.format = format; target.blend = NULL; target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fs;
    fs.nextInChain = NULL; fs.module = sm; fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0; fs.constants = NULL; fs.targetCount = 1; fs.targets = &target;
    WGPURenderPipelineDescriptor pd;
    pd.nextInChain = NULL; pd.label.data = NULL; pd.label.length = 0; pd.layout = NULL;
    pd.vertex.nextInChain = NULL; pd.vertex.module = sm;
    pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
    pd.vertex.constantCount = 0; pd.vertex.constants = NULL; pd.vertex.bufferCount = 0; pd.vertex.buffers = NULL;
    pd.primitive.nextInChain = NULL; pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
    pd.primitive.frontFace = WGPUFrontFace_CCW; pd.primitive.cullMode = WGPUCullMode_None;
    pd.depthStencil = NULL;
    pd.multisample.nextInChain = NULL; pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF; pd.multisample.alphaToCoverageEnabled = 0;
    pd.fragment = &fs;
    pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);
    wgpuShaderModuleRelease(sm);

    render_one_green_frame();

    /* map a buffer so on_mapped can exercise the non-const getMappedRange + teardown. */
    WGPUBufferDescriptor bd;
    bd.nextInChain = NULL; bd.label.data = NULL; bd.label.length = 0;
    bd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead; bd.size = 16; bd.mappedAtCreation = 0;
    buf = wgpuDeviceCreateBuffer(device, &bd);
    WGPUBufferMapCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_mapped; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuBufferMapAsync(buf, WGPUMapMode_Read, 0, 16, ci);
    printf("webgpu ready\n");
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad,
                       WGPUStringView msg, void *ud1, void *ud2) {
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
    wgpuSetMainLoopCallback(noop);   /* keep alive for the async chain */
    return 0;
}
