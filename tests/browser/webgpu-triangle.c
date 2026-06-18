/* WebGPU triangle (callback model, NO JSPI). Renders a pink triangle on a
   dark-blue clear. Drives the shared rAF loop via wgpuSetMainLoopCallback.
   Used by webgpu-renders.mjs (Playwright screenshot) and the netguc/c e2e. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static WGPUTextureFormat format;
static int ready = 0;

static const char *shader =
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  var p = array<vec2f,3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));\n"
"  return vec4f(p[i], 0.0, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.2, 0.8, 1.0); }\n";

static WGPUShaderModule make_shader(void) {
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL;
    wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader;
    wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor d;
    d.nextInChain = (const WGPUChainedStruct *)&wgsl;
    d.label.data = NULL;
    d.label.length = 0;
    return wgpuDeviceCreateShaderModule(device, &d);
}

static void build_pipeline(void) {
    WGPUShaderModule sm = make_shader();

    WGPUColorTargetState target;
    target.nextInChain = NULL;
    target.format = format;
    target.blend = NULL;
    target.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fs;
    fs.nextInChain = NULL;
    fs.module = sm;
    fs.entryPoint.data = "fs";
    fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0;
    fs.constants = NULL;
    fs.targetCount = 1;
    fs.targets = &target;

    WGPURenderPipelineDescriptor pd;
    pd.nextInChain = NULL;
    pd.label.data = NULL;
    pd.label.length = 0;
    pd.layout = NULL;
    pd.vertex.nextInChain = NULL;
    pd.vertex.module = sm;
    pd.vertex.entryPoint.data = "vs";
    pd.vertex.entryPoint.length = WGPU_STRLEN;
    pd.vertex.constantCount = 0;
    pd.vertex.constants = NULL;
    pd.vertex.bufferCount = 0;
    pd.vertex.buffers = NULL;
    pd.primitive.nextInChain = NULL;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
    pd.primitive.frontFace = WGPUFrontFace_CCW;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.depthStencil = NULL;
    pd.multisample.nextInChain = NULL;
    pd.multisample.count = 1;
    pd.multisample.mask = 0xFFFFFFFF;
    pd.multisample.alphaToCoverageEnabled = 0;
    pd.fragment = &fs;

    pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);
    wgpuShaderModuleRelease(sm);
}

static void frame(void) {
    if (!ready) return;

    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;

    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL;
    att.view = view;
    att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL;
    att.loadOp = WGPULoadOp_Clear;
    att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 0.10;
    att.clearValue.g = 0.15;
    att.clearValue.b = 0.35;
    att.clearValue.a = 1.0;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL;
    rp.label.data = NULL;
    rp.label.length = 0;
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &att;
    rp.depthStencilAttachment = NULL;

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

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev,
                      WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success) {
        printf("requestDevice failed\n");
        return;
    }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surface, adapter);

    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL;
    cfg.device = device;
    cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = 640;
    cfg.height = 480;
    cfg.viewFormatCount = 0;
    cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);

    build_pipeline();
    ready = 1;
    printf("webgpu ready\n");
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad,
                       WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestAdapterStatus_Success) {
        printf("requestAdapter failed\n");
        return;
    }
    adapter = ad;
    WGPURequestDeviceCallbackInfo ci;
    ci.nextInChain = NULL;
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device;
    ci.userdata1 = NULL;
    ci.userdata2 = NULL;
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
    ci.userdata1 = NULL;
    ci.userdata2 = NULL;
    wgpuInstanceRequestAdapter(instance, &opts, ci);

    wgpuSetMainLoopCallback(frame);
    printf("webgpu triangle: main done, waiting for adapter\n");
    return 0;
}
