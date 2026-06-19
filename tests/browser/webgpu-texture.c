/* WebGPU textured quad (Tier 1 capstone). Integrates the whole tier: a vertex
   buffer (position + UV), a sampler + texture bind group, wgpuQueueWriteTexture,
   and WGSL textureSample. A centered quad on the dark-blue clear, textured with
   a solid-pink 2x2 texture -> center samples pink, corners stay clear (reuses
   the triangle test's pixel checks). Exercises wgpuDeviceCreateTexture /
   CreateSampler / QueueWriteTexture + the sampler/texture bind-group paths.
   Driven by webgpu-texture-renders.mjs. */
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
static WGPUBindGroup bindGroup;
static WGPUTextureFormat format;
static int ready = 0;

/* Centered quad, 2 triangles, interleaved [x, y, u, v]. */
static const float verts[] = {
    -0.7f, -0.7f,  0.0f, 1.0f,
     0.7f, -0.7f,  1.0f, 1.0f,
     0.7f,  0.7f,  1.0f, 0.0f,
    -0.7f, -0.7f,  0.0f, 1.0f,
     0.7f,  0.7f,  1.0f, 0.0f,
    -0.7f,  0.7f,  0.0f, 0.0f,
};

/* 2x2 RGBA8, every texel pink (255,51,204,255). Exercises bytesPerRow=8. */
static const unsigned char texels[2 * 2 * 4] = {
    255, 51, 204, 255,  255, 51, 204, 255,
    255, 51, 204, 255,  255, 51, 204, 255,
};

static const char *shader =
"struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };\n"
"@vertex fn vs(@location(0) p: vec2f, @location(1) uv: vec2f) -> VOut {\n"
"  var o: VOut;\n"
"  o.pos = vec4f(p, 0.0, 1.0);\n"
"  o.uv = uv;\n"
"  return o;\n"
"}\n"
"@group(0) @binding(0) var samp: sampler;\n"
"@group(0) @binding(1) var tex: texture_2d<f32>;\n"
"@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {\n"
"  return textureSample(tex, samp, uv);\n"
"}\n";

static void zero(void *p, size_t n) { char *z = (char *)p; for (size_t i = 0; i < n; i++) z[i] = 0; }

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

static WGPUTexture make_texture(void) {
    WGPUTextureDescriptor td;
    zero(&td, sizeof(td));
    td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    td.dimension = WGPUTextureDimension_2D;
    td.size.width = 2;
    td.size.height = 2;
    td.size.depthOrArrayLayers = 1;
    td.format = WGPUTextureFormat_RGBA8Unorm;
    td.mipLevelCount = 1;
    td.sampleCount = 1;
    WGPUTexture t = wgpuDeviceCreateTexture(device, &td);

    WGPUTexelCopyTextureInfo dst;
    zero(&dst, sizeof(dst));
    dst.texture = t;
    dst.mipLevel = 0;
    dst.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout;
    zero(&layout, sizeof(layout));
    layout.offset = 0;
    layout.bytesPerRow = 2 * 4;
    layout.rowsPerImage = 2;

    WGPUExtent3D ext;
    ext.width = 2;
    ext.height = 2;
    ext.depthOrArrayLayers = 1;

    wgpuQueueWriteTexture(queue, &dst, texels, sizeof(texels), &layout, &ext);
    return t;
}

static WGPUSampler make_sampler(void) {
    WGPUSamplerDescriptor sd;
    zero(&sd, sizeof(sd));
    sd.addressModeU = WGPUAddressMode_ClampToEdge;
    sd.addressModeV = WGPUAddressMode_ClampToEdge;
    sd.addressModeW = WGPUAddressMode_ClampToEdge;
    sd.magFilter = WGPUFilterMode_Nearest;
    sd.minFilter = WGPUFilterMode_Nearest;
    sd.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    return wgpuDeviceCreateSampler(device, &sd);
}

static WGPUBindGroupLayout make_bgl(void) {
    WGPUBindGroupLayoutEntry e[2];
    zero(e, sizeof(e));
    e[0].binding = 0;
    e[0].visibility = WGPUShaderStage_Fragment;
    e[0].sampler.type = WGPUSamplerBindingType_Filtering;
    e[1].binding = 1;
    e[1].visibility = WGPUShaderStage_Fragment;
    e[1].texture.sampleType = WGPUTextureSampleType_Float;
    e[1].texture.viewDimension = WGPUTextureViewDimension_2D;

    WGPUBindGroupLayoutDescriptor d;
    d.nextInChain = NULL;
    d.label.data = NULL;
    d.label.length = 0;
    d.entryCount = 2;
    d.entries = e;
    return wgpuDeviceCreateBindGroupLayout(device, &d);
}

static void build(void) {
    WGPUShaderModule sm = make_shader();
    WGPUTexture tex = make_texture();
    WGPUTextureView texView = wgpuTextureCreateView(tex, NULL);
    WGPUSampler samp = make_sampler();
    WGPUBindGroupLayout bgl = make_bgl();

    /* Vertex buffer. */
    WGPUBufferDescriptor bd;
    zero(&bd, sizeof(bd));
    bd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    bd.size = sizeof(verts);
    vbuf = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, verts, sizeof(verts));

    /* Bind group: sampler @0, texture view @1. */
    WGPUBindGroupEntry be[2];
    zero(be, sizeof(be));
    be[0].binding = 0;
    be[0].sampler = samp;
    be[1].binding = 1;
    be[1].textureView = texView;

    WGPUBindGroupDescriptor bgd;
    bgd.nextInChain = NULL;
    bgd.label.data = NULL;
    bgd.label.length = 0;
    bgd.layout = bgl;
    bgd.entryCount = 2;
    bgd.entries = be;
    bindGroup = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUPipelineLayoutDescriptor pld;
    pld.nextInChain = NULL;
    pld.label.data = NULL;
    pld.label.length = 0;
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &bgl;
    WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

    WGPUVertexAttribute attrs[2];
    attrs[0].format = WGPUVertexFormat_Float32x2;
    attrs[0].offset = 0;
    attrs[0].shaderLocation = 0;
    attrs[1].format = WGPUVertexFormat_Float32x2;
    attrs[1].offset = 8;
    attrs[1].shaderLocation = 1;

    WGPUVertexBufferLayout vbl;
    vbl.arrayStride = 16;
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

    wgpuPipelineLayoutRelease(pl);
    wgpuBindGroupLayoutRelease(bgl);
    wgpuSamplerRelease(samp);
    wgpuTextureViewRelease(texView);
    wgpuTextureRelease(tex);
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
    printf("webgpu texture quad: main done, waiting for adapter\n");
    return 0;
}
