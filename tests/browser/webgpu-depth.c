/* WebGPU depth testing (Tier 3). Two overlapping triangles cover the center:
   GREEN at z=0.2 (near) is drawn FIRST, RED at z=0.8 (far) is drawn SECOND.
   With depth testing (compare Less, depth-write on) the later red FAILS the
   depth test and is occluded -> center stays GREEN. Without a depth buffer the
   later red would overwrite -> center red. So a green center proves the depth
   attachment + depthStencil pipeline state work. Driven by webgpu-depth-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static WGPUBuffer vbuf;
static WGPUTexture depthTex;
static WGPUTextureView depthView;
static WGPUTextureFormat format;
static int ready = 0;

/* [x, y, z,  r, g, b] — green tri (z=0.2) first, red tri (z=0.8) second; same
   x,y so they fully overlap at the center. */
static const float verts[] = {
    -0.6f, -0.6f, 0.2f,   0.0f, 1.0f, 0.0f,
     0.6f, -0.6f, 0.2f,   0.0f, 1.0f, 0.0f,
     0.0f,  0.6f, 0.2f,   0.0f, 1.0f, 0.0f,
    -0.6f, -0.6f, 0.8f,   1.0f, 0.0f, 0.0f,
     0.6f, -0.6f, 0.8f,   1.0f, 0.0f, 0.0f,
     0.0f,  0.6f, 0.8f,   1.0f, 0.0f, 0.0f,
};

static const char *shader =
"struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec3f };\n"
"@vertex fn vs(@location(0) p: vec3f, @location(1) c: vec3f) -> VOut {\n"
"  var o: VOut;\n"
"  o.pos = vec4f(p, 1.0);\n"
"  o.color = c;\n"
"  return o;\n"
"}\n"
"@fragment fn fs(@location(0) c: vec3f) -> @location(0) vec4f { return vec4f(c, 1.0); }\n";

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

static void build(void) {
    WGPUShaderModule sm = make_shader();

    WGPUBufferDescriptor vd;
    vd.nextInChain = NULL; vd.label.data = NULL; vd.label.length = 0;
    vd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    vd.size = sizeof(verts);
    vd.mappedAtCreation = 0;
    vbuf = wgpuDeviceCreateBuffer(device, &vd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, verts, sizeof(verts));

    /* Depth buffer (matches the 640x480 surface). */
    WGPUTextureDescriptor dtd;
    { char *z = (char *)&dtd; for (size_t i = 0; i < sizeof(dtd); i++) z[i] = 0; }
    dtd.usage = WGPUTextureUsage_RenderAttachment;
    dtd.dimension = WGPUTextureDimension_2D;
    dtd.size.width = 640; dtd.size.height = 480; dtd.size.depthOrArrayLayers = 1;
    dtd.format = WGPUTextureFormat_Depth24Plus;
    dtd.mipLevelCount = 1; dtd.sampleCount = 1;
    depthTex = wgpuDeviceCreateTexture(device, &dtd);
    depthView = wgpuTextureCreateView(depthTex, NULL);

    WGPUVertexAttribute attrs[2];
    attrs[0].format = WGPUVertexFormat_Float32x3;
    attrs[0].offset = 0;
    attrs[0].shaderLocation = 0;
    attrs[1].format = WGPUVertexFormat_Float32x3;
    attrs[1].offset = 12;
    attrs[1].shaderLocation = 1;
    WGPUVertexBufferLayout vbl;
    vbl.arrayStride = 24;
    vbl.stepMode = WGPUVertexStepMode_Vertex;
    vbl.attributeCount = 2;
    vbl.attributes = attrs;

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

    /* Depth-stencil state: test + write, Less. Stencil left at defaults. */
    WGPUDepthStencilState ds;
    { char *z = (char *)&ds; for (size_t i = 0; i < sizeof(ds); i++) z[i] = 0; }
    ds.format = WGPUTextureFormat_Depth24Plus;
    ds.depthWriteEnabled = 1;
    ds.depthCompare = WGPUCompareFunction_Less;

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
    pd.vertex.buffers = &vbl;
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
    att.clearValue.r = 0.0; att.clearValue.g = 0.0; att.clearValue.b = 0.3; att.clearValue.a = 1.0;

    WGPURenderPassDepthStencilAttachment depthAtt;
    { char *z = (char *)&depthAtt; for (size_t i = 0; i < sizeof(depthAtt); i++) z[i] = 0; }
    depthAtt.view = depthView;
    depthAtt.depthLoadOp = WGPULoadOp_Clear;
    depthAtt.depthStoreOp = WGPUStoreOp_Store;
    depthAtt.depthClearValue = 1.0f;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att;
    rp.depthStencilAttachment = &depthAtt;

    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderSetPipeline(pass, pipeline);
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
    printf("webgpu depth: main done, waiting for adapter\n");
    return 0;
}
