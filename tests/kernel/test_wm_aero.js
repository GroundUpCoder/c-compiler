#!/usr/bin/env node
// Aero effects, kernel side (todos/0063) without wasm: fake workers over a
// brokered kernel (test_wm.js plumbing). Covers: the has-alpha surface flag
// (create bit3 + SET_FLAGS), the DETERMINISTIC src-over blend in the
// headless screen composite (exact integer goldens, unscaled + scaled +
// alpha-0/255 extremes), wmThumbnail's box filter (exact averages, aspect
// fit, never-upscale, bad sid), the glass toggle's headless invariance
// (bit-identical shots with glass on — the 0063 constraint), and the
// transient minimize/restore animation records in wmScene (pruned by age,
// dropped on destroy, invisible to the composite).
//
// Run: node tests/kernel/test_wm_aero.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const { BLOCK_FS } = require(path.resolve(__dirname, '../../host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake worker plumbing (test_wm.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, terminated: false,
    postMessage() {},
    onMessage(fn) { h.msg = fn; },
    onExit(fn) { h.exitCb = fn; },
    terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}
const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/app', new Uint8Array([2])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {},
  log: () => {},
  screen: { w: 320, h: 240 },
});

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
function submit(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  return {
    async finish() {
      while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
      const resp = K.readPayload(i32, u8);
      Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
      return resp;
    },
  };
}
const rpc = (pid, op, req) => submit(pid, op, req).finish();

function makeFb(w, h) {
  const sab = new SharedArrayBuffer(K.SH_HDR_BYTES + 2 * w * h * 4);
  const i32 = new Int32Array(sab);
  i32[K.SH_MAGIC] = K.SH_MAGIC_VALUE;
  i32[K.SH_W] = w; i32[K.SH_H] = h; i32[K.SH_FORMAT] = 0;
  return { sab, i32, u8: new Uint8Array(sab), w, h };
}
function makeRing(cap) {
  const sab = new SharedArrayBuffer(K.IR_HDR_BYTES + cap * K.IR_RECORD_WORDS * 4);
  new Int32Array(sab)[K.IR_CAP] = cap;
  return { sab, i32: new Int32Array(sab), f32: new Float32Array(sab), cap };
}
// Present one solid RGBA fill (mailbox flip).
function present(fb, rgba) {
  const front = Atomics.load(fb.i32, K.SH_FLIP) & 1;
  const back = 1 - front;
  const base = K.SH_HDR_BYTES + back * fb.w * fb.h * 4;
  for (let i = 0; i < fb.w * fb.h; i++) fb.u8.set(rgba, base + i * 4);
  Atomics.store(fb.i32, K.SH_FLIP, back);
  Atomics.add(fb.i32, K.SH_SEQ, 1);
}
// Paint one pixel of the BACK buffer then flip — for patterned fills.
function presentPattern(fb, painter) {
  const front = Atomics.load(fb.i32, K.SH_FLIP) & 1;
  const back = 1 - front;
  const base = K.SH_HDR_BYTES + back * fb.w * fb.h * 4;
  for (let y = 0; y < fb.h; y++)
    for (let x = 0; x < fb.w; x++)
      fb.u8.set(painter(x, y), base + (y * fb.w + x) * 4);
  Atomics.store(fb.i32, K.SH_FLIP, back);
  Atomics.add(fb.i32, K.SH_SEQ, 1);
}
const px = (shot, x, y) =>
  Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));
// The kernel's blend rule: floor((src*a + dst*(255-a) + 127) / 255).
const over = (s, d, a) => (s * a + d * (255 - a) + 127) / 255 | 0;

(async () => {
  await kernel.boot({ path: '/bin/init' });
  const r1 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const appPid = r1.pid;

  // ---- two borderless surfaces: opaque red under half-alpha blue ----
  const fbA = makeFb(64, 48);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbA.sab, ring: makeRing(64).sab });
  const cA = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 64, h: 48, title: 'under', flags: 1 });
  check('opaque surface created', cA.sid > 0, JSON.stringify(cA));
  kernel.wmMove(cA.sid, 10, 30);
  present(fbA, [255, 0, 0, 255]);

  const fbB = makeFb(64, 48);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbB.sab, ring: null });
  const cB = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 64, h: 48, title: 'over', flags: 1 | 8 });
  check('has-alpha surface created (flags bit3)', cB.sid > 0, JSON.stringify(cB));
  kernel.wmMove(cB.sid, 20, 54);           // overlaps A's bottom half
  // Pattern: left half 50%-alpha blue, right half split alpha-0 / alpha-255.
  presentPattern(fbB, (x, y) =>
    x < 32 ? [0, 0, 255, 128] : (y < 24 ? [9, 9, 9, 0] : [0, 255, 0, 255]));

  const alphaList = kernel.wmList().find((w) => w.sid === cB.sid);
  check('wmList exposes hasAlpha', alphaList && alphaList.hasAlpha === true &&
    kernel.wmList().find((w) => w.sid === cA.sid).hasAlpha === false);

  let shot = kernel.wmScreenshotScreen();
  const teal = K.WM_COLORS.desktop;
  check('opaque region untouched', String(px(shot, 12, 32)) === '255,0,0,255', px(shot, 12, 32));
  check('alpha 128 over red blends exactly',
    String(px(shot, 50, 60)) === [over(0, 255, 128), 0, over(255, 0, 128), 255].join(','),
    px(shot, 50, 60));
  check('alpha 128 over desktop blends exactly',
    String(px(shot, 50, 90)) ===
      [over(0, teal[0], 128), over(0, teal[1], 128), over(255, teal[2], 128), 255].join(','),
    px(shot, 50, 90));
  check('alpha 0 is fully transparent (red shows)',
    String(px(shot, 60, 60)) === '255,0,0,255', px(shot, 60, 60));
  check('alpha 255 is fully opaque',
    String(px(shot, 60, 90)) === '0,255,0,255', px(shot, 60, 90));

  // ---- scaled alpha surface: nearest map + the same blend ----
  check('scale the alpha surface 2x', kernel.wmSetDst(cB.sid, 128, 96));
  shot = kernel.wmScreenshotScreen();
  // dst (100, 40) -> src (50, 20): right half, alpha-0 band -> transparent.
  check('scaled alpha-0 pixel transparent over desktop',
    String(px(shot, 20 + 100, 54 + 40)) === teal.join(','), px(shot, 120, 94));
  // dst (20, 40) -> src (10, 20): 50%-alpha blue over the desktop.
  check('scaled alpha-128 pixel blends',
    String(px(shot, 20 + 20, 54 + 40)) ===
      [over(0, teal[0], 128), over(0, teal[1], 128), over(255, teal[2], 128), 255].join(','),
    px(shot, 40, 94));
  kernel.wmSetDst(cB.sid, 64, 48);

  // ---- SET_FLAGS can drop the alpha bit: pixels turn opaque copies ----
  await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: cB.sid, flags: 1 });
  shot = kernel.wmScreenshotScreen();
  check('bit3 cleared: alpha byte ignored (straight copy)',
    String(px(shot, 50, 60).slice(0, 3)) === '0,0,255', px(shot, 50, 60));
  await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: cB.sid, flags: 1 | 8 });

  // ---- wmThumbnail: exact box-filter averages ----
  const fbC = makeFb(8, 8);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbC.sab, ring: null });
  const cC = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 8, h: 8, title: 'pat', flags: 1 });
  // Left half red, right half blue; one white pixel to prove averaging.
  presentPattern(fbC, (x, y) =>
    x === 0 && y === 0 ? [255, 255, 255, 255] : (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  let th = kernel.wmThumbnail(cC.sid, 4, 4);
  check('thumb downscales to fit', th && th.w === 4 && th.h === 4, th && th.w + 'x' + th.h);
  // dst(0,0) averages {white, red, red, red}: r stays 255, g/b floor(255/4)=63.
  check('thumb box average exact', String(px(th, 0, 0)) === '255,63,63,255', px(th, 0, 0));
  check('thumb solid cells exact', String(px(th, 1, 1)) === '255,0,0,255' &&
    String(px(th, 2, 2)) === '0,0,255,255', px(th, 2, 2));
  th = kernel.wmThumbnail(cC.sid, 512, 512);
  check('thumb never upscales', th.w === 8 && th.h === 8, th.w + 'x' + th.h);
  th = kernel.wmThumbnail(cB.sid, 32, 480);    // 64x48 into 32x480: width binds
  check('thumb aspect fit', th.w === 32 && th.h === 24, th.w + 'x' + th.h);
  check('thumb of a bad sid is null', kernel.wmThumbnail(999, 8, 8) === null);

  // ---- glass: scene bit flips, headless composite is bit-identical ----
  check('glass defaults off', kernel.wmScene().glass === false);
  const before = kernel.wmScreenshotScreen();
  kernel.wmGlass(true);
  check('glass toggles on in the scene', kernel.wmScene().glass === true);
  const after = kernel.wmScreenshotScreen();
  check('glass NEVER changes the headless composite (todos/0063 constraint)',
    Buffer.compare(Buffer.from(before.rgba), Buffer.from(after.rgba)) === 0 &&
    before.w === after.w && before.h === after.h);
  kernel.wmGlass(false);
  check('glass toggles back off', kernel.wmScene().glass === false);

  // ---- minimize/restore animation records ----
  check('no anims at rest', kernel.wmScene().anims.length === 0);
  kernel.wmMinimize(cA.sid);
  let anims = kernel.wmScene().anims;
  check('minimize records a min anim with the geometry',
    anims.length === 1 && anims[0].kind === 'min' && anims[0].sid === cA.sid &&
    anims[0].x === 10 && anims[0].y === 30 && anims[0].w === 64 && anims[0].h === 48,
    JSON.stringify(anims));
  const shotMin = kernel.wmScreenshotScreen();
  check('anim never reaches the composite (minimized = gone)',
    String(px(shotMin, 12, 32)) === teal.join(','), px(shotMin, 12, 32));
  kernel.wmFocus(cA.sid);                      // restore
  anims = kernel.wmScene().anims;
  check('restore records a restore anim',
    anims.length === 1 && anims[0].kind === 'restore' && anims[0].sid === cA.sid,
    JSON.stringify(anims));
  await sleep(K.WM_ANIM_MS + 60);
  check('anims prune by age', kernel.wmScene().anims.length === 0);
  kernel.wmMinimize(cA.sid);
  await rpc(appPid, K.OP.SURFACE_DESTROY, { sid: cA.sid });
  check('destroy drops the anim record',
    kernel.wmScene().anims.length === 0);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
