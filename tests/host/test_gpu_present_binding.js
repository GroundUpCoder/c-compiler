#!/usr/bin/env node
// Per-window GPU present binding (menu build item 0 / design amendment A4):
// the browser-flavor GPU present tail must be PER-WINDOW — one OffscreenCanvas
// per GPU-presenting sid (canvasBySid), bound at SDL_GetWGPUSurface time via
// the __wgpu_instance_create_surface_for_window import — symmetric with the
// shm path's fbByHandle/handleBySid. Pre-A4 the tail was a scalar: ONE
// worker-local canvas + a currentSid clobbered at EVERY window create, so a
// GPU app's second window silently repointed the first surface's ImageBitmap
// presents (newest-wins) and every configure resized the one shared canvas.
//
// Runs in Node with a minimal fake browser surface (OffscreenCanvas +
// navigator.gpu + GPUTextureUsage): drives createSurfaceSDL's browser flavor
// and createBrowserWebGPU exactly as runModule wires them, and asserts each
// window's surface presents its OWN canvas to its OWN sid. The handle-less
// legacy import (pre-A4 binaries) must keep its last-created-window tail.
//
// Run: node tests/host/test_gpu_present_binding.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- fake browser surface: just enough for the GPU present tail ---- */
let canvasSeq = 0;
class FakeOffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.canvasId = ++canvasSeq; }
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    if (!this._ctx) {
      this._ctx = {
        canvas: this,
        configure: function () {},
        getCurrentTexture: function () { return { createView: function () { return {}; } }; },
      };
    }
    return this._ctx;
  }
  transferToImageBitmap() {
    return { width: this.width, height: this.height, canvasId: this.canvasId };
  }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.GPUTextureUsage = { COPY_SRC: 0x01, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x04 };
const fakeDevice = { addEventListener: function () {} };
const fakeGpu = {
  getPreferredCanvasFormat: function () { return 'bgra8unorm'; },
  requestAdapter: function () {
    return Promise.resolve({ requestDevice: function () { return Promise.resolve(fakeDevice); } });
  },
};
Object.defineProperty(globalThis, 'navigator', { value: { gpu: fakeGpu }, configurable: true });

const host = require(path.join(ROOT, 'host.js'));
const { WM_SAB_LAYOUT } = require(path.join(ROOT, 'kernel.js'));
const ENV = 'c';   // host.js ENV_KEY

/* ---- fake process ctx + kernel spawn hooks ---- */
const captured = { adapter: 0, device: 0 };
const ctx = {
  readString: function () { return ''; },
  getMemory: function () { return { buffer: new ArrayBuffer(64) }; },
  getExports: function () {
    return {
      __wgpu_call_adapter_cb: function (cb, status, handle) { captured.adapter = handle; },
      __wgpu_call_device_cb: function (cb, status, handle) { captured.device = handle; },
    };
  },
};
const frames = [];   // every hooks.surfaceFrame(sid, bmp) landing
let nextSid = 1;
// #484 (producer-side present clamp): presentTo ships at most one frame per
// vsync tick per sid, so this test advertises a FAKE tick counter and bumps
// it before every present it expects to ship synchronously — the clamp's
// contract ("a fresh tick ships immediately") keeps every binding assertion
// below exactly as strong as pre-clamp. Clamp semantics themselves are
// test_gpu_present_clamp.js's subject, not this file's.
let vsyncTick = 1;
const tickAdvance = function () { vsyncTick++; };
const hooks = {
  wmSabLayout: WM_SAB_LAYOUT,
  surfaceCreate: function (w, h, title, sab, ringSab, kFlags) { return { sid: nextSid++ }; },
  surfaceFrame: function (sid, bmp) {
    frames.push({ sid: sid, canvasId: bmp.canvasId, w: bmp.width, h: bmp.height });
  },
  surfaceDestroy: function () {},
  vsyncEnabled: function () { return true; },
  vsyncSeq: function () { return vsyncTick; },
};

(async function main() {
  const sdl = host.createSurfaceSDL({ ctx: ctx, hooks: hooks });
  const env = sdl[ENV];
  const wCfg = sdl.webgpuConfig;
  check('browser flavor exposes the A4 bindWindow seam',
    wCfg && typeof wCfg.bindWindow === 'function');
  const webgpu = host.createBrowserWebGPU({
    canvas: wCfg.canvas, ctx: ctx, notifyWindow: null,
    onPresent: wCfg.onPresent, bindWindow: wCfg.bindWindow,
  });
  const wenv = webgpu[ENV];
  check('the window-bound surface import exists',
    typeof wenv.__wgpu_instance_create_surface_for_window === 'function');

  // window 1 + its surface FIRST, then window 2 — the pre-A4 clobber moment
  // (currentSid = newest) happened at window 2's create.
  const h1 = env.__sdl_create_window(0, 0, 0, 64, 48, 0);
  const inst = wenv.__wgpu_create_instance();
  const s1 = wenv.__wgpu_instance_create_surface_for_window(inst, h1);
  check('surface for window 1 created', s1 !== 0);
  const h2 = env.__sdl_create_window(0, 0, 0, 32, 24, 0);
  const s2 = wenv.__wgpu_instance_create_surface_for_window(inst, h2);
  check('surface for window 2 created', s2 !== 0);

  // async adapter/device via the fake gpu
  wenv.__wgpu_instance_request_adapter(inst, 1, 0, 0);
  await new Promise(function (r) { setTimeout(r, 0); });
  wenv.__wgpu_adapter_request_device(captured.adapter, 1, 0, 0);
  await new Promise(function (r) { setTimeout(r, 0); });
  check('fake device acquired', captured.device !== 0);

  // configure sizes each surface's OWN canvas (usage 0x10, alpha 0=opaque,
  // presentMode 0=undefined→fifo, no view formats)
  wenv.__wgpu_surface_configure(s1, captured.device, 0, 0x10, 64, 48, 0, 0, 0, 0);
  wenv.__wgpu_surface_configure(s2, captured.device, 0, 0x10, 32, 24, 0, 0, 0, 0);

  frames.length = 0;
  tickAdvance();
  wenv.__wgpu_surface_present(s1);
  check('window 1 present lands on sid 1 even though window 2 was created after',
    frames.length === 1 && frames[0].sid === 1, JSON.stringify(frames));
  check('window 1 presents its OWN canvas at its own size (surface 2 configure did not resize it)',
    frames.length === 1 && frames[0].w === 64 && frames[0].h === 48, JSON.stringify(frames));
  wenv.__wgpu_surface_present(s2);
  check('window 2 present lands on sid 2',
    frames.length === 2 && frames[1].sid === 2, JSON.stringify(frames));
  check('the two windows present two DIFFERENT canvases (canvasBySid, not one shared)',
    frames.length === 2 && frames[0].canvasId !== frames[1].canvasId, JSON.stringify(frames));
  check('window 2 canvas is its own size', frames.length === 2 && frames[1].w === 32 && frames[1].h === 24);

  // interleaved presents keep their bindings (one tick per present: the
  // second s2 present is same-sid and must not be clamp-held)
  frames.length = 0;
  tickAdvance();
  wenv.__wgpu_surface_present(s2);
  tickAdvance();
  wenv.__wgpu_surface_present(s1);
  tickAdvance();
  wenv.__wgpu_surface_present(s2);
  check('interleaved presents never cross sids',
    frames.length === 3 && frames[0].sid === 2 && frames[1].sid === 1 && frames[2].sid === 2,
    JSON.stringify(frames));

  // destroy window 1: only ITS canvas/binding is torn down
  env.__sdl_destroy_window(h1);
  frames.length = 0;
  tickAdvance();
  wenv.__wgpu_surface_present(s1);
  check('present to a destroyed window drops (no frame, no throw)', frames.length === 0);
  wenv.__wgpu_surface_present(s2);
  check('window 2 still presents after window 1 destroy',
    frames.length === 1 && frames[0].sid === 2, JSON.stringify(frames));

  // legacy handle-less surface (pre-A4 binaries): the shared-canvas tail,
  // last-created-window semantics — byte-compatible with old baked binaries.
  const sLeg = wenv.__wgpu_instance_create_surface(inst);
  check('legacy handle-less surface still creates', sLeg !== 0);
  wenv.__wgpu_surface_configure(sLeg, captured.device, 0, 0x10, 32, 24, 0, 0, 0, 0);
  frames.length = 0;
  tickAdvance();
  wenv.__wgpu_surface_present(sLeg);
  check('legacy surface keeps the last-created-window tail',
    frames.length === 1 && frames[0].sid === 2, JSON.stringify(frames));

  console.log(failures ? '\ngpu present binding: ' + failures + ' FAILED' : '\ngpu present binding: PASS');
  process.exit(failures ? 1 : 0);
})().catch(function (e) {
  console.error('gpu present binding: crashed', e);
  process.exit(1);
});
