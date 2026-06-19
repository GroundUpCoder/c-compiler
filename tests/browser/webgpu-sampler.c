/* WebGPU sampler completeness (A13): comparison sampler + lodMinClamp /
   lodMaxClamp / maxAnisotropy. A depth32float texture is cleared to depth 0.5,
   then sampled with a COMPARISON sampler (compare = Less) via
   textureSampleCompare(depth, ref=0.3): Less passes because 0.3 < 0.5, so the
   compare result is 1.0 -> the surface is painted GREEN; a mismatch would be
   red, and if `compare` were dropped the comparison BGL/sampler pair would fail
   validation (no render at all). The sampler also sets non-default lod clamps and
   maxAnisotropy (with linear filters) to exercise those fields. Driven by
   webgpu-sampler-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdio.h>

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static WGPUBindGroup bindGroup;
static WGPUTexture depthTex;
static WGPUTextureView depthView;
static WGPUTextureFormat format;
static int ready = 0;
static int depthWritten = 0;

static const char *shader =
"@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
"  var p = array<vec2f,3>(vec2f(-1.0,-3.0), vec2f(-1.0,1.0), vec2f(3.0,1.0));\n"
"  return vec4f(p[i], 0.0, 1.0);\n"
"}\n"
"@group(0) @binding(0) var cmp: sampler_comparison;\n"
"@group(0) @binding(1) var depthTex: texture_depth_2d;\n"
"@fragment fn fs() -> @location(0) vec4f {\n"
"  let s = textureSampleCompare(depthTex, cmp, vec2f(0.5, 0.5), 0.3);\n"
"  return vec4f(1.0 - s, s, 0.0, 1.0);\n"
"}\n";

static void zero(void *p, size_t n) { char *z = (char *)p; for (size_t i = 0; i < n; i++) z[i] = 0; }

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

    /* Depth texture (sampled later as a depth_2d). */
    WGPUTextureDescriptor td;
    zero(&td, sizeof(td));
    td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    td.dimension = WGPUTextureDimension_2D;
    td.size.width = 64; td.size.height = 64; td.size.depthOrArrayLayers = 1;
    td.format = WGPUTextureFormat_Depth32Float;
    td.mipLevelCount = 1; td.sampleCount = 1;
    depthTex = wgpuDeviceCreateTexture(device, &td);
    depthView = wgpuTextureCreateView(depthTex, NULL);

    /* Comparison sampler: compare=Less, linear filters, non-default lod clamps,
       maxAnisotropy=4 (valid only with all-linear filters). */
    WGPUSamplerDescriptor sd;
    zero(&sd, sizeof(sd));
    sd.addressModeU = WGPUAddressMode_ClampToEdge;
    sd.addressModeV = WGPUAddressMode_ClampToEdge;
    sd.addressModeW = WGPUAddressMode_ClampToEdge;
    sd.magFilter = WGPUFilterMode_Linear;
    sd.minFilter = WGPUFilterMode_Linear;
    sd.mipmapFilter = WGPUMipmapFilterMode_Linear;
    sd.lodMinClamp = 0.0f;
    sd.lodMaxClamp = 4.0f;
    sd.maxAnisotropy = 4;
    sd.compare = WGPUCompareFunction_Less;
    WGPUSampler samp = wgpuDeviceCreateSampler(device, &sd);

    /* BGL: comparison sampler @0, depth texture @1. */
    WGPUBindGroupLayoutEntry e[2];
    zero(e, sizeof(e));
    e[0].binding = 0; e[0].visibility = WGPUShaderStage_Fragment;
    e[0].sampler.type = WGPUSamplerBindingType_Comparison;
    e[1].binding = 1; e[1].visibility = WGPUShaderStage_Fragment;
    e[1].texture.sampleType = WGPUTextureSampleType_Depth;
    e[1].texture.viewDimension = WGPUTextureViewDimension_2D;
    WGPUBindGroupLayoutDescriptor bgld;
    bgld.nextInChain = NULL; bgld.label.data = NULL; bgld.label.length = 0;
    bgld.entryCount = 2; bgld.entries = e;
    WGPUBindGroupLayout bgl = wgpuDeviceCreateBindGroupLayout(device, &bgld);

    WGPUBindGroupEntry be[2];
    zero(be, sizeof(be));
    be[0].binding = 0; be[0].sampler = samp;
    be[1].binding = 1; be[1].textureView = depthView;
    WGPUBindGroupDescriptor bgd;
    bgd.nextInChain = NULL; bgd.label.data = NULL; bgd.label.length = 0;
    bgd.layout = bgl; bgd.entryCount = 2; bgd.entries = be;
    bindGroup = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUPipelineLayoutDescriptor pld;
    pld.nextInChain = NULL; pld.label.data = NULL; pld.label.length = 0;
    pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &bgl;
    WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

    WGPUColorTargetState target;
    target.nextInChain = NULL; target.format = format; target.blend = NULL;
    target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fs;
    fs.nextInChain = NULL; fs.module = sm; fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0; fs.constants = NULL; fs.targetCount = 1; fs.targets = &target;

    WGPURenderPipelineDescriptor pd;
    zero(&pd, sizeof(pd));
    pd.layout = pl;
    pd.vertex.module = sm; pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.frontFace = WGPUFrontFace_CCW; pd.primitive.cullMode = WGPUCullMode_None;
    pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
    pd.fragment = &fs;
    pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);

    wgpuPipelineLayoutRelease(pl);
    wgpuBindGroupLayoutRelease(bgl);
    wgpuSamplerRelease(samp);
    wgpuShaderModuleRelease(sm);
}

static void write_depth(void) {
    /* Depth-only render pass: clear the depth texture to 0.5 and store. */
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassDepthStencilAttachment dsa;
    zero(&dsa, sizeof(dsa));
    dsa.view = depthView;
    dsa.depthLoadOp = WGPULoadOp_Clear;
    dsa.depthStoreOp = WGPUStoreOp_Store;
    dsa.depthClearValue = 0.5f;
    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 0; rp.colorAttachments = NULL; rp.depthStencilAttachment = &dsa;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    depthWritten = 1;
}

static void frame(void) {
    if (!ready) return;
    if (!depthWritten) write_depth();

    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = 0.0; att.clearValue.g = 0.0; att.clearValue.b = 1.0; att.clearValue.a = 1.0;
    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att; rp.depthStencilAttachment = NULL;
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
    printf("webgpu sampler: main done, waiting for adapter\n");
    return 0;
}
