#!/usr/bin/env node
// Per-window GPU present binding, end-to-end under Dawn (menu build item 0 /
// design amendment A4): a REAL C webgpu.h program opens TWO SDL windows, binds
// a WGPUSurface to EACH via SDL_GetWGPUSurface, and clears window A solid RED
// and window B solid GREEN every frame. Each window must show ITS OWN color.
//
// Pre-A4 this failed by construction: SDL_GetWGPUSurface dropped the window
// handle ((void)window) and the headless present tail resolved its target as
// "newest window wins" — BOTH surfaces' readbacks landed in window B, window A
// never received a frame. The fix binds the surface to the named window at
// SDL_GetWGPUSurface time (the __wgpu_instance_create_surface_for_window
// import), symmetric with the shm per-window path.
//
// Both surfaces are deliberately fetched AFTER both windows exist (create,
// create, bind, bind) — the ordering a newest-unbound-window heuristic would
// mis-bind, so only the real handle-crossing fix passes.
//
// SKIPS cleanly (exit 0) when the webgpu package is absent — stock Node stays
// tier 0, exactly like test_gpubox_dawn_e2e.js.
//
// Run: node tests/kernel/test_gpu_multiwin_dawn_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));

try { require.resolve('webgpu'); }
catch (e) {
  console.log('gpu multiwin dawn e2e: SKIP (webgpu package not installed — tier 0; `pnpm add -D webgpu` for tier 1)');
  process.exit(0);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const APP_C = `
#include <SDL.h>
#include <webgpu.h>
#include <sdl3webgpu.h>
#include <stdio.h>
#include <stdlib.h>

static SDL_Window *winA, *winB;
static WGPUInstance instance;
static WGPUSurface surfA, surfB;
static WGPUAdapter adapter;
static WGPUDevice device;
static WGPUQueue queue;
static WGPUTextureFormat format;
static int ready = 0, failed = 0, frame_no = 0;

static void configure(WGPUSurface s, int w, int h) {
    WGPUSurfaceConfiguration cfg;
    cfg.nextInChain = NULL; cfg.device = device; cfg.format = format;
    cfg.usage = WGPUTextureUsage_RenderAttachment;
    cfg.width = (uint32_t)w; cfg.height = (uint32_t)h;
    cfg.viewFormatCount = 0; cfg.viewFormats = NULL;
    cfg.alphaMode = WGPUCompositeAlphaMode_Opaque;
    cfg.presentMode = WGPUPresentMode_Fifo;
    wgpuSurfaceConfigure(s, &cfg);
}

/* Clear-only render pass: the clear color IS the frame (no pipeline). */
static void clear_to(WGPUSurface s, double r, double g, double b) {
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(s, &st);
    if (!st.texture) return;
    WGPUTextureView view = wgpuTextureCreateView(st.texture, NULL);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    WGPURenderPassColorAttachment att;
    att.nextInChain = NULL; att.view = view; att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.resolveTarget = NULL; att.loadOp = WGPULoadOp_Clear; att.storeOp = WGPUStoreOp_Store;
    att.clearValue.r = r; att.clearValue.g = g; att.clearValue.b = b; att.clearValue.a = 1.0;
    WGPURenderPassDescriptor rp;
    rp.nextInChain = NULL; rp.label.data = NULL; rp.label.length = 0;
    rp.colorAttachmentCount = 1; rp.colorAttachments = &att;
    rp.depthStencilAttachment = NULL;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
    wgpuRenderPassEncoderEnd(pass);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuSurfacePresent(s);
    wgpuCommandBufferRelease(cmd);
    wgpuRenderPassEncoderRelease(pass);
    wgpuCommandEncoderRelease(enc);
    wgpuTextureViewRelease(view);
    wgpuTextureRelease(st.texture);
}

static void frame(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_QUIT ||
            (e.type == SDL_EVENT_KEY_DOWN && e.key.key == 'q')) {
            printf("DONE\\n");
            fflush(stdout);
            SDL_Quit();          /* stop the frame loop; runtime drains + exits */
            return;
        }
    }
    if (failed) { SDL_Quit(); exit(2); }
    if (!ready) return;
    /* Window A RED, window B GREEN — which window shows which color IS the
       per-window binding assertion the test reads back. */
    clear_to(surfA, 1.0, 0.0, 0.0);
    clear_to(surfB, 0.0, 1.0, 0.0);
    if (++frame_no == 1) { printf("RENDERED\\n"); fflush(stdout); }
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice dev,
                      WGPUStringView msg, void *u1, void *u2) {
    (void)msg; (void)u1; (void)u2;
    if (status != WGPURequestDeviceStatus_Success) {
        fprintf(stderr, "multiwin: requestDevice failed\\n");
        failed = 1;
        return;
    }
    device = dev;
    queue = wgpuDeviceGetQueue(device);
    format = wgpuSurfaceGetPreferredFormat(surfA, adapter);
    configure(surfA, 96, 64);
    configure(surfB, 96, 64);
    ready = 1;
    printf("READY\\n");
    fflush(stdout);
}

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter ad,
                       WGPUStringView msg, void *u1, void *u2) {
    (void)msg; (void)u1; (void)u2;
    if (status != WGPURequestAdapterStatus_Success) {
        fprintf(stderr, "multiwin: WebGPU unavailable (no adapter)\\n");
        failed = 1;
        return;
    }
    adapter = ad;
    WGPURequestDeviceCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_device; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuAdapterRequestDevice(adapter, NULL, ci);
}

int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    winA = SDL_CreateWindow("gwina", 96, 64, 0);
    winB = SDL_CreateWindow("gwinb", 96, 64, 0);
    if (!winA || !winB) { fprintf(stderr, "multiwin: no window\\n"); return 3; }
    instance = wgpuCreateInstance(NULL);
    /* Both windows exist BEFORE either bind: only a real handle-crossing
       binding (A4) can tell the two apart here. */
    surfA = SDL_GetWGPUSurface(instance, winA);
    surfB = SDL_GetWGPUSurface(instance, winB);
    if (!surfA || !surfB) { fprintf(stderr, "multiwin: no surface\\n"); return 3; }

    WGPURequestAdapterOptions opts;
    opts.nextInChain = NULL; opts.compatibleSurface = surfA;
    opts.powerPreference = WGPUPowerPreference_Undefined; opts.forceFallbackAdapter = 0;
    WGPURequestAdapterCallbackInfo ci;
    ci.nextInChain = NULL; ci.mode = WGPUCallbackMode_AllowSpontaneous;
    ci.callback = on_adapter; ci.userdata1 = NULL; ci.userdata2 = NULL;
    wgpuInstanceRequestAdapter(instance, &opts, ci);
    wgpuSetMainLoopCallback(frame);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-multiwin-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const waitPred = (fn, label, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout: ' + label));
    setTimeout(poll, 25);
  })();
});

// Full-size thumbnail == exact front-buffer pixels; sample the center.
function centerPx(sid) {
  const t = kernel.wmThumbnail(sid, 512, 512);
  if (!t) return null;
  const i = ((t.h >> 1) * t.w + (t.w >> 1)) * 4;
  return [t.rgba[i], t.rgba[i + 1], t.rgba[i + 2]];
}
const near = (got, want, tol) => !!got && got.every((v, i) => Math.abs(v - want[i]) <= tol);

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — gpu multiwin e2e did not finish in 120s\noutput so far:\n' + out);
  process.exit(1);
}, 120000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('READY');
  const wins = kernel.wmList();
  const a = wins.find((s) => s.title === 'gwina');
  const b = wins.find((s) => s.title === 'gwinb');
  check('both GPU windows exist', !!a && !!b, JSON.stringify(wins.map((w) => w.title)));

  // The assertion IS the sync: poll until each window's readback landed.
  await waitOut('RENDERED');
  await waitPred(() => near(centerPx(a.sid), [255, 0, 0], 8) && near(centerPx(b.sid), [0, 255, 0], 8),
    'window A red AND window B green (per-window present binding); A=' +
    JSON.stringify(centerPx(a.sid)) + ' B=' + JSON.stringify(centerPx(b.sid)));
  const pa = centerPx(a.sid), pb = centerPx(b.sid);
  check('window A shows ITS surface (solid red)', near(pa, [255, 0, 0], 8), JSON.stringify(pa));
  check('window B shows ITS surface (solid green)', near(pb, [0, 255, 0], 8), JSON.stringify(pb));
  check('the two windows show DIFFERENT content (no newest-wins clobber)',
    !near(pa, pb, 8), JSON.stringify([pa, pb]));

  // graceful quit: 'q' -> SDL_Quit -> Dawn drain -> EXIT (spike-S3 discipline);
  // a worker.terminate with pending Dawn readbacks would abort this process.
  kernel.wmInjectKey(a.sid, true, 4, 113, 0);   // 'q'
  await waitOut('DONE');
  await waitPred(() => !kernel.process(1), 'process exited cleanly');
  check('app quit cleanly through the Dawn drain', true);

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? '\ngpu multiwin dawn e2e: ' + failures + ' FAILED' : '\ngpu multiwin dawn e2e: PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('gpu multiwin dawn e2e: crashed', e);
  console.error('output:\n' + out);
  process.exit(1);
});
