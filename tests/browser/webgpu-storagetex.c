/* WebGPU storage-texture bindings (Phase A8). A compute pass writes PINK into an
   8x8 rgba8unorm storage texture via textureStore (bind-group layout entry kind
   = storageTexture, access=write-only). A following render pass samples that same
   texture and draws it on a quad. If the host doesn't handle the storageTexture
   BGL kind, the compute bind-group layout fails ("unknown entry kind 3") and
   nothing renders. A pink center proves the storage-texture binding path.
   Driven by webgpu-storagetex-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUComputePipeline computePipeline;
static WGPUBindGroup computeBG;
static WGPURenderPipeline pipeline;
static WGPUBuffer vbuf;
static WGPUBindGroup renderBG;
static WGPUTextureFormat format;
static int ready = 0;

static const float verts[] = {
    -0.7f, -0.7f,  0.0f, 1.0f,
     0.7f, -0.7f,  1.0f, 1.0f,
     0.7f,  0.7f,  1.0f, 0.0f,
    -0.7f, -0.7f,  0.0f, 1.0f,
     0.7f,  0.7f,  1.0f, 0.0f,
    -0.7f,  0.7f,  0.0f, 0.0f,
};

static const char *computeShader =
"@group(0) @binding(0) var img: texture_storage_2d<rgba8unorm, write>;\n"
"@compute @workgroup_size(1) fn cs(@builtin(global_invocation_id) id: vec3u) {\n"
"  textureStore(img, vec2i(i32(id.x), i32(id.y)), vec4f(1.0, 0.2, 0.8, 1.0));\n"
"}\n";

static const char *renderShader =
"struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };\n"
"@vertex fn vs(@location(0) p: vec2f, @location(1) uv: vec2f) -> VOut {\n"
"  var o: VOut; o.pos = vec4f(p, 0.0, 1.0); o.uv = uv; return o;\n"
"}\n"
"@group(0) @binding(0) var samp: sampler;\n"
"@group(0) @binding(1) var tex: texture_2d<f32>;\n"
"@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return textureSample(tex, samp, uv); }\n";

static void zero(void *p, size_t n) { char *z = (char *)p; for (size_t i = 0; i < n; i++) z[i] = 0; }

static WGPUShaderModule make_shader(const char *src) {
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL;
    wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = src;
    wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor d;
    d.nextInChain = (const WGPUChainedStruct *)&wgsl;
    d.label.data = NULL;
    d.label.length = 0;
    return wgpuDeviceCreateShaderModule(device, &d);
}

static WGPUTextureView storageView;

static void build(void) {
    /* Storage texture used first as a compute storage target, then sampled. */
    WGPUTextureDescriptor td;
    zero(&td, sizeof(td));
    td.usage = WGPUTextureUsage_StorageBinding | WGPUTextureUsage_TextureBinding;
    td.dimension = WGPUTextureDimension_2D;
    td.size.width = 8; td.size.height = 8; td.size.depthOrArrayLayers = 1;
    td.format = WGPUTextureFormat_RGBA8Unorm;
    td.mipLevelCount = 1; td.sampleCount = 1;
    WGPUTexture stex = wgpuDeviceCreateTexture(device, &td);
    storageView = wgpuTextureCreateView(stex, NULL);

    /* ---- compute pipeline (storage-texture BGL) ---- */
    WGPUShaderModule cs = make_shader(computeShader);

    WGPUBindGroupLayoutEntry ce;
    zero(&ce, sizeof(ce));
    ce.binding = 0;
    ce.visibility = WGPUShaderStage_Compute;
    ce.storageTexture.access = WGPUStorageTextureAccess_WriteOnly;   /* kind under test */
    ce.storageTexture.format = WGPUTextureFormat_RGBA8Unorm;
    ce.storageTexture.viewDimension = WGPUTextureViewDimension_2D;

    WGPUBindGroupLayoutDescriptor cbgld;
    cbgld.nextInChain = NULL; cbgld.label.data = NULL; cbgld.label.length = 0;
    cbgld.entryCount = 1; cbgld.entries = &ce;
    WGPUBindGroupLayout cbgl = wgpuDeviceCreateBindGroupLayout(device, &cbgld);

    WGPUBindGroupEntry cbe;
    zero(&cbe, sizeof(cbe));
    cbe.binding = 0;
    cbe.textureView = storageView;
    WGPUBindGroupDescriptor cbgd;
    cbgd.nextInChain = NULL; cbgd.label.data = NULL; cbgd.label.length = 0;
    cbgd.layout = cbgl; cbgd.entryCount = 1; cbgd.entries = &cbe;
    computeBG = wgpuDeviceCreateBindGroup(device, &cbgd);

    WGPUPipelineLayoutDescriptor cpld;
    cpld.nextInChain = NULL; cpld.label.data = NULL; cpld.label.length = 0;
    cpld.bindGroupLayoutCount = 1; cpld.bindGroupLayouts = &cbgl;
    WGPUPipelineLayout cpl = wgpuDeviceCreatePipelineLayout(device, &cpld);

    WGPUComputePipelineDescriptor cpd;
    zero(&cpd, sizeof(cpd));
    cpd.layout = cpl;
    cpd.compute.module = cs;
    cpd.compute.entryPoint.data = "cs";
    cpd.compute.entryPoint.length = WGPU_STRLEN;
    computePipeline = wgpuDeviceCreateComputePipeline(device, &cpd);

    wgpuPipelineLayoutRelease(cpl);
    wgpuBindGroupLayoutRelease(cbgl);
    wgpuShaderModuleRelease(cs);

    /* ---- render pipeline (sample the storage texture) ---- */
    WGPUShaderModule sm = make_shader(renderShader);

    WGPUSamplerDescriptor sd;
    zero(&sd, sizeof(sd));
    sd.magFilter = WGPUFilterMode_Nearest;
    sd.minFilter = WGPUFilterMode_Nearest;
    sd.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    WGPUSampler samp = wgpuDeviceCreateSampler(device, &sd);

    WGPUBindGroupLayoutEntry re[2];
    zero(re, sizeof(re));
    re[0].binding = 0;
    re[0].visibility = WGPUShaderStage_Fragment;
    re[0].sampler.type = WGPUSamplerBindingType_Filtering;
    re[1].binding = 1;
    re[1].visibility = WGPUShaderStage_Fragment;
    re[1].texture.sampleType = WGPUTextureSampleType_Float;
    re[1].texture.viewDimension = WGPUTextureViewDimension_2D;
    WGPUBindGroupLayoutDescriptor rbgld;
    rbgld.nextInChain = NULL; rbgld.label.data = NULL; rbgld.label.length = 0;
    rbgld.entryCount = 2; rbgld.entries = re;
    WGPUBindGroupLayout rbgl = wgpuDeviceCreateBindGroupLayout(device, &rbgld);

    WGPUBufferDescriptor bd;
    zero(&bd, sizeof(bd));
    bd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    bd.size = sizeof(verts);
    vbuf = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, verts, sizeof(verts));

    WGPUBindGroupEntry rbe[2];
    zero(rbe, sizeof(rbe));
    rbe[0].binding = 0;
    rbe[0].sampler = samp;
    rbe[1].binding = 1;
    rbe[1].textureView = storageView;
    WGPUBindGroupDescriptor rbgd;
    rbgd.nextInChain = NULL; rbgd.label.data = NULL; rbgd.label.length = 0;
    rbgd.layout = rbgl; rbgd.entryCount = 2; rbgd.entries = rbe;
    renderBG = wgpuDeviceCreateBindGroup(device, &rbgd);

    WGPUPipelineLayoutDescriptor rpld;
    rpld.nextInChain = NULL; rpld.label.data = NULL; rpld.label.length = 0;
    rpld.bindGroupLayoutCount = 1; rpld.bindGroupLayouts = &rbgl;
    WGPUPipelineLayout rpl = wgpuDeviceCreatePipelineLayout(device, &rpld);

    WGPUVertexAttribute attrs[2];
    attrs[0].format = WGPUVertexFormat_Float32x2; attrs[0].offset = 0; attrs[0].shaderLocation = 0;
    attrs[1].format = WGPUVertexFormat_Float32x2; attrs[1].offset = 8; attrs[1].shaderLocation = 1;
    WGPUVertexBufferLayout vbl;
    vbl.arrayStride = 16; vbl.stepMode = WGPUVertexStepMode_Vertex;
    vbl.attributeCount = 2; vbl.attributes = attrs;

    WGPUColorTargetState target;
    target.nextInChain = NULL; target.format = format; target.blend = NULL;
    target.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fs;
    fs.nextInChain = NULL; fs.module = sm;
    fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0; fs.constants = NULL; fs.targetCount = 1; fs.targets = &target;

    WGPURenderPipelineDescriptor pd;
    pd.nextInChain = NULL; pd.label.data = NULL; pd.label.length = 0;
    pd.layout = rpl;
    pd.vertex.nextInChain = NULL; pd.vertex.module = sm;
    pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
    pd.vertex.constantCount = 0; pd.vertex.constants = NULL;
    pd.vertex.bufferCount = 1; pd.vertex.buffers = &vbl;
    pd.primitive.nextInChain = NULL;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
    pd.primitive.frontFace = WGPUFrontFace_CCW;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.depthStencil = NULL;
    pd.multisample.nextInChain = NULL;
    pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF; pd.multisample.alphaToCoverageEnabled = 0;
    pd.fragment = &fs;
    pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);

    wgpuPipelineLayoutRelease(rpl);
    wgpuBindGroupLayoutRelease(rbgl);
    wgpuSamplerRelease(samp);
    wgpuShaderModuleRelease(sm);
    wgpuTextureRelease(stex);
}

static void frame(void) {
    if (!ready) return;

    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;

    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    /* compute pass: write pink into the storage texture */
    WGPUComputePassDescriptor cpdesc;
    zero(&cpdesc, sizeof(cpdesc));
    WGPUComputePassEncoder cp = wgpuCommandEncoderBeginComputePass(enc, &cpdesc);
    wgpuComputePassEncoderSetPipeline(cp, computePipeline);
    wgpuComputePassEncoderSetBindGroup(cp, 0, computeBG, 0, NULL);
    wgpuComputePassEncoderDispatchWorkgroups(cp, 8, 8, 1);
    wgpuComputePassEncoderEnd(cp);
    wgpuComputePassEncoderRelease(cp);

    /* render pass: sample the storage texture onto the quad */
    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL;
    att.view = view;
    att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL;
    att.loadOp = WGPULoadOp_Clear;
    att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 0.10; att.clearValue.g = 0.15; att.clearValue.b = 0.35; att.clearValue.a = 1.0;
    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att; rp.depthStencilAttachment = NULL;

    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, renderBG, 0, NULL);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDraw(pass, 6, 1, 0, 0);
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
    printf("webgpu storagetex: main done, waiting for adapter\n");
    return 0;
}
