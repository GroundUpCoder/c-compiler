/* WebGPU stencil testing (Tier 3). Two draws in one pass against a
   depth24plus-stencil8 attachment:
   (A) a SMALL centered quad writes stencil=1 in its region (compare Always,
       passOp Replace, ref 1), painting it blue (= clear, so invisible);
   (B) a FULLSCREEN green quad draws only where stencil==1 (compare Equal, ref 1).
   So green is MASKED to the small quad: center GREEN, corners BLUE. Without the
   stencil test the fullscreen green would cover everything. Exercises the stencil
   face states in the pipeline + the stencil attachment + SetStencilReference.
   Driven by webgpu-stencil-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeWrite;   /* A: write stencil */
static WGPURenderPipeline pipeTest;    /* B: test stencil */
static WGPUBuffer vbuf;
static WGPUTexture dsTex;
static WGPUTextureView dsView;
static WGPUTextureFormat format;
static int ready = 0;

/* verts 0-5: small quad (+-0.3). verts 6-11: fullscreen quad (+-1.0). */
static const float verts[] = {
    -0.3f, -0.3f,  0.3f, -0.3f,  0.3f, 0.3f,
    -0.3f, -0.3f,  0.3f,  0.3f, -0.3f, 0.3f,
    -1.0f, -1.0f,  1.0f, -1.0f,  1.0f, 1.0f,
    -1.0f, -1.0f,  1.0f,  1.0f, -1.0f, 1.0f,
};

static const char *shader =
"@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f { return vec4f(p, 0.0, 1.0); }\n"
"@fragment fn fsBlue() -> @location(0) vec4f { return vec4f(0.0, 0.0, 1.0, 1.0); }\n"
"@fragment fn fsGreen() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }\n";

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

/* Build a pipeline: given fragment entry + a stencil compare/passOp (applied to
   both faces, since cullMode=none). writeMask 0xFF for the writer, 0 for the tester. */
static WGPURenderPipeline make_pipeline(WGPUShaderModule sm, const char *fragEntry,
        WGPUCompareFunction stencilCompare, WGPUStencilOperation passOp, unsigned writeMask,
        WGPUVertexBufferLayout *vbl) {
    WGPUColorTargetState target;
    target.nextInChain = NULL;
    target.format = format;
    target.blend = NULL;
    target.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fs;
    fs.nextInChain = NULL;
    fs.module = sm;
    fs.entryPoint.data = fragEntry;
    fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0;
    fs.constants = NULL;
    fs.targetCount = 1;
    fs.targets = &target;

    WGPUDepthStencilState ds;
    { char *z = (char *)&ds; for (size_t i = 0; i < sizeof(ds); i++) z[i] = 0; }
    ds.format = WGPUTextureFormat_Depth24PlusStencil8;
    ds.depthWriteEnabled = 0;
    ds.depthCompare = WGPUCompareFunction_Always;
    ds.stencilFront.compare = stencilCompare;
    ds.stencilFront.failOp = WGPUStencilOperation_Keep;
    ds.stencilFront.depthFailOp = WGPUStencilOperation_Keep;
    ds.stencilFront.passOp = passOp;
    ds.stencilBack = ds.stencilFront;
    ds.stencilReadMask = 0xFF;
    ds.stencilWriteMask = writeMask;

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
    pd.vertex.bufferCount = 1;
    pd.vertex.buffers = vbl;
    pd.primitive.nextInChain = NULL;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
    pd.primitive.frontFace = WGPUFrontFace_CCW;
    pd.primitive.cullMode = WGPUCullMode_None;
    pd.depthStencil = &ds;
    pd.multisample.nextInChain = NULL;
    pd.multisample.count = 1;
    pd.multisample.mask = 0xFFFFFFFF;
    pd.multisample.alphaToCoverageEnabled = 0;
    pd.fragment = &fs;
    return wgpuDeviceCreateRenderPipeline(device, &pd);
}

static void build(void) {
    WGPUShaderModule sm = make_shader();

    WGPUBufferDescriptor vd;
    vd.nextInChain = NULL; vd.label.data = NULL; vd.label.length = 0;
    vd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    vd.size = sizeof(verts);
    vd.mappedAtCreation = 0;
    vbuf = wgpuDeviceCreateBuffer(device, &vd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, verts, sizeof(verts));

    WGPUTextureDescriptor dtd;
    { char *z = (char *)&dtd; for (size_t i = 0; i < sizeof(dtd); i++) z[i] = 0; }
    dtd.usage = WGPUTextureUsage_RenderAttachment;
    dtd.dimension = WGPUTextureDimension_2D;
    dtd.size.width = 640; dtd.size.height = 480; dtd.size.depthOrArrayLayers = 1;
    dtd.format = WGPUTextureFormat_Depth24PlusStencil8;
    dtd.mipLevelCount = 1; dtd.sampleCount = 1;
    dsTex = wgpuDeviceCreateTexture(device, &dtd);
    dsView = wgpuTextureCreateView(dsTex, NULL);

    static WGPUVertexAttribute attr;
    attr.format = WGPUVertexFormat_Float32x2;
    attr.offset = 0;
    attr.shaderLocation = 0;
    static WGPUVertexBufferLayout vbl;
    vbl.arrayStride = 8;
    vbl.stepMode = WGPUVertexStepMode_Vertex;
    vbl.attributeCount = 1;
    vbl.attributes = &attr;

    /* A: write stencil=1 everywhere it draws (compare Always, replace, write). */
    pipeWrite = make_pipeline(sm, "fsBlue", WGPUCompareFunction_Always, WGPUStencilOperation_Replace, 0xFF, &vbl);
    /* B: draw only where stencil==1 (compare Equal, keep, no write). */
    pipeTest = make_pipeline(sm, "fsGreen", WGPUCompareFunction_Equal, WGPUStencilOperation_Keep, 0x00, &vbl);

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
    att.clearValue.r = 0.0; att.clearValue.g = 0.0; att.clearValue.b = 1.0; att.clearValue.a = 1.0;

    WGPURenderPassDepthStencilAttachment dsAtt;
    { char *z = (char *)&dsAtt; for (size_t i = 0; i < sizeof(dsAtt); i++) z[i] = 0; }
    dsAtt.view = dsView;
    dsAtt.depthLoadOp = WGPULoadOp_Clear;
    dsAtt.depthStoreOp = WGPUStoreOp_Store;
    dsAtt.depthClearValue = 1.0f;
    dsAtt.stencilLoadOp = WGPULoadOp_Clear;
    dsAtt.stencilStoreOp = WGPUStoreOp_Store;
    dsAtt.stencilClearValue = 0;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att;
    rp.depthStencilAttachment = &dsAtt;

    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetStencilReference(pass, 1);
    /* A: small quad writes stencil=1 in its region (verts 0-5). */
    wgpuRenderPassEncoderSetPipeline(pass, pipeWrite);
    wgpuRenderPassEncoderDraw(pass, 6, 1, 0, 0);
    /* B: fullscreen green, but only passes where stencil==1 (verts 6-11). */
    wgpuRenderPassEncoderSetPipeline(pass, pipeTest);
    wgpuRenderPassEncoderDraw(pass, 6, 1, 6, 0);
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

    build();
    ready = 1;
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
    printf("webgpu stencil: main done, waiting for adapter\n");
    return 0;
}
