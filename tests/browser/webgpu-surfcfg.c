/* WebGPU surface configuration completeness (A15): viewFormats, presentMode,
   alphaMode in wgpuSurfaceConfigure. The surface is configured as rgba8unorm
   with viewFormats = [rgba8unorm-srgb], presentMode = Fifo, alphaMode = Opaque.
   Each frame creates a view of the current texture in the rgba8unorm-srgb
   VIEW FORMAT and renders a linear 0.5 red through it; the srgb view encodes
   0.5 linear -> ~0.735 -> ~188 in the stored byte. If viewFormats had been
   dropped, createView(format = ...-srgb) would fail validation and nothing would
   render. So a red channel near 188 (not 128) proves the view format — hence
   viewFormats — was honored. Driven by webgpu-surfcfg-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static int ready = 0;

static const char *shader =
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  var p = array<vec2f,3>(vec2f(-1.0,-3.0), vec2f(-1.0,1.0), vec2f(3.0,1.0));\n"
"  return vec4f(p[i], 0.0, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4f { return vec4f(0.5, 0.0, 0.0, 1.0); }\n";

static WGPUShaderModule make_shader(void) {
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL; wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader; wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor d;
    d.nextInChain = (const WGPUChainedStruct *)&wgsl; d.label.data = NULL; d.label.length = 0;
    return wgpuDeviceCreateShaderModule(device, &d);
}

static void build(void) {
    WGPUShaderModule sm = make_shader();
    /* The pipeline renders into the SRGB view, so its color target format must be
       the srgb variant (not the surface's rgba8unorm). */
    WGPUColorTargetState target;
    target.nextInChain = NULL; target.format = WGPUTextureFormat_RGBA8UnormSrgb;
    target.blend = NULL; target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fs;
    fs.nextInChain = NULL; fs.module = sm; fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0; fs.constants = NULL; fs.targetCount = 1; fs.targets = &target;
    WGPURenderPipelineDescriptor pd;
    char *z = (char *)&pd; for (size_t i = 0; i < sizeof(pd); i++) z[i] = 0;
    pd.layout = NULL;
    pd.vertex.module = sm; pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.frontFace = WGPUFrontFace_CCW; pd.primitive.cullMode = WGPUCullMode_None;
    pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
    pd.fragment = &fs;
    pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);
    wgpuShaderModuleRelease(sm);
}

static void frame(void) {
    if (!ready) return;
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;

    /* View the rgba8unorm surface texture in its srgb VIEW FORMAT. */
    WGPUTextureViewDescriptor vd;
    char *z = (char *)&vd; for (size_t i = 0; i < sizeof(vd); i++) z[i] = 0;
    vd.format = WGPUTextureFormat_RGBA8UnormSrgb;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, &vd);

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 0.0; att.clearValue.g = 0.0; att.clearValue.b = 0.0; att.clearValue.a = 1.0;
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

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success) { printf("requestDevice failed\n"); return; }
    device = dev;
    queue = wgpuDeviceGetQueue(device);

    /* Configure rgba8unorm + an srgb VIEW FORMAT, Fifo, Opaque. */
    WGPUTextureFormat viewFormats[1] = { WGPUTextureFormat_RGBA8UnormSrgb };
    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = WGPUTextureFormat_RGBA8Unorm;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = 640; cfg.height = 480;
    cfg.viewFormatCount = 1; cfg.viewFormats = viewFormats;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);

    build();
    ready = 1;
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
    printf("webgpu surfcfg: main done, waiting for adapter\n");
    return 0;
}
