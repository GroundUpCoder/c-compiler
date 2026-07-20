#!/usr/bin/env node
// The kernel key-grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md §3, CHUNK 1
// mechanism) without wasm: a scripted WM client (test_wm_policy.js plumbing)
// drives /run/wm.sock and injects raw key events via kernel.wmKey. Covers:
//   - GRAB_SET installs a table; a matching chord emits EV_HOTKEY {token,
//     flags, focusSid} and swallows BOTH key edges (the app sees nothing);
//   - exact-modifier match (Ctrl+F3 misses a bare-F3 grab, passes through);
//   - the Fable Shift amendment: a Shift-NAMED grab requires Shift (plain
//     ctrl+e never collapses to ctrl+shift+e's grab), a non-Shift grab still
//     matches with Shift held (flags bit0), and repeat rides flags bit1;
//   - n=0 empty table = no interception; WM_GRAB_MAX cap; non-subscriber ->
//     R_ERR; last-subscriber-gone resets to the built-in default table;
//   - the DEFAULT table reproduces the legacy EV_CYCLE/MENU/SNAP_KEY/SYSMENU
//     events (the back-compat guarantee) — this is the same set the UNMODIFIED
//     test_wm_policy.js legs assert through the historical action strings;
//   - the km-fold twin: kernel.wmKmFromSdl agrees with os/keys.h km_from_sdl
//     (maintained in two files by design) on a sweep of raw SDL mod words.
//
// Run: node tests/kernel/test_keybind.js
'use strict';
const path = require('path');
const fs = require('fs');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const { BLOCK_FS } = require(path.resolve(__dirname, '../../host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake worker plumbing (test_wm_policy.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, terminated: false,
    postMessage() {}, onMessage(fn) { h.msg = fn; },
    onExit(fn) { h.exitCb = fn; }, terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}
const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/app', new Uint8Array([2])],
  ['/bin/wm', new Uint8Array([3])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 22);
const kfs = BLOCK_FS.createV4(store);
const kernel = new K.Kernel({
  fs: kfs, createWorker, loadImage: (p) => images.get(p) || null,
  onHalt: () => {}, log: () => {}, screen: { w: 640, h: 480 },
});

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
function submit(pid, op, req, raw) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  if (raw) K.writeRawPayload(i32, u8, req); else K.writePayload(i32, u8, req);
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
function writeReq(fd, bytes) {
  const p = new Uint8Array(4 + bytes.length);
  new DataView(p.buffer).setInt32(0, fd, true);
  p.set(bytes, 4);
  return p;
}
const wRpc = (pid, fd, bytes) => submit(pid, K.OP.FS_WRITE, writeReq(fd, bytes), true).finish();

// ---- WM protocol client side ----
const WMP = K.WMP;
function frame(type, i32s) {
  const ilen = (i32s ? i32s.length : 0) * 4;
  const buf = new Uint8Array(8 + ilen);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 4 + ilen, true);
  dv.setUint32(4, type, true);
  for (let i = 0; i < (i32s ? i32s.length : 0); i++) dv.setInt32(8 + i * 4, i32s[i] | 0, true);
  return buf;
}
function mkConn(pid, fd) { return { pid, fd, acc: [], events: [] }; }
function parseOne(conn) {
  if (conn.acc.length < 4) return null;
  const dv0 = new DataView(Uint8Array.from(conn.acc.slice(0, 4)).buffer);
  const len = dv0.getUint32(0, true);
  if (conn.acc.length < 4 + len) return null;
  const bytes = Uint8Array.from(conn.acc.splice(0, 4 + len));
  const dv = new DataView(bytes.buffer);
  return { type: dv.getUint32(4, true), plen: len - 4, dv,
           g: (i) => dv.getInt32(8 + i * 4, true) };
}
async function readFrame(conn) {
  for (;;) {
    const f = parseOne(conn);
    if (f) return f;
    const r = await rpc(conn.pid, K.OP.FS_READ, { fd: conn.fd, count: 65536 });
    if (r.errno || !r.raw || r.raw.length === 0) throw new Error('read: ' + JSON.stringify(r.errno || 'EOF'));
    for (let i = 0; i < r.raw.length; i++) conn.acc.push(r.raw[i]);
  }
}
async function readReply(conn) {
  for (;;) {
    const f = await readFrame(conn);
    if (f.type >= 0x80) { conn.events.push(f); continue; }
    return f;
  }
}
async function readEvent(conn) {
  if (conn.events.length) return conn.events.shift();
  const f = await readFrame(conn);
  if (f.type >= 0x80) return f;
  throw new Error('reply frame while expecting an event: 0x' + f.type.toString(16));
}
const idle = (conn) => conn.acc.length === 0 && conn.events.length === 0;
const cmd = async (conn, type, i32s) => {
  await wRpc(conn.pid, conn.fd, frame(type, i32s || []));
  return readReply(conn);
};

// ---- surface-side helpers ----
function makeFb(w, h) {
  const sab = new SharedArrayBuffer(K.SH_HDR_BYTES + 2 * w * h * 4);
  const i32 = new Int32Array(sab);
  i32[K.SH_MAGIC] = K.SH_MAGIC_VALUE;
  i32[K.SH_W] = w; i32[K.SH_H] = h;
  return { sab, i32, u8: new Uint8Array(sab), w, h };
}
function makeRing(cap) {
  const sab = new SharedArrayBuffer(K.IR_HDR_BYTES + cap * K.IR_RECORD_WORDS * 4);
  new Int32Array(sab)[K.IR_CAP] = cap;
  return { sab, i32: new Int32Array(sab), f32: new Float32Array(sab), cap };
}
function drainRing(ring) {
  const out = [];
  const cap2 = ring.cap * 2;
  let rpos = Atomics.load(ring.i32, K.IR_RPOS);
  while (rpos !== Atomics.load(ring.i32, K.IR_WPOS)) {
    const base = (K.IR_HDR_BYTES >> 2) + (rpos % ring.cap) * K.IR_RECORD_WORDS;
    out.push({ type: ring.i32[base], win: ring.i32[base + 1],
               w: [ring.i32[base + 2], ring.i32[base + 3], ring.i32[base + 4], ring.i32[base + 5]] });
    rpos = (rpos + 1) % cap2;
    Atomics.store(ring.i32, K.IR_RPOS, rpos);
  }
  return out.filter((e) => e.type !== K.WMEV.FOCUS_GAINED && e.type !== K.WMEV.FOCUS_LOST);
}

// SDL raw modifier words (SDL_KMOD_*). Scancodes: F3 = 60, E = 8 (arbitrary —
// the kernel only compares scancode equality), plus the historical chord
// scancodes 43 Tab / 41 Esc / 44 Space / 79-82 arrows.
const KMOD_LSHIFT = 0x1, KMOD_LCTRL = 0x40, KMOD_LALT = 0x100, KMOD_LGUI = 0x400;
const SC_F3 = 60, SC_E = 8, SC_TAB = 43, SC_ESC = 41, SC_SPACE = 44, SC_LEFT = 80;

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  kernel.wmServe();

  // A focused app surface (created BEFORE any subscriber -> mapped + focused,
  // pre-0069 path) whose ring proves swallow-vs-passthrough.
  const ra = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const appPid = ra.pid;
  const fb = makeFb(64, 48), ring = makeRing(256);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb.sab, ring: ring.sab });
  const ca = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 64, h: 48, title: 'app', flags: 0 });
  const appSid = ca.sid;
  check('app surface created + focused', appSid > 0 && kernel.wmScene().focusSid === appSid,
    JSON.stringify([appSid, kernel.wmScene().focusSid]));

  // ---- connect + subscribe the scripted WM ----
  let r = await rpc(1, K.OP.SPAWN, { path: '/bin/wm', argv: ['wm'], envp: [], actions: [], flags: 0 });
  const wmPid = r.pid;
  r = await rpc(wmPid, K.OP.SOCK_SOCKET, {});
  const wmFd = r.fd;
  r = await rpc(wmPid, K.OP.SOCK_CONNECT, { fd: wmFd, path: '/run/wm.sock' });
  check('WM connects to /run/wm.sock', !r.errno, JSON.stringify(r));
  const wm = mkConn(wmPid, wmFd);
  let f = await cmd(wm, WMP.SUBSCRIBE);
  check('SUBSCRIBE -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm);                         // EV_CREATED (app)
  await readEvent(wm);                         // EV_FOCUS
  check('snapshot drained', idle(wm));

  // ============================================================= //
  //  A. the built-in DEFAULT table reproduces the legacy events   //
  // ============================================================= //
  // No GRAB_SET yet: _wmKeyGrabs is null, so WM_DEFAULT_GRABS is live. These
  // are the SAME chords the unmodified test_wm_policy.js legs assert; here we
  // prove the default-table path emits the legacy opcodes.
  let k = kernel.wmKey(true, SC_ESC, 27, KMOD_LCTRL, false);  // Ctrl+Esc
  check('default: Ctrl+Esc -> action "menu"', k === 'menu', k);
  f = await readEvent(wm);
  check('default: Ctrl+Esc emits legacy EV_MENU', f.type === WMP.EV_MENU, f.type);
  kernel.wmKey(false, SC_ESC, 27, KMOD_LCTRL, false);
  check('default: Ctrl+Esc keyup swallowed (app ring empty)', drainRing(ring).length === 0 && idle(wm));

  k = kernel.wmKey(true, SC_TAB, 9, KMOD_LALT, false);       // Alt+Tab
  f = await readEvent(wm);
  check('default: Alt+Tab -> legacy EV_CYCLE {+1}', k === 'cycle' &&
    f.type === WMP.EV_CYCLE && f.g(0) === 1, JSON.stringify([k, f.type, f.g(0)]));
  kernel.wmKey(false, SC_TAB, 9, KMOD_LALT, false);

  k = kernel.wmKey(true, SC_TAB, 9, KMOD_LCTRL | KMOD_LALT, false);  // Ctrl+Alt+Tab
  f = await readEvent(wm);
  check('default: Ctrl+Alt+Tab is the second cycle row -> EV_CYCLE',
    k === 'cycle' && f.type === WMP.EV_CYCLE && f.g(0) === 1, JSON.stringify([k, f.type]));
  kernel.wmKey(false, SC_TAB, 9, KMOD_LCTRL | KMOD_LALT, false);

  k = kernel.wmKey(true, SC_TAB, 9, KMOD_LSHIFT | KMOD_LALT, false); // Shift+Alt+Tab
  f = await readEvent(wm);
  check('default: Shift+Alt+Tab -> EV_CYCLE {-1} (Shift not named, masked out, reverses)',
    k === 'cycle' && f.type === WMP.EV_CYCLE && f.g(0) === -1, JSON.stringify([k, f.g(0)]));
  kernel.wmKey(false, SC_TAB, 9, KMOD_LSHIFT | KMOD_LALT, false);

  k = kernel.wmKey(true, SC_LEFT, 0, KMOD_LGUI, false);      // GUI+Left
  f = await readEvent(wm);
  check('default: GUI+Left -> legacy EV_SNAP_KEY {0}', k === 'snap' &&
    f.type === WMP.EV_SNAP_KEY && f.g(0) === 0, JSON.stringify([k, f.type, f.g(0)]));
  kernel.wmKey(false, SC_LEFT, 0, KMOD_LGUI, false);

  k = kernel.wmKey(true, SC_SPACE, 32, KMOD_LALT, false);    // Alt+Space
  f = await readEvent(wm);
  check('default: Alt+Space -> legacy EV_SYSMENU {focusSid}', k === 'sysmenu' &&
    f.type === WMP.EV_SYSMENU && f.g(0) === appSid, JSON.stringify([k, f.type, f.g(0)]));
  kernel.wmKey(false, SC_SPACE, 32, KMOD_LALT, false);

  // The TIGHTENING (intended): Ctrl+Alt+Esc no longer matches the {Esc, CTRL}
  // row under exact match -> it reaches the app.
  kernel.wmKey(true, SC_ESC, 27, KMOD_LCTRL | KMOD_LALT, false);
  kernel.wmKey(false, SC_ESC, 27, KMOD_LCTRL | KMOD_LALT, false);
  let a = drainRing(ring);
  check('tightening: Ctrl+Alt+Esc no longer opens Start (reaches the app)',
    a.length === 2 && a[0].type === K.WMEV.KEYDOWN && a[0].w[0] === SC_ESC, JSON.stringify(a));

  // ============================================================= //
  //  B. GRAB_SET installs a table; EV_HOTKEY + swallow both edges  //
  // ============================================================= //
  const TOK_A = 4242, TOK_SHIFT = 7000, TOK_CE = 9000;
  // F3 (no mods) -> TOK_A ; Ctrl+Shift+E -> TOK_SHIFT ; Ctrl+E -> TOK_CE.
  f = await cmd(wm, WMP.GRAB_SET, [3,
    SC_F3, 0, TOK_A,
    SC_E, K.KM_CTRL | K.KM_SHIFT, TOK_SHIFT,
    SC_E, K.KM_CTRL, TOK_CE]);
  check('GRAB_SET -> R_OK', f.type === WMP.R_OK, f.type);

  k = kernel.wmKey(true, SC_F3, 0, 0, false);               // bare F3
  f = await readEvent(wm);
  check('grab: bare F3 -> EV_HOTKEY {token, flags 0, focusSid}',
    k === 'grab' && f.type === WMP.EV_HOTKEY && f.g(0) === TOK_A &&
    f.g(1) === 0 && f.g(2) === appSid, JSON.stringify([k, f.type, f.g(0), f.g(1), f.g(2)]));
  k = kernel.wmKey(false, SC_F3, 0, 0, false);
  check('grab: F3 down AND up both swallowed (app ring empty)',
    k === 'grab' && drainRing(ring).length === 0 && idle(wm), k);

  // ============================================================= //
  //  C. exact-modifier match — Ctrl+F3 misses a bare-F3 grab      //
  // ============================================================= //
  kernel.wmKey(true, SC_F3, 0, KMOD_LCTRL, false);          // Ctrl+F3
  kernel.wmKey(false, SC_F3, 0, KMOD_LCTRL, false);
  a = drainRing(ring);
  check('exact match: Ctrl+F3 does NOT fire the bare-F3 grab (passes through)',
    a.length === 2 && a[0].type === K.WMEV.KEYDOWN && a[0].w[0] === SC_F3 &&
    a[0].w[2] === KMOD_LCTRL, JSON.stringify(a));

  // ============================================================= //
  //  D. the Shift amendment                                        //
  // ============================================================= //
  // A Shift-NAMED grab requires Shift: plain Ctrl+E must hit the {E, CTRL}
  // row (TOK_CE), never the {E, CTRL+SHIFT} row (TOK_SHIFT).
  k = kernel.wmKey(true, SC_E, 101, KMOD_LCTRL, false);     // Ctrl+E
  f = await readEvent(wm);
  check('shift rule: plain Ctrl+E -> TOK_CE (never collapses to the ctrl+shift+e grab)',
    f.type === WMP.EV_HOTKEY && f.g(0) === TOK_CE && f.g(1) === 0, JSON.stringify([f.g(0), f.g(1)]));
  kernel.wmKey(false, SC_E, 101, KMOD_LCTRL, false);
  // Ctrl+Shift+E hits the Shift-named row, flags bit0 set.
  k = kernel.wmKey(true, SC_E, 101, KMOD_LCTRL | KMOD_LSHIFT, false);
  f = await readEvent(wm);
  check('shift rule: Ctrl+Shift+E -> TOK_SHIFT with flags bit0 (Shift)',
    f.type === WMP.EV_HOTKEY && f.g(0) === TOK_SHIFT && (f.g(1) & 1) === 1, JSON.stringify([f.g(0), f.g(1)]));
  kernel.wmKey(false, SC_E, 101, KMOD_LCTRL | KMOD_LSHIFT, false);

  // A non-Shift grab STILL matches with Shift held (Shift masked out) — the
  // preserved rule. F3+Shift -> TOK_A, flags bit0 set.
  k = kernel.wmKey(true, SC_F3, 0, KMOD_LSHIFT, false);
  f = await readEvent(wm);
  check('shift rule: Shift+F3 still fires the bare-F3 grab, flags bit0 set',
    f.type === WMP.EV_HOTKEY && f.g(0) === TOK_A && (f.g(1) & 1) === 1, JSON.stringify([f.g(0), f.g(1)]));
  kernel.wmKey(false, SC_F3, 0, KMOD_LSHIFT, false);

  // repeat rides flags bit1.
  k = kernel.wmKey(true, SC_F3, 0, 0, true);
  f = await readEvent(wm);
  check('flags: key repeat sets bit1', f.type === WMP.EV_HOTKEY && (f.g(1) & 2) === 2, f.g(1));
  kernel.wmKey(false, SC_F3, 0, 0, false);

  // The custom table REPLACED the default: Ctrl+Esc is no longer grabbed.
  kernel.wmKey(true, SC_ESC, 27, KMOD_LCTRL, false);
  kernel.wmKey(false, SC_ESC, 27, KMOD_LCTRL, false);
  a = drainRing(ring);
  check('GRAB_SET replaces the whole table: Ctrl+Esc no longer grabbed',
    a.length === 2 && a[0].w[0] === SC_ESC, JSON.stringify(a));

  // ============================================================= //
  //  E. n=0 empty table = no interception                         //
  // ============================================================= //
  f = await cmd(wm, WMP.GRAB_SET, [0]);
  check('GRAB_SET n=0 -> R_OK (explicit empty table)', f.type === WMP.R_OK, f.type);
  kernel.wmKey(true, SC_F3, 0, 0, false);
  kernel.wmKey(false, SC_F3, 0, 0, false);
  a = drainRing(ring);
  check('empty table: even F3 reaches the app (WM wants no interception)',
    a.length === 2 && a[0].w[0] === SC_F3, JSON.stringify(a));

  // ============================================================= //
  //  F. WM_GRAB_MAX cap + non-subscriber refusal                  //
  // ============================================================= //
  const overN = K.WM_GRAB_MAX + 1;
  const over = [overN];
  for (let i = 0; i < overN; i++) over.push(SC_F3, 0, 1000 + i);
  f = await cmd(wm, WMP.GRAB_SET, over);
  check('GRAB_SET n > WM_GRAB_MAX -> R_ERR EINVAL',
    f.type === WMP.R_ERR && f.g(0) === 22, JSON.stringify([f.type, f.g(0)]));
  // exactly at the cap is accepted
  const atCap = [K.WM_GRAB_MAX];
  for (let i = 0; i < K.WM_GRAB_MAX; i++) atCap.push(SC_F3, 0, 2000 + i);
  f = await cmd(wm, WMP.GRAB_SET, atCap);
  check('GRAB_SET n == WM_GRAB_MAX -> R_OK', f.type === WMP.R_OK, f.type);

  // A second connection that never subscribed cannot install grabs.
  r = await rpc(wmPid, K.OP.SOCK_SOCKET, {});
  const otherFd = r.fd;
  await rpc(wmPid, K.OP.SOCK_CONNECT, { fd: otherFd, path: '/run/wm.sock' });
  const other = mkConn(wmPid, otherFd);
  f = await cmd(other, WMP.GRAB_SET, [1, SC_F3, 0, 1]);
  check('non-subscriber GRAB_SET -> R_ERR ENODEV', f.type === WMP.R_ERR && f.g(0) === 19,
    JSON.stringify([f.type, f.g(0)]));
  await rpc(wmPid, K.OP.FS_CLOSE, { fd: otherFd });

  // ============================================================= //
  //  G. last-subscriber-gone resets to the built-in default table //
  // ============================================================= //
  // Install a distinctive custom table, then drop the ONLY subscriber and
  // reconnect: the default table must be back (F3 no longer grabbed, Ctrl+Esc
  // opens the Start menu again).
  await cmd(wm, WMP.GRAB_SET, [1, SC_F3, 0, TOK_A]);
  await rpc(wmPid, K.OP.FS_CLOSE, { fd: wmFd });    // last subscriber gone
  await tick();
  r = await rpc(wmPid, K.OP.SOCK_SOCKET, {});
  const wmFd2 = r.fd;
  await rpc(wmPid, K.OP.SOCK_CONNECT, { fd: wmFd2, path: '/run/wm.sock' });
  const wm2 = mkConn(wmPid, wmFd2);
  f = await cmd(wm2, WMP.SUBSCRIBE);
  check('WM reconnects + resubscribes', f.type === WMP.R_OK);
  await readEvent(wm2);                             // EV_CREATED (app)
  await readEvent(wm2);                             // EV_FOCUS
  // F3 no longer grabbed (default table has no F3 row) -> reaches the app.
  kernel.wmKey(true, SC_F3, 0, 0, false);
  kernel.wmKey(false, SC_F3, 0, 0, false);
  a = drainRing(ring);
  check('reset: the custom F3 grab is gone after subscriber-gone',
    a.length === 2 && a[0].w[0] === SC_F3, JSON.stringify(a));
  // Ctrl+Esc opens Start again (default table restored).
  k = kernel.wmKey(true, SC_ESC, 27, KMOD_LCTRL, false);
  f = await readEvent(wm2);
  check('reset: Ctrl+Esc -> legacy EV_MENU again (default table restored)',
    k === 'menu' && f.type === WMP.EV_MENU, JSON.stringify([k, f.type]));
  kernel.wmKey(false, SC_ESC, 27, KMOD_LCTRL, false);

  // ============================================================= //
  //  H. km-fold twin: kernel.wmKmFromSdl == os/keys.h km_from_sdl  //
  // ============================================================= //
  // The two folds are maintained by hand in two files (kernel per-SYSTEM,
  // keys.h app-side). Parse keys.h's km_from_sdl masks + KM_* defines and
  // assert the kernel's exported fold agrees over a sweep of raw SDL words.
  const keysSrc = fs.readFileSync(path.resolve(__dirname, '../../os/keys.h'), 'utf8');
  const kmDef = {};
  for (const m of keysSrc.matchAll(/#define\s+KM_(\w+)\s+(0x[0-9a-fA-F]+)/g))
    kmDef[m[1]] = parseInt(m[2], 16);
  check('keys.h KM_* == kernel KM_*',
    kmDef.SHIFT === K.KM_SHIFT && kmDef.CTRL === K.KM_CTRL &&
    kmDef.ALT === K.KM_ALT && kmDef.GUI === K.KM_GUI, JSON.stringify(kmDef));
  // pull the (mask -> KM_NAME) pairs out of km_from_sdl's body
  const foldBody = keysSrc.slice(keysSrc.indexOf('km_from_sdl'));
  const pairs = [];
  for (const m of foldBody.matchAll(/sdlmod\s*&\s*(0x[0-9a-fA-F]+)\)\s*\?\s*KM_(\w+)/g)) {
    pairs.push([parseInt(m[1], 16), kmDef[m[2]]]);
    if (pairs.length === 4) break;
  }
  check('parsed 4 fold masks from keys.h', pairs.length === 4, JSON.stringify(pairs));
  const refFold = (sdl) => pairs.reduce((acc, [mask, bit]) => acc | ((sdl & mask) ? bit : 0), 0);
  let foldMismatch = -1;
  for (let sdl = 0; sdl <= 0xFFF; sdl++) {
    if (K.wmKmFromSdl(sdl) !== refFold(sdl)) { foldMismatch = sdl; break; }
  }
  check('kernel fold agrees with keys.h km_from_sdl over 0..0xFFF',
    foldMismatch === -1, 'first mismatch sdl=0x' + (foldMismatch >>> 0).toString(16));
  // spot-check the historical family words the default table relies on
  check('fold spot: LCTRL->CTRL, LALT->ALT, LGUI->GUI, LSHIFT->SHIFT',
    K.wmKmFromSdl(KMOD_LCTRL) === K.KM_CTRL && K.wmKmFromSdl(KMOD_LALT) === K.KM_ALT &&
    K.wmKmFromSdl(KMOD_LGUI) === K.KM_GUI && K.wmKmFromSdl(KMOD_LSHIFT) === K.KM_SHIFT);

  console.log(failures ? ('\ntest_keybind: ' + failures + ' FAILED') : '\ntest_keybind: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
