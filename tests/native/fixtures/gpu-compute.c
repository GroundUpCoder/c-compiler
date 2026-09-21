/* WebGPU compute demo: GPU doubles an array, the CPU checks the readback.
   The API is callback based with no JSPI: main() registers the first
   request and a main-loop callback, and each completion advances a stage. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <webgpu.h>

#define COUNT 1024

static const char *shader =
    "@group(0) @binding(0) var<storage, read_write> data: array<f32>;\n"
    "@compute @workgroup_size(64)\n"
    "fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n"
    "  if (id.x < arrayLength(&data)) { data[id.x] = data[id.x] * 2.0 + 1.0; }\n"
    "}\n";

static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUBuffer readback;
static int stage;   /* 0 adapter pending, 1 adapter ready, 2 device ready,
                       3 map pending, 4 mapped, -1 failed */

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter a,
                       WGPUStringView message, void *ud1, void *ud2) {
    (void)message; (void)ud1; (void)ud2;
    if (status != WGPURequestAdapterStatus_Success || !a) {
        fprintf(stderr, "gpu-compute: no WebGPU adapter (status %d)\n", (int)status);
        stage = -1;
        return;
    }
    adapter = a;
    stage = 1;
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice d,
                      WGPUStringView message, void *ud1, void *ud2) {
    (void)message; (void)ud1; (void)ud2;
    if (status != WGPURequestDeviceStatus_Success || !d) {
        fprintf(stderr, "gpu-compute: device request failed (status %d)\n", (int)status);
        stage = -1;
        return;
    }
    device = d;
    stage = 2;
}

static void on_map(WGPUMapAsyncStatus status, WGPUStringView message, void *ud1, void *ud2) {
    (void)message; (void)ud1; (void)ud2;
    if (status != WGPUMapAsyncStatus_Success) {
        fprintf(stderr, "gpu-compute: buffer map failed (status %d)\n", (int)status);
        stage = -1;
        return;
    }
    stage = 4;
}

static void dispatch(void) {
    WGPUQueue queue = wgpuDeviceGetQueue(device);

    WGPUShaderSourceWGSL wgsl = {0};
    wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader;
    wgsl.code.length = strlen(shader);
    WGPUShaderModuleDescriptor sd = {0};
    sd.nextInChain = &wgsl.chain;
    WGPUShaderModule module = wgpuDeviceCreateShaderModule(device, &sd);

    static float input[COUNT];
    for (int i = 0; i < COUNT; i++) input[i] = (float)i;
    WGPUBufferDescriptor bd = {0};
    bd.size = sizeof input;
    bd.usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst;
    WGPUBuffer storage = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, storage, 0, input, sizeof input);
    bd.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    readback = wgpuDeviceCreateBuffer(device, &bd);

    WGPUBindGroupLayoutEntry le = {0};
    le.binding = 0;
    le.visibility = WGPUShaderStage_Compute;
    le.buffer.type = WGPUBufferBindingType_Storage;
    WGPUBindGroupLayoutDescriptor ld = {0};
    ld.entryCount = 1;
    ld.entries = &le;
    WGPUBindGroupLayout layout = wgpuDeviceCreateBindGroupLayout(device, &ld);
    WGPUPipelineLayoutDescriptor pld = {0};
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &layout;
    WGPUPipelineLayout pipelineLayout = wgpuDeviceCreatePipelineLayout(device, &pld);
    WGPUBindGroupEntry be = {0};
    be.binding = 0;
    be.buffer = storage;
    be.size = sizeof input;
    WGPUBindGroupDescriptor bgd = {0};
    bgd.layout = layout;
    bgd.entryCount = 1;
    bgd.entries = &be;
    WGPUBindGroup group = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUComputePipelineDescriptor cd = {0};
    cd.layout = pipelineLayout;
    cd.compute.module = module;
    cd.compute.entryPoint.data = "main";
    cd.compute.entryPoint.length = 4;
    WGPUComputePipeline pipeline = wgpuDeviceCreateComputePipeline(device, &cd);

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, NULL);
    wgpuComputePassEncoderSetPipeline(pass, pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, NULL);
    wgpuComputePassEncoderDispatchWorkgroups(pass, COUNT / 64, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuCommandEncoderCopyBufferToBuffer(encoder, storage, 0, readback, 0, sizeof input);
    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, NULL);
    wgpuQueueSubmit(queue, 1, &commands);

    WGPUBufferMapCallbackInfo mi = {0};
    mi.mode = WGPUCallbackMode_AllowProcessEvents;
    mi.callback = on_map;
    wgpuBufferMapAsync(readback, WGPUMapMode_Read, 0, sizeof input, mi);

    wgpuCommandBufferRelease(commands);
    wgpuComputePassEncoderRelease(pass);
    wgpuCommandEncoderRelease(encoder);
    wgpuComputePipelineRelease(pipeline);
    wgpuBindGroupRelease(group);
    wgpuPipelineLayoutRelease(pipelineLayout);
    wgpuBindGroupLayoutRelease(layout);
    wgpuBufferRelease(storage);
    wgpuShaderModuleRelease(module);
    wgpuQueueRelease(queue);
}

static void verify(void) {
    const float *out = wgpuBufferGetConstMappedRange(readback, 0, COUNT * sizeof(float));
    int bad = 0;
    double sum = 0;
    for (int i = 0; i < COUNT; i++) {
        if (out[i] != (float)i * 2.0f + 1.0f) bad++;
        sum += out[i];
    }
    wgpuBufferUnmap(readback);
    if (bad) {
        fprintf(stderr, "gpu-compute: %d of %d values wrong\n", bad, COUNT);
        stage = -1;
        return;
    }
    printf("WebGPU compute: %d values mapped to 2x+1, sum %.0f, all verified\n", COUNT, sum);
}

static void frame(void) {
    switch (stage) {
    case 1: {
        stage = 0;
        WGPURequestDeviceCallbackInfo ci = {0};
        ci.mode = WGPUCallbackMode_AllowProcessEvents;
        ci.callback = on_device;
        wgpuAdapterRequestDevice(adapter, NULL, ci);
        break;
    }
    case 2:
        stage = 3;
        dispatch();
        break;
    case 4:
        verify();
        if (stage == 4) {
            wgpuSetMainLoopCallback(NULL);
            wgpuBufferRelease(readback);
            wgpuDeviceRelease(device);
            wgpuAdapterRelease(adapter);
        }
        break;
    default:
        break;
    }
    if (stage == -1) {
        wgpuSetMainLoopCallback(NULL);
        exit(1);
    }
}

int main(void) {
    WGPUInstance instance = wgpuCreateInstance(NULL);
    WGPURequestAdapterCallbackInfo ci = {0};
    ci.mode = WGPUCallbackMode_AllowProcessEvents;
    ci.callback = on_adapter;
    wgpuInstanceRequestAdapter(instance, NULL, ci);
    wgpuSetMainLoopCallback(frame);
    return 0;
}
