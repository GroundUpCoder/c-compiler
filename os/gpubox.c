/* gpubox.c — the seeded GPU demo (todos/0016): a real SDL window rendered
 * with direct webgpu.h calls — the first end-to-end consumer of the WM's
 * `gpu` transport. Run it from the shell:  gpubox &
 *
 * A lambert-shaded cube, each face a distinct color, rotating one fixed step
 * per frame (frame-indexed, not wall-clock — pose N is deterministic):
 *   gpubox          animated demo
 *   gpubox -f N     frozen at pose N (what the tier-1 Dawn suite screenshots:
 *                   pose 0 shows the red +Z face head-on; tolerance-diff safe)
 *
 * Environment is negotiated entirely below webgpu.h (todos/WM.md invariant 1):
 * browser = per-process WebGPU device + ImageBitmap handoff; headless + the
 * optional `webgpu` (Dawn) package = render to a plain texture + readback into
 * the shm SAB; stock Node = clean adapter-unavailable, exit 2.
 *
 * Quit: close box / 'q'. Quits via SDL_Quit() (stops the frame loop; the
 * runtime drains pending Dawn readbacks before the EXIT handshake) — Dawn-tier
 * apps must NOT call exit() from a frame callback (WM.md spike S3 caveat).
 */
#include <sdl3webgpu.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define W 256
#define H 256

static SDL_Window *win;
static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline;
static WGPUBuffer vbuf, ibuf, ubuf;
static WGPUBindGroup bindGroup;
static WGPUTextureView depthView;
static WGPUTextureFormat format;
static int ready = 0;
static int failed = 0;
static long frame_no = 0;
static int fixed_pose = -1;      /* -f N: freeze the rotation at pose N */

/* MUST MATCH the light in the shader below AND the expected-color math in
 * tests/kernel/test_gpubox_dawn_e2e.js: l = normalize(0.3, 0.4, 0.9),
 * k = 0.25 + 0.75*max(dot(n,l),0). Pose 0 front face n=(0,0,1): k ~= 0.905. */
static const char *shader =
"struct U { mvp: mat4x4f, model: mat4x4f };\n"
"@group(0) @binding(0) var<uniform> u: U;\n"
"struct VO { @builtin(position) pos: vec4f, @location(0) nrm: vec3f, @location(1) col: vec3f };\n"
"@vertex fn vs(@location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) col: vec3f) -> VO {\n"
"  var o: VO;\n"
"  o.pos = u.mvp * vec4f(pos, 1.0);\n"
"  o.nrm = (u.model * vec4f(nrm, 0.0)).xyz;\n"
"  o.col = col;\n"
"  return o;\n"
"}\n"
"@fragment fn fs(v: VO) -> @location(0) vec4f {\n"
"  let l = normalize(vec3f(0.3, 0.4, 0.9));\n"
"  let k = 0.25 + 0.75 * max(dot(normalize(v.nrm), l), 0.0);\n"
"  return vec4f(v.col * k, 1.0);\n"
"}\n";

/* ---- column-major mat4 helpers (m[col*4 + row]) ---- */

static void mat_mul(float *out, const float *a, const float *b) {
    float t[16];
    for (int c = 0; c < 4; c++)
        for (int r = 0; r < 4; r++) {
            float s = 0.0f;
            for (int k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            t[c * 4 + r] = s;
        }
    memcpy(out, t, sizeof(t));
}

static void mat_perspective(float *m, float fovy, float aspect, float znear, float zfar) {
    memset(m, 0, 16 * sizeof(float));
    float f = 1.0f / tanf(fovy * 0.5f);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = zfar / (znear - zfar);          /* WebGPU clip z in [0,1] */
    m[11] = -1.0f;
    m[14] = znear * zfar / (znear - zfar);
}

static void mat_rot_x(float *m, float a) {
    memset(m, 0, 16 * sizeof(float));
    float c = cosf(a), s = sinf(a);
    m[0] = 1.0f; m[5] = c; m[6] = s; m[9] = -s; m[10] = c; m[15] = 1.0f;
}

static void mat_rot_y(float *m, float a) {
    memset(m, 0, 16 * sizeof(float));
    float c = cosf(a), s = sinf(a);
    m[0] = c; m[2] = -s; m[5] = 1.0f; m[8] = s; m[10] = c; m[15] = 1.0f;
}

/* ---- cube: 6 faces x 4 verts x [pos3 nrm3 col3], CCW from outside ---- */

static float verts[6 * 4 * 9];
static unsigned short indices[36];

static void build_cube(void) {
    /* per face: normal, tangent u, bitangent v (u x v == n), color */
    static const float faces[6][12] = {
        /*  n            u            v            color        */
        {  0,  0,  1,   1, 0, 0,    0, 1, 0,    0.90f, 0.12f, 0.12f },  /* +Z red   */
        {  0,  0, -1,   0, 1, 0,    1, 0, 0,    0.12f, 0.85f, 0.35f },  /* -Z green */
        {  1,  0,  0,   0, 1, 0,    0, 0, 1,    0.95f, 0.55f, 0.10f },  /* +X orange*/
        { -1,  0,  0,   0, 0, 1,    0, 1, 0,    0.15f, 0.45f, 0.95f },  /* -X blue  */
        {  0,  1,  0,   0, 0, 1,    1, 0, 0,    0.95f, 0.90f, 0.20f },  /* +Y yellow*/
        {  0, -1,  0,   1, 0, 0,    0, 0, 1,    0.60f, 0.20f, 0.80f },  /* -Y purple*/
    };
    /* corner signs for (u, v): (-,-) (+,-) (+,+) (-,+) — CCW from outside */
    static const float su[4] = { -1, 1, 1, -1 };
    static const float sv[4] = { -1, -1, 1, 1 };
    for (int f = 0; f < 6; f++) {
        const float *n = &faces[f][0], *u = &faces[f][3], *v = &faces[f][6], *col = &faces[f][9];
        for (int k = 0; k < 4; k++) {
            float *p = &verts[(f * 4 + k) * 9];
            for (int i = 0; i < 3; i++) p[i] = n[i] + su[k] * u[i] + sv[k] * v[i];
            for (int i = 0; i < 3; i++) p[3 + i] = n[i];
            for (int i = 0; i < 3; i++) p[6 + i] = col[i];
        }
        int b = f * 4, j = f * 6;
        indices[j] = (unsigned short)b;         indices[j + 1] = (unsigned short)(b + 1);
        indices[j + 2] = (unsigned short)(b + 2);
        indices[j + 3] = (unsigned short)b;     indices[j + 4] = (unsigned short)(b + 2);
        indices[j + 5] = (unsigned short)(b + 3);
    }
}

static void update_uniforms(long pose) {
    float angle = 0.02f * (float)pose;
    float rx[16], ry[16], model[16], proj[16], mvp[16];
    mat_rot_y(ry, angle);
    mat_rot_x(rx, angle * 0.7f);
    mat_mul(model, ry, rx);
    /* view: camera at z=+3.6 looking at the origin == translate z by -3.6 */
    float view_model[16];
    memcpy(view_model, model, sizeof(model));
    view_model[14] -= 3.6f;
    mat_perspective(proj, 55.0f * 3.14159265f / 180.0f, (float)W / (float)H, 0.1f, 10.0f);
    float u[32];
    mat_mul(mvp, proj, view_model);
    memcpy(&u[0], mvp, sizeof(mvp));
    memcpy(&u[16], model, sizeof(model));
    wgpuQueueWriteBuffer(queue, ubuf, 0, u, sizeof(u));
}

static void build(void) {
    WGPUShaderSourceWGSL wgsl;
    wgsl.chain.next = NULL; wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shader; wgsl.code.length = WGPU_STRLEN;
    WGPUShaderModuleDescriptor sd;
    sd.nextInChain = (const WGPUChainedStruct *)&wgsl; sd.label.data = NULL; sd.label.length = 0;
    WGPUShaderModule sm = wgpuDeviceCreateShaderModule(device, &sd);

    build_cube();
    WGPUBufferDescriptor bd;
    memset(&bd, 0, sizeof(bd));
    bd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    bd.size = sizeof(verts);
    vbuf = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, vbuf, 0, verts, sizeof(verts));
    bd.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
    bd.size = sizeof(indices);
    ibuf = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, ibuf, 0, indices, sizeof(indices));
    bd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    bd.size = 32 * sizeof(float);
    ubuf = wgpuDeviceCreateBuffer(device, &bd);

    WGPUBindGroupLayoutEntry ble;
    memset(&ble, 0, sizeof(ble));
    ble.binding = 0;
    ble.visibility = WGPUShaderStage_Vertex;
    ble.buffer.type = WGPUBufferBindingType_Uniform;
    WGPUBindGroupLayoutDescriptor bld;
    memset(&bld, 0, sizeof(bld));
    bld.entryCount = 1; bld.entries = &ble;
    WGPUBindGroupLayout bgl = wgpuDeviceCreateBindGroupLayout(device, &bld);

    WGPUBindGroupEntry be;
    memset(&be, 0, sizeof(be));
    be.binding = 0; be.buffer = ubuf; be.offset = 0; be.size = 32 * sizeof(float);
    WGPUBindGroupDescriptor bgd;
    memset(&bgd, 0, sizeof(bgd));
    bgd.layout = bgl; bgd.entryCount = 1; bgd.entries = &be;
    bindGroup = wgpuDeviceCreateBindGroup(device, &bgd);

    WGPUPipelineLayoutDescriptor pld;
    memset(&pld, 0, sizeof(pld));
    pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &bgl;
    WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

    WGPUTextureDescriptor dtd;
    memset(&dtd, 0, sizeof(dtd));
    dtd.usage = WGPUTextureUsage_RenderAttachment;
    dtd.dimension = WGPUTextureDimension_2D;
    dtd.size.width = W; dtd.size.height = H; dtd.size.depthOrArrayLayers = 1;
    dtd.format = WGPUTextureFormat_Depth24Plus;
    dtd.mipLevelCount = 1; dtd.sampleCount = 1;
    depthView = wgpuTextureCreateView(wgpuDeviceCreateTexture(device, &dtd), NULL);

    WGPUVertexAttribute attrs[3];
    attrs[0].format = WGPUVertexFormat_Float32x3; attrs[0].offset = 0;  attrs[0].shaderLocation = 0;
    attrs[1].format = WGPUVertexFormat_Float32x3; attrs[1].offset = 12; attrs[1].shaderLocation = 1;
    attrs[2].format = WGPUVertexFormat_Float32x3; attrs[2].offset = 24; attrs[2].shaderLocation = 2;
    WGPUVertexBufferLayout vbl;
    vbl.arrayStride = 36;
    vbl.stepMode = WGPUVertexStepMode_Vertex;
    vbl.attributeCount = 3;
    vbl.attributes = attrs;

    WGPUColorTargetState target;
    target.nextInChain = NULL; target.format = format; target.blend = NULL;
    target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fs;
    fs.nextInChain = NULL; fs.module = sm;
    fs.entryPoint.data = "fs"; fs.entryPoint.length = WGPU_STRLEN;
    fs.constantCount = 0; fs.constants = NULL; fs.targetCount = 1; fs.targets = &target;

    WGPUDepthStencilState ds;
    memset(&ds, 0, sizeof(ds));
    ds.format = WGPUTextureFormat_Depth24Plus;
    ds.depthWriteEnabled = 1;
    ds.depthCompare = WGPUCompareFunction_Less;

    WGPURenderPipelineDescriptor pd;
    memset(&pd, 0, sizeof(pd));
    pd.layout = pl;
    pd.vertex.module = sm;
    pd.vertex.entryPoint.data = "vs"; pd.vertex.entryPoint.length = WGPU_STRLEN;
    pd.vertex.bufferCount = 1; pd.vertex.buffers = &vbl;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
    pd.primitive.frontFace = WGPUFrontFace_CCW;
    pd.primitive.cullMode = WGPUCullMode_Back;
    pd.depthStencil = &ds;
    pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
    pd.fragment = &fs;
    pipeline = wgpuDeviceCreateRenderPipeline(device, &pd);
    wgpuShaderModuleRelease(sm);
}

static void frame(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_QUIT ||
            (e.type == SDL_EVENT_KEY_DOWN && e.key.key == 'q')) {
            SDL_Quit();          /* stop the frame loop; runtime drains + exits */
            return;
        }
    }
    /* GPU init failed: no Dawn work is in flight, so a direct exit is safe
     * here (the SDL_Quit-then-drain discipline only matters once rendering
     * has started). Nonzero so scripts can tell "no GPU" from a clean quit. */
    if (failed) { SDL_Quit(); exit(2); }
    if (!ready) return;

    update_uniforms(fixed_pose >= 0 ? fixed_pose : frame_no);
    frame_no++;

    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (!st.texture) return;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);

    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    /* MUST MATCH the corner assertion in test_gpubox_dawn_e2e.js: (20,20,64) */
    att.clearValue.r = 0.08; att.clearValue.g = 0.08; att.clearValue.b = 0.25; att.clearValue.a = 1.0;

    WGPURenderPassDepthStencilAttachment depthAtt;
    memset(&depthAtt, 0, sizeof(depthAtt));
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
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup, 0, NULL);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(pass, ibuf, WGPUIndexFormat_Uint16, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(pass, 36, 1, 0, 0, 0);
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
                      WGPUStringView msg, void *u1, void *u2) {
    (void)msg; (void)u1; (void)u2;
    if (status != WGPURequestDeviceStatus_Success) {
        fprintf(stderr, "gpubox: requestDevice failed\n");
        failed = 1;              /* the next frame tick quits cleanly */
        return;
    }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surface, adapter);
    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = W; cfg.height = H;
    cfg.viewFormatCount = 0; cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);
    build();
    ready = 1;
    printf("gpubox: ready %dx%d\n", W, H);
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad,
                       WGPUStringView msg, void *u1, void *u2) {
    (void)msg; (void)u1; (void)u2;
    if (status != WGPURequestAdapterStatus_Success) {
        fprintf(stderr, "gpubox: WebGPU unavailable (no adapter)\n");
        failed = 1;
        return;
    }
    adapter = ad;
    WGPURequestDeviceCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuAdapterRequestDevice(adapter, NULL, ci);
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-f") == 0 && i + 1 < argc) fixed_pose = atoi(argv[++i]);
        else {
            fprintf(stderr, "usage: gpubox [-f pose]\n");
            return 1;
        }
    }
    SDL_Init(SDL_INIT_VIDEO);
    win = SDL_CreateWindow("gpubox", W, H, 0);
    if (!win) { fprintf(stderr, "gpubox: no window\n"); return 3; }
    instance = wgpuCreateInstance(NULL);
    surface = SDL_GetWGPUSurface(instance, win);
    if (!surface) { fprintf(stderr, "gpubox: no surface\n"); return 3; }

    WGPURequestAdapterOptions opts;
    opts.nextInChain = NULL; opts.compatibleSurface = surface;
    opts.powerPreference = WGPUPowerPreference_Undefined; opts.forceFallbackAdapter = 0;
    WGPURequestAdapterCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_adapter; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuInstanceRequestAdapter(instance, &opts, ci);
    wgpuSetMainLoopCallback(frame);
    return 0;
}
