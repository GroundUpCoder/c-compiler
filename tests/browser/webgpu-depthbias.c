/* WebGPU depth-stencil completeness (A14): depthBias (+ slope/clamp),
   depthReadOnly (render-pass attachment), and primitive stripIndexFormat.

   A depth16unorm texture is used so the constant depth-bias unit (1/65535) is
   well-defined (unlike float depth). Two passes share it:
     - Pass 1 writes depth 0.5 everywhere (A, red, depthCompare=Always, write on).
     - Pass 2 has a READ-ONLY depth attachment and draws a fullscreen quad as a
       TRIANGLE-STRIP with an INDEXED draw (so stripIndexFormat must be honored).
       Its fragment depth is 0.51 (> 0.5) with depthCompare=Less, so it would FAIL
       (stay red) — but the pipeline applies depthBias = -2048 (≈ -0.031), pulling
       it to ~0.479 < 0.5, so Less PASSES and the quad paints GREEN.
   Green therefore proves all three: depthBias had an effect, the read-only depth
   attachment was accepted, and the indexed strip drew. Driven by
   webgpu-depthbias-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline writePipe;   /* pass 1: writes depth */
static WGPURenderPipeline biasPipe;    /* pass 2: strip + depthBias, read-only depth */
static WGPUBuffer vbuf, ibuf;
static WGPUTexture depthTex;
static WGPUTextureView depthView;
static WGPUTextureFormat format;
static int ready = 0;
static int depthWritten = 0;

/* Pass 1: fullscreen triangle at z=0.5, red, depth-writing. */
static const char *writeShader =
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  var p = array<vec2f,3>(vec2f(-1.0,-3.0), vec2f(-1.0,1.0), vec2f(3.0,1.0));\n"
"  return vec4f(p[i], 0.5, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }\n";

/* Pass 2: triangle-strip quad at z=0.51, green; relies on depthBias to pass. */
static const char *biasShader =
"@vertex fn vs(@location(0) p: vec2f) -> @builtin(position) vec4f {\n"
"  return vec4f(p, 0.51, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }\n";

/* Fullscreen quad as a triangle strip: BL, BR, TL, TR. */
static const float quad[] = { -1.0f, -1.0f,   1.0f, -1.0f,  -1.0f, 1.0f,   1.0f, 1.0f };
static const uint16_t quadIdx[] = { 0, 1, 2, 3 };

static void zero(void *p, size_t n) { char *z = (char *)p; for (size_t i = 0; i < n; i++) z[i] = 0; }

static WGPUShaderModule make_shader(const char *src) {
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL; wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = src; wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor d;
    d.nextInChain = (const WGPUChainedStruct *)&wgsl; d.label.data = NULL; d.label.length = 0;
    return wgpuDeviceCreateShaderModule(device, &d);
}

static void build(void) {
    /* Depth texture (depth16unorm: well-defined constant depth-bias unit). */
    WGPUTextureDescriptor td;
    zero(&td, sizeof(td));
    td.usage = WGPUTextureUsage_RenderAttachment;
    td.dimension = WGPUTextureDimension_2D;
    td.size.width = 640; td.size.height = 480; td.size.depthOrArrayLayers = 1;
    td.format = WGPUTextureFormat_Depth16Unorm;
    td.mipLevelCount = 1; td.sampleCount = 1;
    depthTex = wgpuDeviceCreateTexture(device, &td);
    depthView = wgpuTextureCreateView(depthTex, NULL);

    /* Vertex + index buffers for the strip quad. */
    WGPUBufferDescriptor vd; zero(&vd, sizeof(vd));
    vd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst; vd.size = sizeof(quad);
    vbuf = wgpuDeviceCreateBuffer(device, &vd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, quad, sizeof(quad));
    WGPUBufferDescriptor id; zero(&id, sizeof(id));
    id.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst; id.size = sizeof(quadIdx);
    ibuf = wgpuDeviceCreateBuffer(device, &id);
    wgpuQueueWriteBuffer(queue, ibuf, 0, quadIdx, sizeof(quadIdx));

    WGPUColorTargetState target;
    target.nextInChain = NULL; target.format = format; target.blend = NULL;
    target.writeMask = WGPUColorWriteMask_All;

    /* Pass-1 pipeline: depth write on, compare Always. */
    {
        WGPUShaderModule sm = make_shader(writeShader);
        WGPUFragmentState fs; zero(&fs, sizeof(fs));
        fs.module = sm; fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
        fs.targetCount = 1; fs.targets = &target;
        WGPUDepthStencilState ds; zero(&ds, sizeof(ds));
        ds.format = WGPUTextureFormat_Depth16Unorm;
        ds.depthWriteEnabled = 1; ds.depthCompare = WGPUCompareFunction_Always;
        WGPURenderPipelineDescriptor pd; zero(&pd, sizeof(pd));
        pd.layout = NULL;
        pd.vertex.module = sm; pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
        pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
        pd.primitive.frontFace = WGPUFrontFace_CCW; pd.primitive.cullMode = WGPUCullMode_None;
        pd.depthStencil = &ds;
        pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
        pd.fragment = &fs;
        writePipe = wgpuDeviceCreateRenderPipeline(device, &pd);
        wgpuShaderModuleRelease(sm);
    }

    /* Pass-2 pipeline: triangle-strip (needs stripIndexFormat), depth read-only
       (write off), compare Less, negative depthBias to make z=0.51 pass < 0.5. */
    {
        WGPUShaderModule sm = make_shader(biasShader);
        WGPUVertexAttribute attr; attr.format = WGPUVertexFormat_Float32x2; attr.offset = 0; attr.shaderLocation = 0;
        WGPUVertexBufferLayout vbl; vbl.arrayStride = 8; vbl.stepMode = WGPUVertexStepMode_Vertex;
        vbl.attributeCount = 1; vbl.attributes = &attr;
        WGPUFragmentState fs; zero(&fs, sizeof(fs));
        fs.module = sm; fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
        fs.targetCount = 1; fs.targets = &target;
        WGPUDepthStencilState ds; zero(&ds, sizeof(ds));
        ds.format = WGPUTextureFormat_Depth16Unorm;
        ds.depthWriteEnabled = 0; ds.depthCompare = WGPUCompareFunction_Less;
        ds.depthBias = -2048; ds.depthBiasSlopeScale = 0.0f; ds.depthBiasClamp = 0.0f;
        WGPURenderPipelineDescriptor pd; zero(&pd, sizeof(pd));
        pd.layout = NULL;
        pd.vertex.module = sm; pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
        pd.vertex.bufferCount = 1; pd.vertex.buffers = &vbl;
        pd.primitive.topology = WGPUPrimitiveTopology_TriangleStrip;
        pd.primitive.stripIndexFormat = WGPUIndexFormat_Uint16;
        pd.primitive.frontFace = WGPUFrontFace_CCW; pd.primitive.cullMode = WGPUCullMode_None;
        pd.depthStencil = &ds;
        pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
        pd.fragment = &fs;
        biasPipe = wgpuDeviceCreateRenderPipeline(device, &pd);
        wgpuShaderModuleRelease(sm);
    }
}

static void frame(void) {
    if (!ready) return;
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 0.0; att.clearValue.g = 0.0; att.clearValue.b = 1.0; att.clearValue.a = 1.0;

    /* Pass 1: write depth 0.5 + paint red (depth write-enabled attachment). */
    WGPURenderPassDepthStencilAttachment dsaWrite;
    zero(&dsaWrite, sizeof(dsaWrite));
    dsaWrite.view = depthView;
    dsaWrite.depthLoadOp = WGPULoadOp_Clear; dsaWrite.depthStoreOp = WGPUStoreOp_Store;
    dsaWrite.depthClearValue = 1.0f;
    WGPURenderPassDescriptor rp1;
    rp1.nextInChain = NULL; rp1.label.data = NULL; rp1.label.length = 0;
    rp1.colorAttachmentCount = 1; rp1.colorAttachments = &att; rp1.depthStencilAttachment = &dsaWrite;
    WGPURenderPassEncoder pass1 = wgpuCommandEncoderBeginRenderPass(enc, &rp1);
    wgpuRenderPassEncoderSetPipeline(pass1, writePipe);
    wgpuRenderPassEncoderDraw(pass1, 3, 1, 0, 0);
    wgpuRenderPassEncoderEnd(pass1);

    /* Pass 2: read-only depth, indexed triangle-strip, depthBias decides green. */
    WGPURenderPassColorAttachment att2 = att;
    att2.loadOp = WGPULoadOp_Load;          /* keep pass-1's red unless we overwrite */
    WGPURenderPassDepthStencilAttachment dsaRead;
    zero(&dsaRead, sizeof(dsaRead));
    dsaRead.view = depthView;
    dsaRead.depthReadOnly = 1;              /* read-only: no load/store ops */
    WGPURenderPassDescriptor rp2;
    rp2.nextInChain = NULL; rp2.label.data = NULL; rp2.label.length = 0;
    rp2.colorAttachmentCount = 1; rp2.colorAttachments = &att2; rp2.depthStencilAttachment = &dsaRead;
    WGPURenderPassEncoder pass2 = wgpuCommandEncoderBeginRenderPass(enc, &rp2);
    wgpuRenderPassEncoderSetPipeline(pass2, biasPipe);
    wgpuRenderPassEncoderSetVertexBuffer(pass2, 0, vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(pass2, ibuf, WGPUIndexFormat_Uint16, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(pass2, 4, 1, 0, 0, 0);
    wgpuRenderPassEncoderEnd(pass2);

    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuSurfacePresent(surface);

    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(pass1);
    wgpuRenderPassEncoderRelease(pass2);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
    depthWritten = 1;
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success) { printf("requestDevice failed\n"); return; }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surface, adapter);

    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = format;
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
    printf("webgpu depthbias: main done, waiting for adapter\n");
    return 0;
}
