#!/usr/bin/env node
// #794 owned top-levels + distinct popup dismissal: deterministic kernel RPC
// tests over fake workers (the test_wm_lifecycle.js shape). No boot, no
// browser, no manual evidence.
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

// ---- fake worker plumbing ----
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
  ['/bin/other', new Uint8Array([3])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const logLines = [];
const kernel = new K.Kernel({
  fs: kfs, createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {}, onPointerLock: () => {},
  log: (m) => logLines.push(m),
  screen: { w: 640, h: 480 },
  hungGraceMs: 300,          // #486: short grace so the veto leg runs in test time
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
function present(fb, rgba) {
  const front = Atomics.load(fb.i32, K.SH_FLIP) & 1;
  const back = 1 - front;
  const base = K.SH_HDR_BYTES + back * fb.w * fb.h * 4;
  for (let i = 0; i < fb.w * fb.h; i++) fb.u8.set(rgba, base + i * 4);
  Atomics.store(fb.i32, K.SH_FLIP, back);
  Atomics.add(fb.i32, K.SH_SEQ, 1);
}
function drain(ring) {
  const out = [];
  const cap2 = ring.cap * 2;
  let rpos = Atomics.load(ring.i32, K.IR_RPOS);
  while (rpos !== Atomics.load(ring.i32, K.IR_WPOS)) {
    const base = (K.IR_HDR_BYTES >> 2) + (rpos % ring.cap) * K.IR_RECORD_WORDS;
    out.push({ type: ring.i32[base], win: ring.i32[base + 1], reason: ring.i32[base + 2] });
    rpos = (rpos + 1) % cap2;
    Atomics.store(ring.i32, K.IR_RPOS, rpos);
  }
  return out;
}
const has = (evs, type, win) => evs.some((e) => e.type === type && (win === undefined || e.win === win));
const px = (shot, x, y) => Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));
const OP = K.OP, EV = K.WMEV;
const rec = (sid) => kernel.wmList().find((w) => w.sid === sid);
// The WMP record's flags word (field 7 of the 80-byte record).
const flags = (sid) => new DataView(kernel._wmpRecord(kernel._surfaces.get(sid)).buffer).getInt32(28, true);

(async () => {
  await kernel.boot({ path: '/bin/init' });
  const app = (await rpc(1, OP.SPAWN, { path:'/bin/app', argv:[], envp:[], actions:[], flags:0 })).pid;
  const other = (await rpc(1, OP.SPAWN, { path:'/bin/other', argv:[], envp:[], actions:[], flags:0 })).pid;
  const ring = makeRing(256), ringO = makeRing(64);
  const colors = {};
  async function create(pid, title, rgba, flags = 0, extra = {}, r = ring) {
    const fb = makeFb(80, 48); present(fb, rgba);
    workers.get(pid).msg({ type:'wm-sabs', fb:fb.sab, ring:r.sab });
    const resp = await rpc(pid, OP.SURFACE_CREATE, { w:80, h:48, title, flags, ...extra });
    colors[resp.sid] = rgba;
    return resp;
  }
  const RED = [200, 20, 20, 255], GRN = [20, 200, 20, 255], BLU = [20, 20, 200, 255],
        YEL = [200, 200, 20, 255], MAG = [211, 31, 171, 255];
  // Does the composite show any pixel of `rgba` anywhere? (a surface's own
  // solid fill is its fingerprint — surfaces are placed apart by cascade)
  function visibleColor(rgba) {
    const shot = kernel.wmScreenshotScreen();
    for (let i = 0; i < shot.rgba.length; i += 4)
      if (shot.rgba[i] === rgba[0] && shot.rgba[i + 1] === rgba[1] && shot.rgba[i + 2] === rgba[2]) return true;
    return false;
  }

  /* ---- capability + ownership rules ---- */
  const ownerR = await create(app, 'owner', RED);
  check('create advertises lifecycle level 2 (#794)', ownerR.lifecycle === 2, ownerR.lifecycle);
  const owner = ownerR.sid;
  const owned = (await create(app, 'owned', GRN)).sid;
  const foreign = (await create(other, 'foreign', YEL, 0, {}, ringO)).sid;
  let r;
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: owned, ownerSid: foreign });
  check('cross-process owner is EPERM', r.errno === 'EPERM', r.errno);
  r = await rpc(other, OP.SURFACE_SET_OWNER, { sid: owned, ownerSid: foreign });
  check('a foreign caller cannot re-own my window (EPERM)', r.errno === 'EPERM', r.errno);
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: owned, ownerSid: owned });
  check('self-ownership is EINVAL', r.errno === 'EINVAL', r.errno);
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: owned, ownerSid: 9999 });
  check('unknown owner is EINVAL', r.errno === 'EINVAL', r.errno);
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: owned, ownerSid: owner });
  check('same-process owner link accepted', !r.errno, r.errno);
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: owner, ownerSid: owned });
  check('ownership cycle is EINVAL', r.errno === 'EINVAL', r.errno);
  r = await rpc(app, OP.SURFACE_GET_STATE, { sid: owned });
  check('GET_STATE reports the owner and viewable', r.owner === owner && r.viewable === true && r.visible === true, JSON.stringify(r));
  check('WMP record carries WMP_F_OWNED (1024) + VIEWABLE (512)', (flags(owned) & 1024) && (flags(owned) & 512), flags(owned));
  check('the owner itself is not OWNED', !(flags(owner) & 1024));
  // anchored popups are neither owners nor owned
  const popupR = await create(app, '', BLU, 64 | 128, { parentSid: owned, dx: 4, dy: 4 });
  const popup = popupR.sid;
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: popup, ownerSid: owner });
  check('an anchored popup cannot take an owner (EINVAL)', r.errno === 'EINVAL', r.errno);
  const stray = (await create(app, 'stray', MAG)).sid;
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: stray, ownerSid: popup });
  check('an anchored popup cannot own (EINVAL)', r.errno === 'EINVAL', r.errno);
  await rpc(app, OP.SURFACE_DESTROY, { sid: stray });

  /* ---- stacking: owned above owner, group raises together ---- */
  const z = () => kernel._zOrder.slice();
  const above = (a, b) => z().indexOf(a) > z().indexOf(b);
  check('owned stacks above its owner', above(owned, owner));
  kernel.wmFocus(foreign);
  check('focusing a foreign window puts it above the group', above(foreign, owned) && above(foreign, owner));
  drain(ring);
  kernel.wmFocus(owned);
  check('focusing the owned window raises the owner group (owner above foreign)', above(owner, foreign) && above(owned, owner));
  check('focus lands on the owned window itself', kernel._focusSid === owned);
  kernel.wmFocus(foreign);
  kernel.wmFocus(owner);
  check('raising the owner carries the owned window above it', above(owned, owner) && above(owner, foreign));

  /* ---- effective visibility: hide the owner ---- */
  drain(ring);
  check('owned pixels composite before the owner hides', visibleColor(GRN));
  r = await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owner, visible: false });
  let evs = drain(ring);
  check('hiding the owner sends WINDOW_HIDDEN to the owned window too', has(evs, EV.WINDOW_HIDDEN, owned) && has(evs, EV.WINDOW_HIDDEN, owner));
  r = await rpc(app, OP.SURFACE_GET_STATE, { sid: owned });
  check('owned requested state preserved (visible) but not viewable', r.visible === true && r.viewable === false, JSON.stringify(r));
  check('WMP: owned keeps HIDDEN clear, VIEWABLE clear', !(flags(owned) & 256) && !(flags(owned) & 512), flags(owned));
  check('owned pixels leave the composite with the owner', !visibleColor(GRN) && !visibleColor(RED));
  check('popup of the owned window leaves too', !visibleColor(BLU));
  check('the popup grab was revoked (no grab holder while hidden)', kernel._wmGrabs.indexOf(popup) < 0);
  check('focus fell off the hidden group', kernel._focusSid !== owned && kernel._focusSid !== owner);
  r = await rpc(app, OP.SURFACE_ACTIVATE, { sid: owned });
  check('activating an owned window under a hidden owner is EACCES', r.errno === 'EACCES', r.errno);
  const hitHidden = kernel.wmPointer('down', rec(owned).x + 5, rec(owned).y + 5, {});
  kernel.wmPointer('up', rec(owned).x + 5, rec(owned).y + 5, {});
  check('a press where the owned window was does not reach it', !has(drain(ring), EV.MOUSEBUTTONDOWN, owned), hitHidden);
  r = await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owner, visible: true });
  evs = drain(ring);
  check('showing the owner sends WINDOW_SHOWN to the owned window', has(evs, EV.WINDOW_SHOWN, owned));
  r = await rpc(app, OP.SURFACE_GET_STATE, { sid: owned });
  check('owned viewable again without any request of its own', r.viewable === true);
  check('owned + popup pixels are back', visibleColor(GRN) && visibleColor(BLU));
  check('the surviving popup grab is restored with the group', kernel._wmGrabs.indexOf(popup) >= 0);

  /* ---- an owned window's OWN hide survives the owner's show ---- */
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owned, visible: false });
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owner, visible: false });
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owner, visible: true });
  r = await rpc(app, OP.SURFACE_GET_STATE, { sid: owned });
  check('an explicitly hidden owned window stays hidden when its owner shows', r.visible === false && r.viewable === false && !visibleColor(GRN));
  drain(ring);
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owned, visible: true });
  check('its own show brings it back', visibleColor(GRN) && has(drain(ring), EV.WINDOW_SHOWN, owned));

  /* ---- minimize the owner ---- */
  drain(ring);
  check('minimize owner accepted', kernel.wmMinimize(owner) === 0);
  evs = drain(ring);
  check('minimizing the owner sends WINDOW_HIDDEN to the owned window', has(evs, EV.WINDOW_HIDDEN, owned));
  check('owned pixels gone while the owner is minimized', !visibleColor(GRN));
  check('WMP: owned VIEWABLE clear, not MINIMIZED itself', !(flags(owned) & 512) && !(flags(owned) & 2));
  check('focus fell off the minimized group', kernel._focusSid !== owned && kernel._focusSid !== owner);
  check('focusing the owned window restores its minimized owner', kernel.wmFocus(owned) === 0 && !rec(owner).minimized);
  evs = drain(ring);
  check('...and the owned window gets WINDOW_SHOWN', has(evs, EV.WINDOW_SHOWN, owned) && visibleColor(GRN));
  check('...with focus on the owned window', kernel._focusSid === owned);

  /* ---- deep trees: owner -> owned -> owned2 (+popup), cascade destroy ---- */
  const CYN = [20, 200, 200, 255];
  const owned2 = (await create(app, 'owned2', CYN)).sid;
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: owned2, ownerSid: owned });
  check('owned windows can own (depth 2)', !r.errno, r.errno);
  check('depth-2 stacking: owned2 above owned above owner', above(owned2, owned) && above(owned, owner));
  drain(ring);
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owner, visible: false });
  evs = drain(ring);
  check('root hide reaches the depth-2 owned window', has(evs, EV.WINDOW_HIDDEN, owned2) && !visibleColor(CYN));
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: owner, visible: true });
  drain(ring);
  const before = kernel.wmList().length;
  const destroyed = [];
  kernel._wmSubs.forEach(() => {});
  // Observe EV_DESTROYED order through the kernel's emit seam.
  const origEmit = kernel._wmEmit.bind(kernel);
  kernel._wmEmit = function (type, payload) { if (type === K.WMP.EV_DESTROYED) destroyed.push(payload[0]); return origEmit(type, payload); };
  r = await rpc(app, OP.SURFACE_DESTROY, { sid: owner });
  kernel._wmEmit = origEmit;
  check('destroying the owner cascades to owned, owned2 and the popup', !r.errno && !rec(owned) && !rec(owned2) && !rec(popup) && !rec(owner));
  check('cascade order is deepest-first (popup, owned2, owned, owner)',
    destroyed.indexOf(popup) < destroyed.indexOf(owned) && destroyed.indexOf(owned2) < destroyed.indexOf(owned) && destroyed.indexOf(owned) < destroyed.indexOf(owner), JSON.stringify(destroyed));
  check('four surfaces gone', kernel.wmList().length === before - 4, kernel.wmList().length);
  check('no live owner links remain', kernel._wmOwnedN === 0 && kernel._wmAnchoredN === 0, kernel._wmOwnedN);
  check('foreign window untouched by the cascade', !!rec(foreign));

  /* ---- re-owning + clearing the link ---- */
  const a = (await create(app, 'A', RED)).sid, b = (await create(app, 'B', GRN)).sid;
  await rpc(app, OP.SURFACE_SET_OWNER, { sid: b, ownerSid: a });
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: a, visible: false });
  check('B hidden with A', !visibleColor(GRN));
  drain(ring);
  r = await rpc(app, OP.SURFACE_SET_OWNER, { sid: b, ownerSid: 0 });
  check('clearing the owner link is accepted', !r.errno, r.errno);
  check('...and B becomes viewable again on its own', visibleColor(GRN) && has(drain(ring), EV.WINDOW_SHOWN, b));
  r = await rpc(app, OP.SURFACE_GET_STATE, { sid: b });
  check('GET_STATE owner is 0 after clearing', r.owner === 0);
  await rpc(app, OP.SURFACE_SET_VISIBLE, { sid: a, visible: true });
  await rpc(app, OP.SURFACE_DESTROY, { sid: b });
  check('destroying an unlinked window leaves the ex-owner alone', !!rec(a));

  /* ---- popup dismissal is its own record and never arms the watchdog ---- */
  const host = a;
  const pop = (await create(app, '', BLU, 64 | 128, { parentSid: host, dx: 2, dy: 2 })).sid;
  kernel.wmFocus(host);
  drain(ring);
  const out = kernel.wmPointer('down', rec(foreign).x + 3, rec(foreign).y + 3, {});
  kernel.wmPointer('up', rec(foreign).x + 3, rec(foreign).y + 3, {});
  evs = drain(ring);
  const dis = evs.find((e) => e.type === EV.POPUP_DISMISSED && e.win === pop);
  check('outside press dismisses the popup', out === 'grab-dismiss', out);
  check('dismissal is a POPUP_DISMISSED record with reason 1', !!dis && dis.reason === 1);
  check('dismissal is never a QUIT record', !has(evs, EV.QUIT));
  check('dismissal never arms the close watchdog', !kernel._surfaces.get(pop).closeWd && !kernel._surfaces.get(host).closeWd);

  /* ---- close veto without false killing (owned window) ---- */
  const c = (await create(app, 'C', YEL)).sid;
  await rpc(app, OP.SURFACE_SET_OWNER, { sid: c, ownerSid: a });
  drain(ring);
  check('close request on an owned window delivers QUIT to it', kernel.wmCloseRequest(c) === 0 && has(drain(ring), EV.QUIT, c));
  // The app PUMPED the request (drain advanced rpos) and chose to keep the
  // window: that is a veto, and a responding app is never force-quit.
  await sleep(500);
  check('a pumped-but-vetoed close never force-quits the process', !workers.get(app).terminated && !!rec(c) && !!rec(a) && !!kernel.process(app));
  check('no force-quit was logged', !logLines.some((l) => /force quit/.test(l)), logLines.join('|'));

  /* ---- process exit reclaims owner trees ---- */
  const d = (await create(app, 'D', MAG)).sid;
  await rpc(app, OP.SURFACE_SET_OWNER, { sid: d, ownerSid: c });
  submit(app, OP.EXIT, { code: 0 });     // no response by design: the kernel tears down
  await tick(); await tick();
  check('process exit reclaims every surface incl. owner chains', !rec(a) && !rec(c) && !rec(d) && !rec(pop) && kernel._wmOwnedN === 0, kernel._wmOwnedN);
  check('foreign process still has its window', !!rec(foreign));

  console.log(failures ? `wm owned: ${failures} FAILED` : 'wm owned: PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
