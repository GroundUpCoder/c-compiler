/* WebGPU compute pipeline (Tier 3). A compute shader doubles a 64-element u32
   storage buffer on the GPU; the result is copied to a MAP_READ buffer, read
   back into C, and VERIFIED element-by-element (data[i] == 2*i). The surface is
   then painted GREEN if every element is correct, RED otherwise — so the canvas
   harness asserts compute correctness. Exercises wgpuDeviceCreateComputePipeline
   / BeginComputePass / SetPipeline / SetBindGroup / DispatchWorkgroups / End +
   storage buffers + copyBufferToBuffer + readback. Driven by webgpu-compute-renders.mjs. */
#include <webgpu.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define N 64
#define BYTES (N * 4)

static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUTextureFormat format;
static WGPUBuffer readbackBuf;
static int configured = 0;
static int pass = -1;   /* -1 = pending, 1 = pass, 0 = fail */

static const char *shader =
"@group(0) @binding(0) var<storage, read_write> data: array<u32>;\n"
"@compute @workgroup_size(64)\n"
"fn main(@builtin(global_invocation_id) gid: vec3u) {\n"
"  let i = gid.x;\n"
"  data[i] = data[i] * 2u;\n"
"}\n";

static void zero(void *p, size_t n) { char *z = (char *)p; for (size_t i = 0; i < n; i++) z[i] = 0; }

static void on_mapped(WGPUMapAsyncStatus status, WGPUStringView msg, void *ud1, void *ud2) {
    (void)msg; (void)ud1; (void)ud2;
    if (status != WGPUMapAsyncStatus_Success) { printf("mapAsync failed: %d\n", (int)status); pass = 0; return; }
    const uint32_t *out = (const uint32_t *)wgpuBufferGetConstMappedRange(readbackBuf, 0, BYTES);
    int ok = 1;
    for (uint32_t i = 0; i < N; i++) {
        if (out[i] != i * 2u) { ok = 0; printf("MISMATCH at %u: got %u want %u\n", i, out[i], i * 2u); break; }
    }
    printf("COMPUTE %s data[1]=%u data[10]=%u data[63]=%u\n", ok ? "PASS" : "FAIL", out[1], out[10], out[63]);
    pass = ok;
    wgpuBufferUnmap(readbackBuf);
}

static void run_compute(void) {
    /* Input [0,1,2,...,63] in a storage buffer (read_write, copy-able out). */
    uint32_t input[N];
    for (uint32_t i = 0; i < N; i++) input[i] = i;

    WGPUBufferDescriptor sd;
    zero(&sd, sizeof(sd));
    sd.usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst | WGPUBufferUsage_CopySrc;
    sd.size = BYTES;
    WGPUBuffer storage = wgpuDeviceCreateBuffer(device, &sd);
    wgpuQueueWriteBuffer(queue, storage, 0, input, BYTES);

    WGPUBufferDescriptor rd;
    zero(&rd, sizeof(rd));
    rd.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    rd.size = BYTES;
    readbackBuf = wgpuDeviceCreateBuffer(device, &rd);

    /* Shader + bind group layout (one storage buffer, compute-visible). */
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL;
    wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader;
    wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor smd;
    smd.nextInChain = (const WGPUChainedStruct *)&wgsl;
    smd.label.data = NULL; smd.label.length = 0;
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &smd);

    WGPUBindGroupLayoutEntry ble;
    zero(&ble, sizeof(ble));
    ble.binding = 0;
    ble.visibility = WGPUShaderStage_Compute;
    ble.buffer.type = WGPUBufferBindingType_Storage;
    WGPUBindGroupLayoutDescriptor bld;
    bld.nextInChain = NULL; bld.label.data = NULL; bld.label.length = 0;
    bld.entryCount = 1; bld.entries = &ble;
    WGPUBindGroupLayout bgl = wgpuDeviceCreateBindGroupLayout(device, &bld);

    WGPUBindGroupEntry bge;
    zero(&bge, sizeof(bge));
    bge.binding = 0;
    bge.buffer = storage;
    bge.offset = 0;
    bge.size = BYTES;
    WGPUBindGroupDescriptor bgd;
    bgd.nextInChain = NULL; bgd.label.data = NULL; bgd.label.length = 0;
    bgd.layout = bgl; bgd.entryCount = 1; bgd.entries = &bge;
    WGPUBindGroup bindGroup = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUPipelineLayoutDescriptor pld;
    pld.nextInChain = NULL; pld.label.data = NULL; pld.label.length = 0;
    pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &bgl;
    WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

    WGPUComputePipelineDescriptor cpd;
    zero(&cpd, sizeof(cpd));
    cpd.layout = pl;
    cpd.compute.module = sm;
    cpd.compute.entryPoint.data = "main";
    cpd.compute.entryPoint.length = WGPU_STRLEN;
    WGPUComputePipeline pipeline = wgpuDeviceCreateComputePipeline(device, &cpd);

    /* Encode the compute pass + copy result to the readback buffer. */
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPUComputePassEncoder cpass = wgpuCommandEncoderBeginComputePass(enc, NULL);
    wgpuComputePassEncoderSetPipeline(cpass, pipeline);
    wgpuComputePassEncoderSetBindGroup(cpass, 0, bindGroup, 0, NULL);
    wgpuComputePassEncoderDispatchWorkgroups(cpass, 1, 1, 1);
    wgpuComputePassEncoderEnd(cpass);
    wgpuCommandEncoderCopyBufferToBuffer(enc, storage, 0, readbackBuf, 0, BYTES);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);

    WGPUBufferMapCallbackInfo ci;
    ci.nextInChain = NULL;
    ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_mapped;
    ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuBufferMapAsync(readbackBuf, WGPUMapMode_Read, 0, BYTES, ci);

    wgpuCommandBufferRelease(cmd);
    wgpuComputePassEncoderRelease(cpass);
    wgpuCommandEncoderRelease(enc);
    wgpuComputePipelineRelease(pipeline);
    wgpuPipelineLayoutRelease(pl);
    wgpuBindGroupRelease(bindGroup);
    wgpuBindGroupLayoutRelease(bgl);
    wgpuShaderModuleRelease(sm);
    wgpuBufferRelease(storage);
}

static void frame(void) {
    if (!configured) return;

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
    /* green = pass, red = fail, black = pending. */
    att.clearValue.r = (pass == 0) ? 1.0 : 0.0;
    att.clearValue.g = (pass == 1) ? 1.0 : 0.0;
    att.clearValue.b = 0.0;
    att.clearValue.a = 1.0;

    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att; rp.depthStencilAttachment = NULL;
    WGPURenderPassEncoder rpass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderEnd(rpass);

    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuSurfacePresent(surface);

    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(rpass);
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
    configured = 1;

    run_compute();
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
    printf("webgpu compute: main done, waiting for adapter\n");
    return 0;
}
