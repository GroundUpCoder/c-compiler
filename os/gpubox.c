/* gpubox.c — the seeded GPU demo (todos/0016), since todos/0258 a minimal
 * WIN32 app with a real menu: the M2 acceptance app of the uniform-menu
 * architecture (menu arch §4.a) — a GPU app's File/Options menu riding the
 * SAME user32 engine, anchored-child surfaces and agent tree as notepad's.
 * Run it from the shell:  gpubox &
 *
 * A lambert-shaded cube, each face a distinct color, rotating one fixed step
 * per frame (frame-indexed, not wall-clock — pose N is deterministic):
 *   gpubox          animated demo
 *   gpubox -f N     frozen at pose N (what the tier-1 Dawn suite screenshots:
 *                   pose 0 shows the red +Z face head-on; tolerance-diff safe)
 *
 * The win32 shape (§4.a): RegisterClass with CS_OWNCLIENT ("app presents
 * its own client plane" — user32 synthesizes no WM_PAINT and never touches
 * the window surface; transport-neutral by decision A6), CreateWindowEx,
 * then the WebGPU path binds to the SAME window via GetWindowSDL ->
 * SDL_GetWGPUSurface. The frame callback pumps PeekMessage (the agent
 * socket and menu tracking ride it) and then renders exactly as before.
 * Menu: File > Open Scene... (grayed — no scene format exists; honest
 * disable, not a dead item) / Quit; Options > Spin (checked) / Wireframe.
 * WM_COMMAND toggles really act: Spin freezes the rotation next frame,
 * Wireframe swaps the pipeline to the cube's edge lines.
 *
 * No-GPU survival (decision A14): when adapter/device/surface acquisition
 * fails, gpubox does NOT exit — the window, menu and message pump stay
 * alive over a dead (black) client. That is honest degradation AND what
 * lets the headless no-Dawn acceptance e2e drive the menu
 * (tests/kernel/test_gpubox_menu_e2e.js).
 *
 * Environment is negotiated entirely below webgpu.h (todos/WM.md invariant 1):
 * browser = per-process WebGPU device + ImageBitmap handoff; headless + the
 * optional `webgpu` (Dawn) package = render to a plain texture + readback into
 * the shm SAB; stock Node = adapter-unavailable -> the A14 survival mode.
 *
 * Quit: close box / menu Quit / 'q' -> WM_CLOSE -> PostQuitMessage -> the
 * pump calls SDL_Quit() (stops the frame loop; the runtime drains pending
 * Dawn readbacks before the EXIT handshake). Dawn-tier apps must NOT call
 * exit() from a frame callback, and must NOT tear the window down while a
 * readback may be in flight — quit goes through SDL_Quit alone (WM.md
 * spike S3 caveat).
 *
 * Resize (todos/0019): kernel RESIZED -> user32 WM_SIZE -> reconfigure the
 * surface at the new FULL window size (the swapchain covers the whole
 * surface; the menu bar strip child overlays its top MENU_BAR_H pixels)
 * and rebuild the depth buffer — the canonical webgpu.h resize dance.
 */
#include <windows.h>
#include <sdl3webgpu.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define W 256
#define H 256

#define ID_OPEN 101
#define ID_QUIT 102
#define ID_SPIN 201
#define ID_WIRE 202

static HWND hwnd;
static SDL_Window *win;          /* the user32 window's SDL window (GetWindowSDL) */
static WGPUInstance instance;
static WGPUSurface surface;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPURenderPipeline pipeline, pipelineWire;
static WGPUBuffer vbuf, ibuf, ibufWire, ubuf;
static WGPUBindGroup bindGroup;
static WGPUTexture depthTex;
static WGPUTextureView depthView;
static WGPUTextureFormat format;
static int gw = W, gh = H;       /* current FULL window size (WM_SIZE updates it) */
static int ready = 0;
static int failed = 0;           /* A14: no-GPU survival flag, never an exit */
static int spin = 1;             /* Options > Spin */
static int wire = 0;             /* Options > Wireframe */
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
static unsigned short edges[48];         /* wireframe: 4 outline lines per face */

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
        int e = f * 8;                           /* face outline as a line list */
        for (int k = 0; k < 4; k++) {
            edges[e + k * 2] = (unsigned short)(b + k);
            edges[e + k * 2 + 1] = (unsigned short)(b + (k + 1) % 4);
        }
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
    mat_perspective(proj, 55.0f * 3.14159265f / 180.0f, (float)gw / (float)gh, 0.1f, 10.0f);
    float u[32];
    mat_mul(mvp, proj, view_model);
    memcpy(&u[0], mvp, sizeof(mvp));
    memcpy(&u[16], model, sizeof(model));
    wgpuQueueWriteBuffer(queue, ubuf, 0, u, sizeof(u));
}

/* (Re)build the depth buffer at the current size — at init and per resize. */
static void make_depth(void) {
    if (depthView) wgpuTextureViewRelease(depthView);
    if (depthTex) wgpuTextureRelease(depthTex);
    WGPUTextureDescriptor dtd;
    memset(&dtd, 0, sizeof(dtd));
    dtd.usage = WGPUTextureUsage_RenderAttachment;
    dtd.dimension = WGPUTextureDimension_2D;
    dtd.size.width = (uint32_t)gw; dtd.size.height = (uint32_t)gh;
    dtd.size.depthOrArrayLayers = 1;
    dtd.format = WGPUTextureFormat_Depth24Plus;
    dtd.mipLevelCount = 1; dtd.sampleCount = 1;
    depthTex = wgpuDeviceCreateTexture(device, &dtd);
    depthView = wgpuTextureCreateView(depthTex, NULL);
}

/* (Re)configure the swapchain surface at the current size — at device init
 * and per resize (the canonical webgpu.h resize dance). */
static void configure_surface(void) {
    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = (uint32_t)gw; cfg.height = (uint32_t)gh;
    cfg.viewFormatCount = 0; cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(surface, &cfg);
}

/* One pipeline builder, two topologies: the solid cube and its edge-line
 * wireframe share the shader, layouts and depth state. */
static WGPURenderPipeline make_pipeline(WGPUShaderModule sm, WGPUPipelineLayout pl,
                                        int lines) {
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
    pd.primitive.topology = lines ? WGPUPrimitiveTopology_LineList
                                  : WGPUPrimitiveTopology_TriangleList;
    pd.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
    pd.primitive.frontFace = WGPUFrontFace_CCW;
    pd.primitive.cullMode = lines ? WGPUCullMode_None : WGPUCullMode_Back;
    pd.depthStencil = &ds;
    pd.multisample.count = 1; pd.multisample.mask = 0xFFFFFFFF;
    pd.fragment = &fs;
    return wgpuDeviceCreateRenderPipeline(device, &pd);
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
    bd.size = sizeof(edges);
    ibufWire = wgpuDeviceCreateBuffer(device, &bd);
    wgpuQueueWriteBuffer(queue, ibufWire, 0, edges, sizeof(edges));
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

    make_depth();

    pipeline = make_pipeline(sm, pl, 0);
    pipelineWire = make_pipeline(sm, pl, 1);
    wgpuShaderModuleRelease(sm);
}

static void frame(void) {
    /* The win32 pump (§4.a.3): posted messages, menu tracking, WM_TIMERs
     * and the agent socket all ride PeekMessage. WM_QUIT is the one exit
     * path — SDL_Quit stops the frame loop and the runtime drains pending
     * Dawn work before the EXIT handshake (never exit() from here). */
    MSG m;
    while (PeekMessage(&m, NULL, 0, 0, PM_REMOVE)) {
        if (m.message == WM_QUIT) {
            SDL_Quit();
            return;
        }
        TranslateMessage(&m);
        DispatchMessage(&m);
    }
    /* A14 no-GPU survival: acquisition failed -> ready never rises; the
     * window, menu and pump above stay fully alive over the dead client. */
    if (!ready) return;

    update_uniforms(fixed_pose >= 0 ? fixed_pose : frame_no);
    if (spin && fixed_pose < 0) frame_no++;      /* Spin off = pose frozen */

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
    wgpuRenderPassEncoderSetPipeline(pass, wire ? pipelineWire : pipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup, 0, NULL);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(pass, wire ? ibufWire : ibuf,
                                        WGPUIndexFormat_Uint16, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(pass, wire ? 48 : 36, 1, 0, 0, 0);
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
        failed = 1;              /* A14: report it, keep window + menu alive */
        return;
    }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surface, adapter);
    configure_surface();
    build();
    ready = 1;
    printf("gpubox: ready %dx%d\n", gw, gh);
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad,
                       WGPUStringView msg, void *u1, void *u2) {
    (void)msg; (void)u1; (void)u2;
    if (status != WGPURequestAdapterStatus_Success) {
        fprintf(stderr, "gpubox: WebGPU unavailable (no adapter)\n");
        failed = 1;              /* A14: report it, keep window + menu alive */
        return;
    }
    adapter = ad;
    WGPURequestDeviceCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuAdapterRequestDevice(adapter, NULL, ci);
}

/* Menu (§4.a.2, runtime-built like fileman's): File / Options. "Open
 * Scene..." is GRAYED — no scene format exists in this demo, and an
 * honestly-disabled item beats one that silently no-ops. */
static void build_menu(HWND h) {
    HMENU bar = CreateMenu();
    HMENU file = CreatePopupMenu();
    HMENU opts = CreatePopupMenu();
    AppendMenuA(file, MF_STRING | MF_GRAYED, ID_OPEN, "&Open Scene...");
    AppendMenuA(file, MF_SEPARATOR, 0, NULL);
    AppendMenuA(file, MF_STRING, ID_QUIT, "&Quit");
    AppendMenuA(opts, MF_STRING | MF_CHECKED, ID_SPIN, "&Spin");
    AppendMenuA(opts, MF_STRING, ID_WIRE, "&Wireframe");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)file, "&File");
    AppendMenuA(bar, MF_POPUP, (UINT_PTR)opts, "&Options");
    SetMenu(h, bar);
}

static LRESULT CALLBACK wndproc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CREATE:
        build_menu(h);
        return 0;
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_SPIN:
            spin = !spin;
            CheckMenuItem(GetMenu(h), ID_SPIN,
                          MF_BYCOMMAND | (spin ? MF_CHECKED : MF_UNCHECKED));
            printf("gpubox: spin %s\n", spin ? "on" : "off");
            fflush(stdout);
            return 0;
        case ID_WIRE:
            wire = !wire;
            CheckMenuItem(GetMenu(h), ID_WIRE,
                          MF_BYCOMMAND | (wire ? MF_CHECKED : MF_UNCHECKED));
            printf("gpubox: wireframe %s\n", wire ? "on" : "off");
            fflush(stdout);
            return 0;
        case ID_QUIT:
            PostMessage(h, WM_CLOSE, 0, 0);
            return 0;
        }
        return 0;
    case WM_CHAR:
        if (wp == 'q') PostMessage(h, WM_CLOSE, 0, 0);
        return 0;
    case WM_SIZE: {
        /* Track the FULL window size (WM_SIZE's lParam is the client, i.e.
         * minus the bar strip); the swapchain covers the whole surface. */
        SDL_Window *sw = GetWindowSDL(h);
        if (sw) SDL_GetWindowSize(sw, &gw, &gh);
        if (ready) {
            configure_surface();     /* swapchain at the new size */
            make_depth();            /* depth must match the color target */
        }
        return 0;
    }
    case WM_CLOSE:
        /* NOT DestroyWindow: the window must outlive any in-flight Dawn
         * readback — SDL_Quit (from the pump, on WM_QUIT) is the one
         * teardown path and drains first (the S3 caveat). */
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(h, msg, wp, lp);
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-f") == 0 && i + 1 < argc) fixed_pose = atoi(argv[++i]);
        else {
            fprintf(stderr, "usage: gpubox [-f pose]\n");
            return 1;
        }
    }
    WNDCLASS wc;
    memset(&wc, 0, sizeof(wc));
    wc.style = CS_OWNCLIENT;         /* the app presents the client plane */
    wc.lpfnWndProc = wndproc;
    wc.lpszClassName = "gpubox";
    RegisterClass(&wc);
    hwnd = CreateWindowEx(0, "gpubox", "gpubox", WS_THICKFRAME,
                          0, 0, W, H, NULL, NULL, NULL, NULL);
    if (!hwnd) { fprintf(stderr, "gpubox: no window\n"); return 3; }
    win = GetWindowSDL(hwnd);        /* §3.7a: bind WebGPU to user32's window */

    instance = wgpuCreateInstance(NULL);
    surface = win ? SDL_GetWGPUSurface(instance, win) : NULL;
    if (!surface) {
        /* A14: no surface -> no adapter request, but NO exit — the window,
         * menu and pump run over a dead client. */
        fprintf(stderr, "gpubox: WebGPU unavailable (no surface)\n");
        failed = 1;
    } else {
        WGPURequestAdapterOptions opts;
        opts.nextInChain = NULL; opts.compatibleSurface = surface;
        opts.powerPreference = WGPUPowerPreference_Undefined; opts.forceFallbackAdapter = 0;
        WGPURequestAdapterCallbackInfo ci;
        ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
        ci.callback = on_adapter; ci.userdata1 = NULL; ci.userdata2 = NULL;
        wgpuInstanceRequestAdapter(instance, &opts, ci);
    }
    wgpuSetMainLoopCallback(frame);
    return 0;
}
