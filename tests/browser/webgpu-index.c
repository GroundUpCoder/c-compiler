/* WebGPU indexed quad (Tier 1). A pink quad drawn as 4 vertices + a 6-index
   uint16 index buffer via DrawIndexed — exercises SetIndexBuffer + DrawIndexed.
   Centered on the dark-blue clear (center pink, corner clear). Driven by
   webgpu-index-renders.mjs. */
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
static WGPUBuffer ibuf;
static WGPUTextureFormat format;
static int ready = 0;

/* 4 corners (vec2), centered quad. */
static const float verts[] = {
    -0.7f, -0.7f,
     0.7f, -0.7f,
     0.7f,  0.7f,
    -0.7f,  0.7f,
};
/* 2 triangles: (0,1,2) (0,2,3). */
static const unsigned short indices[] = { 0, 1, 2, 0, 2, 3 };

static const char *shader =
"@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f {\n"
"  return vec4f(p, 0.0, 1.0);\n"
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

static void build(void) {
    WGPUShaderModule sm = make_shader();

    WGPUBufferDescriptor vd;
    vd.nextInChain = NULL; vd.label.data = NULL; vd.label.length = 0;
    vd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    vd.size = sizeof(verts);
    vd.mappedAtCreation = 0;
    vbuf = wgpuDeviceCreateBuffer(device, &vd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, verts, sizeof(verts));

    WGPUBufferDescriptor id;
    id.nextInChain = NULL; id.label.data = NULL; id.label.length = 0;
    id.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
    id.size = sizeof(indices);
    id.mappedAtCreation = 0;
    ibuf = wgpuDeviceCreateBuffer(device, &id);
    wgpuQueueWriteBuffer(queue, ibuf, 0, indices, sizeof(indices));

    WGPUVertexAttribute attr;
    attr.format = WGPUVertexFormat_Float32x2;
    attr.offset = 0;
    attr.shaderLocation = 0;

    WGPUVertexBufferLayout vbl;
    vbl.arrayStride = 8;
    vbl.stepMode = WGPUVertexStepMode_Vertex;
    vbl.attributeCount = 1;
    vbl.attributes = &attr;

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
    pd.vertex.bufferCount = 1;
    pd.vertex.buffers = &vbl;
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
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(pass, ibuf, WGPUIndexFormat_Uint16, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(pass, 6, 1, 0, 0, 0);
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
    printf("webgpu indexed quad: main done, waiting for adapter\n");
    return 0;
}
