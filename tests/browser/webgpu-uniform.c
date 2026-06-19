/* WebGPU uniform-buffer triangle (Tier 1). The triangle's fragment color comes
   from a uniform buffer (set to pink) bound via an explicit bind group +
   pipeline layout — exercising wgpuDeviceCreateBindGroupLayout /
   CreatePipelineLayout / CreateBindGroup / SetBindGroup and the explicit-layout
   path of wgpuDeviceCreateRenderPipeline. Vertices stay baked in the shader so
   this isolates the bind-group machinery. Driven by webgpu-uniform-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static WGPUBuffer ubuf;
static WGPUBindGroup bindGroup;
static WGPUTextureFormat format;
static int ready = 0;

/* uColor = pink (matches the triangle test's center-pixel checks). */
static const float ucolor[4] = { 1.0f, 0.2f, 0.8f, 1.0f };

static const char *shader =
"@group(0) @binding(0) var<uniform> uColor: vec4f;\n"
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  var p = array<vec2f,3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));\n"
"  return vec4f(p[i], 0.0, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4f { return uColor; }\n";

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

static WGPUBindGroupLayout make_bgl(void) {
    WGPUBindGroupLayoutEntry e;
    /* zero the whole entry so the unused sampler/texture/storageTexture
       sub-structs read as Undefined (kind selection keys off that). */
    char *z = (char *)&e;
    for (size_t i = 0; i < sizeof(e); i++) z[i] = 0;
    e.binding = 0;
    e.visibility = WGPUShaderStage_Fragment;
    e.buffer.type = WGPUBufferBindingType_Uniform;

    WGPUBindGroupLayoutDescriptor d;
    d.nextInChain = NULL;
    d.label.data = NULL;
    d.label.length = 0;
    d.entryCount = 1;
    d.entries = &e;
    return wgpuDeviceCreateBindGroupLayout(device, &d);
}

static void build(void) {
    WGPUShaderModule sm = make_shader();
    WGPUBindGroupLayout bgl = make_bgl();

    /* Uniform buffer + write the color. */
    WGPUBufferDescriptor bd;
    bd.nextInChain = NULL;
    bd.label.data = NULL;
    bd.label.length = 0;
    bd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    bd.size = sizeof(ucolor);
    bd.mappedAtCreation = 0;
    ubuf = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, ubuf, 0, ucolor, sizeof(ucolor));

    /* Bind group binding the uniform buffer at @binding(0). */
    WGPUBindGroupEntry be;
    char *z = (char *)&be;
    for (size_t i = 0; i < sizeof(be); i++) z[i] = 0;
    be.binding = 0;
    be.buffer = ubuf;
    be.offset = 0;
    be.size = sizeof(ucolor);

    WGPUBindGroupDescriptor bgd;
    bgd.nextInChain = NULL;
    bgd.label.data = NULL;
    bgd.label.length = 0;
    bgd.layout = bgl;
    bgd.entryCount = 1;
    bgd.entries = &be;
    bindGroup = wgpuDeviceCreateBindGroup(device, &bgd);

    /* Explicit pipeline layout from the BGL. */
    WGPUPipelineLayoutDescriptor pld;
    pld.nextInChain = NULL;
    pld.label.data = NULL;
    pld.label.length = 0;
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &bgl;
    WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

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
    pd.layout = pl;
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

    wgpuPipelineLayoutRelease(pl);
    wgpuBindGroupLayoutRelease(bgl);
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
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup, 0, NULL);
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

    build();
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
    printf("webgpu uniform triangle: main done, waiting for adapter\n");
    return 0;
}
