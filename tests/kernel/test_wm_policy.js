#!/usr/bin/env node
// The WM protocol (todos/0014) without wasm: a SCRIPTED wm client (fake
// worker, test_wm.js / test_sockets.js plumbing) drives the kernel-owned
// AF_UNIX endpoint at /run/wm.sock through the real SAB protocol —
// connect-to-kernel-peer, framing (partial + coalesced writes), the
// subscribe snapshot, every command, event fan-out to a parked read,
// minimize/borderless semantics, a megabyte R_SHOT reply, WM crash
// (kernel-chrome fallback intact) and respawn.
//
// Client discipline the test mirrors from the real C client: an action's
// event echo (EV_MOVED/EV_FOCUS) is emitted DURING the action, i.e. it hits
// a subscribed connection's stream before the R_OK — so a client awaiting a
// reply queues event frames (type >= 0x80) aside and consumes them from the
// queue. Frame/record layout MUST MATCH kernel.js WMP block + os/wm_proto.h.
//
// Run: node tests/kernel/test_wm_policy.js
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
  ['/bin/wm', new Uint8Array([3])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 22);
const kfs = BLOCK_FS.createV4(store);
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {},
  log: () => {},
  screen: { w: 640, h: 480 },
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
    pending: () => Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE,
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

// ---- WM protocol client side (what os/wm_proto.h does in C) ----
const WMP = K.WMP;
function frame(type, i32s, tail) {
  const ilen = (i32s ? i32s.length : 0) * 4, tlen = tail ? tail.length : 0;
  const buf = new Uint8Array(8 + ilen + tlen);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 4 + ilen + tlen, true);
  dv.setUint32(4, type, true);
  for (let i = 0; i < (i32s ? i32s.length : 0); i++) dv.setInt32(8 + i * 4, i32s[i] | 0, true);
  if (tail) buf.set(tail, 8 + ilen);
  return buf;
}
function f32bits(v) { const f = new Float32Array(1); f[0] = v; return new Int32Array(f.buffer)[0]; }

// Per-connection receive state: raw byte accumulator + an aside-queue for
// events that arrive while a reply is awaited.
function mkConn(pid, fd) { return { pid, fd, acc: [], events: [] }; }
function parseOne(conn) {
  if (conn.acc.length < 4) return null;
  const dv0 = new DataView(Uint8Array.from(conn.acc.slice(0, 4)).buffer);
  const len = dv0.getUint32(0, true);
  if (conn.acc.length < 4 + len) return null;
  const bytes = Uint8Array.from(conn.acc.splice(0, 4 + len));
  const dv = new DataView(bytes.buffer);
  return { type: dv.getUint32(4, true), plen: len - 4, dv, bytes,
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
  for (;;) {
    const f = await readFrame(conn);
    if (f.type >= 0x80) return f;
    throw new Error('reply frame while expecting an event: 0x' + f.type.toString(16));
  }
}
const idle = (conn) => conn.acc.length === 0 && conn.events.length === 0;
function rec(f, off) {                 // parse an 80-byte window record
  const b = 8 + (off || 0);
  let title = '';
  for (let i = 0; i < 32; i++) {
    const c = f.bytes[b + 48 + i];
    if (!c) break;
    title += String.fromCharCode(c);
  }
  return { sid: f.dv.getInt32(b, true), pid: f.dv.getInt32(b + 4, true),
           x: f.dv.getInt32(b + 8, true), y: f.dv.getInt32(b + 12, true),
           w: f.dv.getInt32(b + 16, true), h: f.dv.getInt32(b + 20, true),
           z: f.dv.getInt32(b + 24, true), flags: f.dv.getInt32(b + 28, true),
           frameSeq: f.dv.getInt32(b + 32, true),
           dstW: f.dv.getInt32(b + 36, true), dstH: f.dv.getInt32(b + 40, true),
           layer: f.dv.getInt32(b + 44, true),
           title };
}
const cmd = async (conn, type, i32s) => {
  await wRpc(conn.pid, conn.fd, frame(type, i32s || []));
  return readReply(conn);
};

// ---- surface-side helpers (test_wm.js shape) ----
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
function present(fb, rgba) {
  const front = Atomics.load(fb.i32, K.SH_FLIP) & 1;
  const back = 1 - front;
  const base = K.SH_HDR_BYTES + back * fb.w * fb.h * 4;
  for (let i = 0; i < fb.w * fb.h; i++) fb.u8.set(rgba, base + i * 4);
  Atomics.store(fb.i32, K.SH_FLIP, back);
  Atomics.add(fb.i32, K.SH_SEQ, 1);
}
function drainRing(ring) {
  const out = [];
  const cap2 = ring.cap * 2;
  let rpos = Atomics.load(ring.i32, K.IR_RPOS);
  while (rpos !== Atomics.load(ring.i32, K.IR_WPOS)) {
    const base = (K.IR_HDR_BYTES >> 2) + (rpos % ring.cap) * K.IR_RECORD_WORDS;
    out.push({ type: ring.i32[base], win: ring.i32[base + 1],
               w: [ring.i32[base + 2], ring.i32[base + 3], ring.i32[base + 4], ring.i32[base + 5]],
               f: [ring.f32[base + 2], ring.f32[base + 3]] });
    rpos = (rpos + 1) % cap2;
    Atomics.store(ring.i32, K.IR_RPOS, rpos);
  }
  return out;
}
const px = (buf, w, x, y) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- the endpoint: kernel as a native socket peer ----
  kernel.wmServe();                      // default /run/wm.sock
  const st = kfs.stat('/run/wm.sock');
  check('wmServe plants S_IFSOCK at /run/wm.sock', st && (st.mode & 0o170000) === 0o140000);
  kernel.wmServe();                      // reboot-over-same-image path
  check('wmServe is idempotent (re-plant after reboot)', kfs.stat('/run/wm.sock') !== null);

  // ---- spawn the scripted WM + connect ----
  const rw = await rpc(1, K.OP.SPAWN, { path: '/bin/wm', argv: ['wm'], envp: [], actions: [], flags: 0 });
  const wmPid = rw.pid;
  let r = await rpc(wmPid, K.OP.SOCK_SOCKET, {});
  const wmFd = r.fd;
  r = await rpc(wmPid, K.OP.SOCK_CONNECT, { fd: wmFd, path: '/run/wm.sock' });
  check('connect to the kernel endpoint (no listener process)', !r.errno, JSON.stringify(r));
  const wm = mkConn(wmPid, wmFd);

  // ---- distinct R_ERR errnos (todos/0242): a policy gesture refuses
  // with ENODEV while no WM is subscribed — the cause, not a generic 22 ----
  let f = await cmd(wm, WMP.MENU);
  check('MENU with no subscriber -> R_ERR ENODEV (todos/0242)',
    f.type === WMP.R_ERR && f.g(0) === 19, JSON.stringify([f.type, f.g(0)]));

  // ---- subscribe on an empty scene: R_OK + focus-0 snapshot ----
  f = await cmd(wm, WMP.SUBSCRIBE);
  check('SUBSCRIBE -> R_OK with screen dims', f.type === WMP.R_OK &&
    f.g(0) === 640 && f.g(1) === 480, JSON.stringify([f.g(0), f.g(1)]));
  f = await readEvent(wm);
  check('empty snapshot is just EV_FOCUS 0', f.type === WMP.EV_FOCUS && f.g(0) === 0 && idle(wm),
    JSON.stringify([f.type, f.g(0)]));

  // ---- a window appears: EV_CREATED + EV_FOCUS push to the subscriber ----
  const ra = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const appPid = ra.pid;
  const fb1 = makeFb(64, 48);
  const ring1 = makeRing(64);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb1.sab, ring: ring1.sab });
  // flags bit2 = resizable (todos/0021) — the RESIZE leg below needs it.
  const c1 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 64, h: 48, title: 'app one', flags: 4 });
  f = await readEvent(wm);
  const w1 = rec(f);
  check('EV_CREATED pushed with the full record',
    f.type === WMP.EV_CREATED && w1.sid === c1.sid && w1.pid === appPid &&
    w1.w === 64 && w1.h === 48 && w1.title === 'app one' && (w1.flags & 1) === 1,
    JSON.stringify(w1));
  check('record flag bit4 = resizable (todos/0021)', (w1.flags & 16) === 16,
    JSON.stringify(w1));
  f = await readEvent(wm);
  check('EV_FOCUS follows create', f.type === WMP.EV_FOCUS && f.g(0) === c1.sid);

  // ---- LIST ----
  f = await cmd(wm, WMP.LIST);
  check('LIST -> one 72-byte record', f.type === WMP.R_LIST && f.g(0) === 1 &&
    f.plen === 4 + K.WMP_REC_BYTES && rec(f, 4).sid === c1.sid, JSON.stringify([f.plen, f.g(0)]));

  // ---- MOVE: R_OK + the scene moved + the echo event ----
  f = await cmd(wm, WMP.MOVE, [c1.sid, 100, 120]);
  check('MOVE -> R_OK', f.type === WMP.R_OK);
  const moved = kernel.wmList()[0];
  check('scene moved', moved.x === 100 && moved.y === 120, JSON.stringify(moved));
  f = await readEvent(wm);
  check('EV_MOVED echoed to the subscriber',
    f.type === WMP.EV_MOVED && f.g(0) === c1.sid && f.g(1) === 100 && f.g(2) === 120);

  // ---- framing: split header, split payload, coalesced frames ----
  const mv = frame(WMP.MOVE, [c1.sid, 101, 121]);
  await wRpc(wmPid, wmFd, mv.subarray(0, 3));            // mid-header
  await wRpc(wmPid, wmFd, mv.subarray(3, 10));           // mid-payload
  await wRpc(wmPid, wmFd, mv.subarray(10));
  f = await readReply(wm);
  check('reassembles a frame split across three writes', f.type === WMP.R_OK);
  await readEvent(wm);                                   // EV_MOVED echo
  const two = new Uint8Array([...frame(WMP.FOCUS, [c1.sid]), ...frame(WMP.LIST, [])]);
  await wRpc(wmPid, wmFd, two);
  f = await readReply(wm);
  const f2 = await readReply(wm);
  check('dispatches two frames from one write', f.type === WMP.R_OK && f2.type === WMP.R_LIST,
    JSON.stringify([f.type, f2.type]));

  // ---- R_ERR on a bogus sid ----
  f = await cmd(wm, WMP.MOVE, [999, 0, 0]);
  check('MOVE bogus sid -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);

  // ---- borderless (taskbar-class) surface ----
  const fbT = makeFb(640, 24);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbT.sab, ring: null });
  const ct = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 640, h: 24, title: 'taskbar', flags: 1 });
  f = await readEvent(wm);
  check('borderless create: flag bit2 in the record',
    f.type === WMP.EV_CREATED && (rec(f).flags & 4) === 4, JSON.stringify(rec(f)));
  await readEvent(wm);                                   // its EV_FOCUS
  f = await cmd(wm, WMP.MOVE, [ct.sid, 0, 456]);         // park at the bottom
  check('taskbar moved to the bottom edge', f.type === WMP.R_OK);
  await readEvent(wm);                                   // EV_MOVED echo
  // No title-bar band: a click just above it falls through to the desktop.
  check('borderless has no chrome band', kernel.wmPointer('down', 320, 450, {}) === 'desktop');
  kernel.wmPointer('up', 320, 450, {});
  // Clicks land in the borderless client but never steal focus (the taskbar
  // must see the focus state it acts on — the browser-test minimize toggle).
  const focusBefore = kernel.wmScene().focusSid;
  check('borderless click routes without stealing focus',
    kernel.wmPointer('down', 320, 460, {}) === 'client' &&
    kernel.wmScene().focusSid === focusBefore);
  kernel.wmPointer('up', 320, 460, {});
  drainRing(ring1);      // the taskbar shares the app's ring in this test
  present(fbT, [10, 20, 30, 255]);
  const scr1 = kernel.wmScreenshotScreen();
  check('composite: borderless pixels, no chrome above',
    String(px(scr1.rgba, scr1.w, 320, 460)) === '10,20,30,255' &&
    String(px(scr1.rgba, scr1.w, 320, 455)) === '0,128,128,255',
    JSON.stringify([px(scr1.rgba, scr1.w, 320, 460), px(scr1.rgba, scr1.w, 320, 455)]));

  // ---- minimize / restore ----
  present(fb1, [200, 0, 0, 255]);
  f = await cmd(wm, WMP.FOCUS, [c1.sid]);                // focus the app window
  check('FOCUS -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm);
  check('EV_FOCUS echo', f.type === WMP.EV_FOCUS && f.g(0) === c1.sid);
  f = await cmd(wm, WMP.MINIMIZE, [c1.sid]);
  check('MINIMIZE -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm);
  check('EV_MINIMIZED 1', f.type === WMP.EV_MINIMIZED && f.g(0) === c1.sid && f.g(1) === 1);
  f = await readEvent(wm);
  check('focus falls off the minimized window', f.type === WMP.EV_FOCUS && f.g(0) === ct.sid);
  check('wmList reports minimized', kernel.wmList().find(s => s.sid === c1.sid).minimized === true);
  const scr2 = kernel.wmScreenshotScreen();
  check('composite skips the minimized window',
    String(px(scr2.rgba, scr2.w, 101, 121)) === '0,128,128,255', px(scr2.rgba, scr2.w, 101, 121));
  check('hit test skips the minimized window', kernel.wmPointer('down', 110, 130, {}) === 'desktop');
  kernel.wmPointer('up', 110, 130, {});
  f = await cmd(wm, WMP.RESTORE, [c1.sid]);
  check('RESTORE -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm);
  check('EV_MINIMIZED 0 on restore', f.type === WMP.EV_MINIMIZED && f.g(0) === c1.sid && f.g(1) === 0);
  f = await readEvent(wm);
  check('restore refocuses', f.type === WMP.EV_FOCUS && f.g(0) === c1.sid);
  check('restored + unminimized', kernel.wmList().find(s => s.sid === c1.sid).minimized === false);

  // ---- restack ----
  f = await cmd(wm, WMP.RESTACK, [c1.sid, 1]);           // lower
  check('RESTACK lower -> bottom of z', f.type === WMP.R_OK && kernel.wmList()[0].sid === c1.sid);
  f = await cmd(wm, WMP.RESTACK, [c1.sid, 0]);           // raise
  check('RESTACK raise -> top of z', f.type === WMP.R_OK &&
    kernel.wmList()[kernel.wmList().length - 1].sid === c1.sid);

  // ---- injection + close request drive the app's ring ----
  f = await cmd(wm, WMP.INJECT_KEY, [c1.sid, 1, 44, 32, 0]);
  check('INJECT_KEY -> R_OK', f.type === WMP.R_OK);
  f = await cmd(wm, WMP.INJECT_POINTER, [c1.sid, 1, f32bits(7), f32bits(9), 2, 0]);
  check('INJECT_POINTER down -> R_OK', f.type === WMP.R_OK);
  f = await cmd(wm, WMP.CLOSE_REQ, [c1.sid]);
  check('CLOSE_REQ -> R_OK', f.type === WMP.R_OK);
  const evs = drainRing(ring1);
  check('key + button + QUIT landed in the app ring',
    evs.length === 3 && evs[0].type === K.WMEV.KEYDOWN && evs[0].w[0] === 44 &&
    evs[1].type === K.WMEV.MOUSEBUTTONDOWN && evs[1].w[2] === 2 &&
    evs[1].f[0] === 7 && evs[1].f[1] === 9 && evs[2].type === K.WMEV.QUIT,
    JSON.stringify(evs));

  // ---- relative mouse (todos/0018): rel inject + record flag bit3 ----
  f = await cmd(wm, WMP.INJECT_POINTER, [c1.sid, 4 /* rel */, f32bits(6), f32bits(-4), 1, 0]);
  check('INJECT_POINTER rel -> R_OK', f.type === WMP.R_OK);
  const relEvs = drainRing(ring1);
  check('rel inject: deltas + buttons + rel flag in the record',
    relEvs.length === 1 && relEvs[0].type === K.WMEV.MOUSEMOTION &&
    relEvs[0].f[0] === 6 && relEvs[0].f[1] === -4 &&
    relEvs[0].w[2] === 1 && relEvs[0].w[3] === 1, JSON.stringify(relEvs));
  // (keep bit2: SET_FLAGS replaces the whole word, and the resize leg
  // below needs c1 to stay resizable — todos/0021)
  await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: c1.sid, flags: 2 | 4 });
  f = await cmd(wm, WMP.LIST);
  check('record flag bit3 = relative-mouse', f.type === WMP.R_LIST &&
    (function () {
      for (let i = 0; i < f.g(0); i++) {
        const r0 = rec(f, 4 + i * K.WMP_REC_BYTES);
        if (r0.sid === c1.sid) return (r0.flags & 8) === 8;
      }
      return false;
    })(), JSON.stringify(f.g(0)));
  await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: c1.sid, flags: 4 });

  // ---- SHOT: single surface, then the megabyte screen composite ----
  f = await cmd(wm, WMP.SHOT, [c1.sid]);
  check('R_SHOT: dims + presented pixel', f.type === WMP.R_SHOT &&
    f.g(1) === 64 && f.g(2) === 48 &&
    String(px(f.bytes.subarray(20), 64, 5, 5)) === '200,0,0,255',
    JSON.stringify([f.g(1), f.g(2)]));
  f = await cmd(wm, WMP.SHOT_SCREEN, []);
  check('R_SHOT screen: 640x480 rides the socket in chunks (1.2MB)',
    f.type === WMP.R_SHOT && f.g(1) === 640 && f.g(2) === 480 &&
    f.plen === 12 + 640 * 480 * 4, JSON.stringify([f.plen]));
  check('screen shot pixels match the direct composite',
    String(px(f.bytes.subarray(20), 640, 320, 460)) === '10,20,30,255');

  // ---- Aero effects (todos/0063): THUMB, GLASS, the F_ALPHA record bit ----
  f = await cmd(wm, WMP.THUMB, [c1.sid, 16, 16]);
  check('THUMB -> R_SHOT with aspect-fit dims (64x48 into 16x16 = 16x12)',
    f.type === WMP.R_SHOT && f.g(0) === c1.sid && f.g(1) === 16 && f.g(2) === 12 &&
    f.plen === 12 + 16 * 12 * 4, JSON.stringify([f.g(0), f.g(1), f.g(2), f.plen]));
  check('THUMB pixels are the box-filtered present',
    String(px(f.bytes.subarray(20), 16, 8, 6)) === '200,0,0,255');
  f = await cmd(wm, WMP.THUMB, [999, 16, 16]);
  check('THUMB bogus sid -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);
  f = await cmd(wm, WMP.GLASS, [1]);
  check('GLASS on -> R_OK + scene bit', f.type === WMP.R_OK && kernel.wmScene().glass === true);
  f = await cmd(wm, WMP.GLASS, [0]);
  check('GLASS off -> R_OK + scene bit', f.type === WMP.R_OK && kernel.wmScene().glass === false);
  // Has-alpha surfaces (create flags bit3) carry record flag bit5.
  const fbAl = makeFb(16, 16);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbAl.sab, ring: null });
  const cAl = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 16, h: 16, title: 'glassy', flags: 8 });
  f = await readEvent(wm);
  check('EV_CREATED record flag bit5 = has-alpha (todos/0063)',
    f.type === WMP.EV_CREATED && rec(f).sid === cAl.sid && (rec(f).flags & 32) === 32,
    JSON.stringify(rec(f)));
  await readEvent(wm);                                   // its EV_FOCUS
  await rpc(appPid, K.OP.SURFACE_DESTROY, { sid: cAl.sid });
  await readEvent(wm);                                   // EV_DESTROYED
  await readEvent(wm);                                   // the focus fall's EV_FOCUS

  // ---- resize: RESIZE command -> client renegotiates -> EV_CONFIGURED ----
  f = await cmd(wm, WMP.RESIZE, [c1.sid, 100, 70]);
  check('RESIZE -> R_OK', f.type === WMP.R_OK);
  const rr = drainRing(ring1);
  check('client got WINDOW_RESIZED', rr.length === 1 &&
    rr[0].type === K.WMEV.WINDOW_RESIZED && rr[0].win === c1.sid &&
    rr[0].w[0] === 100 && rr[0].w[1] === 70, JSON.stringify(rr));
  const fbR = makeFb(100, 70);
  present(fbR, [50, 60, 70, 255]);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbR.sab, ring: null });
  const rAck = await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: c1.sid, w: 100, h: 70 });
  check('SURFACE_CONFIGURE ack ok', !rAck.errno, JSON.stringify(rAck));
  f = await readEvent(wm);
  check('EV_CONFIGURED { sid, w, h } at the ack', f.type === WMP.EV_CONFIGURED &&
    f.g(0) === c1.sid && f.g(1) === 100 && f.g(2) === 70,
    JSON.stringify([f.type, f.g(0), f.g(1), f.g(2)]));
  check('kernel geometry follows the ack',
    kernel.wmList().find(s => s.sid === c1.sid).w === 100);
  f = await cmd(wm, WMP.RESIZE, [999, 64, 64]);
  check('RESIZE bogus sid -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);
  f = await cmd(wm, WMP.RESIZE, [c1.sid, 8, 8]);
  check('RESIZE below the size floor -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);
  // Ring-full delivery (todos/0242): the kernel knew EAGAIN and threw it
  // away pre-fix — flood the client's cap-64 ring, then ask for a resize.
  for (let i = 0; i < 70; i++) kernel.wmInjectKey(c1.sid, true, 4, 97, 0);
  f = await cmd(wm, WMP.RESIZE, [c1.sid, 90, 60]);
  check('RESIZE into a full client ring -> R_ERR EAGAIN (todos/0242)',
    f.type === WMP.R_ERR && f.g(0) === 11, JSON.stringify([f.type, f.g(0)]));
  check('ring-full RESIZE left nothing pending',
    kernel.wmList().find(s => s.sid === c1.sid).configurePending === false);
  drainRing(ring1);                                    // shed the flood
  // Non-resizable gating (todos/0021): the taskbar was created without
  // flags bit2, so RESIZE is refused and its record carries no bit4.
  f = await cmd(wm, WMP.RESIZE, [ct.sid, 100, 24]);
  check('RESIZE a non-resizable surface -> R_ERR EPERM (todos/0021, 0242)',
    f.type === WMP.R_ERR && f.g(0) === 1, JSON.stringify([f.type, f.g(0)]));
  check('non-resizable stays unchanged, nothing pending',
    kernel.wmList().find(s => s.sid === ct.sid).w === 640 &&
    kernel.wmList().find(s => s.sid === ct.sid).configurePending === false);
  f = await cmd(wm, WMP.LIST);
  check('record flag bit4 clear on the non-resizable surface',
    f.type === WMP.R_LIST && (() => {
      for (let i = 0; i < f.g(0); i++) {
        const r0 = rec(f, 4 + i * K.WMP_REC_BYTES);
        if (r0.sid === ct.sid) return (r0.flags & 16) === 0;
      }
      return false;
    })());

  // ---- viewport scaling (todos/0024): SET_DST/EV_SCALED, the scale-request
  // path (frame drag on a fixed-size surface -> EV_SCALE_REQ -> policy
  // answers), scaled hit-test/input, and the NN composite over the socket ----
  const fbX = makeFb(40, 30);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbX.sab, ring: null });
  const cx = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 40, h: 30, title: 'fixed' });
  f = await readEvent(wm);
  check('fixed-size create: record dst defaults to the buffer',
    f.type === WMP.EV_CREATED && rec(f).sid === cx.sid &&
    rec(f).dstW === 40 && rec(f).dstH === 30, JSON.stringify(rec(f)));
  await readEvent(wm);                                   // its EV_FOCUS
  f = await cmd(wm, WMP.SET_DST, [c1.sid, 200, 140]);
  check('SET_DST on a RESIZABLE surface -> R_ERR EPERM (it configures, never scales)',
    f.type === WMP.R_ERR && f.g(0) === 1, JSON.stringify([f.type, f.g(0)]));
  f = await cmd(wm, WMP.SET_DST, [cx.sid, 8, 8]);
  check('SET_DST below the size floor -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);
  f = await cmd(wm, WMP.SET_DST, [cx.sid, 80, 60]);
  check('SET_DST -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm);
  check('EV_SCALED echo { sid, dstW, dstH }', f.type === WMP.EV_SCALED &&
    f.g(0) === cx.sid && f.g(1) === 80 && f.g(2) === 60,
    JSON.stringify([f.type, f.g(0), f.g(1), f.g(2)]));
  check('scene tracks the dst, buffer untouched', (() => {
    const s = kernel.wmList().find(s => s.sid === cx.sid);
    return s.dstW === 80 && s.dstH === 60 && s.w === 40 && s.h === 30;
  })(), JSON.stringify(kernel.wmList().find(s => s.sid === cx.sid)));
  f = await cmd(wm, WMP.LIST);
  check('LIST record carries the dst dims', f.type === WMP.R_LIST && (() => {
    for (let i = 0; i < f.g(0); i++) {
      const r0 = rec(f, 4 + i * K.WMP_REC_BYTES);
      if (r0.sid === cx.sid) return r0.dstW === 80 && r0.dstH === 60 && r0.w === 40;
    }
    return false;
  })());

  // The drag path WITH a WM subscribed: the kernel emits EV_SCALE_REQ and
  // waits for policy — no dst change until the SET_DST answer lands.
  f = await cmd(wm, WMP.MOVE, [cx.sid, 60, 300]);
  check('park the fixed surface -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm);                                   // EV_MOVED echo
  // cx was created last: already focused and topmost for the drag.
  let ract = kernel.wmPointer('down', 60 + 80 + 1, 300 + 60 + 1, {});   // SE grip at the DST corner
  check('SE grip on the scaled surface starts a scale drag', ract === 'resize-start', ract);
  kernel.wmPointer('move', 60 + 80 + 41, 300 + 60 + 31, {});
  ract = kernel.wmPointer('up', 60 + 80 + 41, 300 + 60 + 31, {});
  check('release ends the drag', ract === 'resize-end', ract);
  f = await readEvent(wm);
  check('EV_SCALE_REQ { sid, w, h } with the dragged box', f.type === WMP.EV_SCALE_REQ &&
    f.g(0) === cx.sid && f.g(1) === 120 && f.g(2) === 90,
    JSON.stringify([f.type, f.g(0), f.g(1), f.g(2)]));
  check('kernel waits for policy (dst unchanged, nothing configured)', (() => {
    const s = kernel.wmList().find(s => s.sid === cx.sid);
    return s.dstW === 80 && s.dstH === 60 && s.configurePending === false;
  })());
  f = await cmd(wm, WMP.SET_DST, [cx.sid, 120, 90]);     // the policy answer
  check('policy answer applies', f.type === WMP.R_OK &&
    kernel.wmList().find(s => s.sid === cx.sid).dstW === 120);
  await readEvent(wm);                                   // EV_SCALED echo
  check('no WINDOW_RESIZED ever reached the client (app oblivious)',
    drainRing(ring1).length === 0);

  // Scaled input through the real hit-test: screen coords inverse-map to
  // BUFFER coords (3x now: 40x30 -> 120x90).
  kernel.wmPointer('down', 60 + 90, 300 + 60, { button: 1 });   // dst (90,60) -> buffer (30,20)
  kernel.wmPointer('up', 60 + 90, 300 + 60, { button: 1 });
  const sevs = drainRing(ring1);
  check('pointer input inverse-maps through the scale (90,60 -> 30,20)',
    sevs.length === 2 && sevs[0].win === cx.sid &&
    sevs[0].f[0] === 30 && sevs[0].f[1] === 20, JSON.stringify(sevs));

  // The NN composite rides SHOT_SCREEN: left half red / right half blue in
  // the 40x30 buffer -> exact halves of the 120x90 dst (integer 3x).
  {
    const front = Atomics.load(fbX.i32, K.SH_FLIP) & 1;
    const back = 1 - front;
    const base = K.SH_HDR_BYTES + back * 40 * 30 * 4;
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 40; x++) {
        fbX.u8.set(x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255], base + (y * 40 + x) * 4);
      }
    }
    Atomics.store(fbX.i32, K.SH_FLIP, back);
    Atomics.add(fbX.i32, K.SH_SEQ, 1);
  }
  f = await cmd(wm, WMP.SHOT_SCREEN, []);
  check('scaled SHOT_SCREEN: exact NN halves at 3x', f.type === WMP.R_SHOT && (() => {
    const rgba = f.bytes.subarray(20), W = f.g(1);
    return String(px(rgba, W, 60 + 59, 300 + 45)) === '255,0,0,255' &&
           String(px(rgba, W, 60 + 60, 300 + 45)) === '0,0,255,255' &&
           String(px(rgba, W, 60 + 119, 300 + 89)) === '0,0,255,255';
  })(), f.type);

  // Clean up: destroy the fixed surface (the focus fall precedes the
  // EV_DESTROYED — kernel emit order).
  await rpc(appPid, K.OP.SURFACE_DESTROY, { sid: cx.sid });
  f = await readEvent(wm);
  check('focus falls off the destroyed surface', f.type === WMP.EV_FOCUS,
    JSON.stringify([f.type, f.g(0)]));
  f = await readEvent(wm);
  check('fixed surface destroyed', f.type === WMP.EV_DESTROYED &&
    f.g(0) === cx.sid && idle(wm), JSON.stringify([f.type, f.g(0)]));

  // ---- dynamic screen resolution (todos/0023): EV_SCREEN + the clamp ----
  // Park c1 (100x70 after the configure) near the bottom-right corner, then
  // shrink the screen: the subscriber gets EV_SCREEN {w,h} first, then the
  // kernel's one-shot clamp emits EV_MOVED per stranded window (title bars
  // stay reachable — the no-WM fallback guarantee). Borderless surfaces are
  // skipped: their placement is WM policy.
  f = await cmd(wm, WMP.MOVE, [c1.sid, 500, 400]);
  check('pre-shrink park at the bottom-right -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm);                                   // EV_MOVED echo
  kernel.wmSetScreen(320, 240);
  f = await readEvent(wm);
  check('EV_SCREEN { w, h } pushed on wmSetScreen', f.type === WMP.EV_SCREEN &&
    f.g(0) === 320 && f.g(1) === 240, JSON.stringify([f.type, f.g(0), f.g(1)]));
  f = await readEvent(wm);
  check('one-shot clamp: EV_MOVED to a reachable spot (280,232)',
    f.type === WMP.EV_MOVED && f.g(0) === c1.sid && f.g(1) === 280 && f.g(2) === 232,
    JSON.stringify([f.g(0), f.g(1), f.g(2)]));
  const cl1 = kernel.wmList().find(s => s.sid === c1.sid);
  check('clamped geometry in the scene (title bar reachable)',
    cl1.x === 280 && cl1.y === 232 && idle(wm), JSON.stringify(cl1));
  check('borderless surface skipped by the clamp (WM policy owns it)',
    kernel.wmList().find(s => s.sid === ct.sid).y === 456);
  kernel.wmSetScreen(320, 240);          // unchanged -> must NOT push EV_SCREEN
  f = await cmd(wm, WMP.MOVE, [c1.sid, 60, 50]);
  check('MOVE after the no-op resize -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm);
  check('same-dims wmSetScreen pushed nothing (next event is the MOVE echo)',
    f.type === WMP.EV_MOVED && f.g(1) === 60 && idle(wm), JSON.stringify([f.type, f.g(1)]));
  kernel.wmSetScreen(640, 480);          // grow back: EV_SCREEN, no moves
  f = await readEvent(wm);
  check('grow emits EV_SCREEN and clamps nothing', f.type === WMP.EV_SCREEN &&
    f.g(0) === 640 && idle(wm), JSON.stringify([f.type, f.g(0)]));

  // ---- a parked read wakes on a pushed event ----
  check('connection quiescent before the park', idle(wm));
  const parked = submit(wmPid, K.OP.FS_READ, { fd: wmFd, count: 65536 });
  await tick();
  check('event read parks when idle', parked.pending());
  await rpc(appPid, K.OP.SURFACE_SET_TITLE, { sid: c1.sid, title: 'renamed' });
  r = await parked.finish();
  for (let i = 0; i < r.raw.length; i++) wm.acc.push(r.raw[i]);
  f = await readEvent(wm);
  let title = '';                                        // 32-byte field at payload+4
  for (let i = 12; i < 44 && f.bytes[i]; i++) title += String.fromCharCode(f.bytes[i]);
  check('parked read woken by EV_TITLE', f.type === WMP.EV_TITLE && f.g(0) === c1.sid &&
    title === 'renamed', JSON.stringify([f.type, title]));

  // ---- second client (wmctl-style): commands work, no event spam ----
  r = await rpc(wmPid, K.OP.SOCK_SOCKET, {});
  const ctlFd = r.fd;
  await rpc(wmPid, K.OP.SOCK_CONNECT, { fd: ctlFd, path: '/run/wm.sock' });
  const ctl = mkConn(wmPid, ctlFd);
  f = await cmd(ctl, WMP.LIST);
  check('wmctl-style connection: LIST works unsubscribed', f.type === WMP.R_LIST && f.g(0) === 2);
  f = await cmd(ctl, WMP.MOVE, [c1.sid, 30, 40]);
  check('wmctl MOVE ok', f.type === WMP.R_OK && idle(ctl));
  await rpc(wmPid, K.OP.FS_CLOSE, { fd: ctlFd });
  f = await readEvent(wm);                               // subscriber saw the ctl move
  check('subscriber got the wmctl move, and ONLY that',
    f.type === WMP.EV_MOVED && f.g(1) === 30 && idle(wm));

  // ---- WM crash: fallback intact, respawn works ----
  await rpc(wmPid, K.OP.FS_CLOSE, { fd: wmFd });
  await tick();
  kernel.wmMove(c1.sid, 55, 66);                         // emits into the void: no crash
  // The 0023 clamp with NO WM connected — the fallback the kernel-side
  // clamp exists for: a shrink still leaves every title bar reachable.
  kernel.wmSetScreen(80, 60);
  const noWm = kernel.wmList().find(s => s.sid === c1.sid);
  check('clamp works with no WM connected (title bar reachable)',
    noWm.x === 40 && noWm.y === 52, JSON.stringify(noWm));
  kernel.wmSetScreen(640, 480);          // restore for the respawn snapshot
  kernel.wmMove(c1.sid, 55, 66);
  const wsurf = kernel.wmList().find(s => s.sid === c1.sid);
  check('WM gone: kernel-chrome drag still works',
    kernel.wmPointer('down', wsurf.x + 5, wsurf.y - 5, {}) === 'drag-start');
  kernel.wmPointer('up', wsurf.x + 5, wsurf.y - 5, {});
  r = await rpc(wmPid, K.OP.SOCK_SOCKET, {});
  const wmFd2 = r.fd;
  r = await rpc(wmPid, K.OP.SOCK_CONNECT, { fd: wmFd2, path: '/run/wm.sock' });
  check('WM reconnects', !r.errno);
  const wm2 = mkConn(wmPid, wmFd2);
  f = await cmd(wm2, WMP.SUBSCRIBE);
  check('resubscribe -> R_OK with the CURRENT screen dims (todos/0023)',
    f.type === WMP.R_OK && f.g(0) === 640 && f.g(1) === 480,
    JSON.stringify([f.g(0), f.g(1)]));
  const snap = [await readEvent(wm2), await readEvent(wm2), await readEvent(wm2)];
  check('snapshot has both windows + focus',
    snap[0].type === WMP.EV_CREATED && snap[1].type === WMP.EV_CREATED &&
    snap[2].type === WMP.EV_FOCUS, JSON.stringify(snap.map(s => s.type)));

  // ---- kernel.service: the /bin/wm autostart shape — no parent, auto-reap ----
  const svcPid = await kernel.service({ path: '/bin/wm', argv: ['wm'] });
  check('service spawns parentless', svcPid > 0 && kernel.process(svcPid).ppid === 0);
  workers.get(svcPid).msg({ type: 'exited', code: 0 });
  await tick();
  check('service auto-reaped on exit (no zombie)', kernel.process(svcPid) === null);
  check('service spawn of a missing binary resolves 0',
    (await kernel.service({ path: '/bin/nope' })) === 0);

  // ---- the maximize gesture (todos/0025): a title double-click emits
  // EV_TITLE_ACTIVATE to the subscriber; the ACTIVATE command (wmctl max)
  // rides the SAME event — one policy path. The kernel keeps no maximize
  // state: policy (wm.c) answers with MOVE+RESIZE / MOVE+SET_DST. ----
  if (kernel.wmScene().focusSid !== c1.sid) {
    f = await cmd(wm2, WMP.FOCUS, [c1.sid]);
    check('focus c1 for the title clicks -> R_OK', f.type === WMP.R_OK);
    await readEvent(wm2);                                // EV_FOCUS echo
  }
  const ws = kernel.wmList().find(s => s.sid === c1.sid);
  let dact = kernel.wmPointer('down', ws.x + 8, ws.y - 6, { t: 5000 });
  check('first title down: drag-start', dact === 'drag-start', dact);
  kernel.wmPointer('up', ws.x + 8, ws.y - 6, { t: 5010 });
  f = await readEvent(wm2);                              // drag-end echo
  check('drag-end EV_MOVED echo', f.type === WMP.EV_MOVED && f.g(0) === c1.sid,
    JSON.stringify([f.type, f.g(0)]));
  check('a motionless title click emits NO snap drop (0095: a click is not a drag)',
    idle(wm2));
  dact = kernel.wmPointer('down', ws.x + 8, ws.y - 6, { t: 5200 });
  check('quick second title down: title-activate', dact === 'title-activate', dact);
  kernel.wmPointer('up', ws.x + 8, ws.y - 6, { t: 5210 });
  f = await readEvent(wm2);
  check('EV_TITLE_ACTIVATE { sid } pushed to the subscriber',
    f.type === WMP.EV_TITLE_ACTIVATE && f.g(0) === c1.sid && idle(wm2),
    JSON.stringify([f.type, f.g(0)]));
  f = await cmd(wm2, WMP.ACTIVATE, [c1.sid]);
  check('ACTIVATE -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);
  check('ACTIVATE rides the same event (wmctl max = the double-click)',
    f.type === WMP.EV_TITLE_ACTIVATE && f.g(0) === c1.sid && idle(wm2),
    JSON.stringify([f.type, f.g(0)]));
  f = await cmd(wm2, WMP.ACTIVATE, [999]);
  check('ACTIVATE bogus sid -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);
  f = await cmd(wm2, WMP.ACTIVATE, [ct.sid]);
  check('ACTIVATE on a borderless surface -> R_ERR EPERM (no title bar, no gesture)',
    f.type === WMP.R_ERR && f.g(0) === 1, JSON.stringify([f.type, f.g(0)]));

  // ---- title-bar boxes (todos/0030) with a subscriber: the max box rides
  // the SAME EV_TITLE_ACTIVATE (one policy path — box, double-click, and
  // wmctl max are indistinguishable to /bin/wm); the min box is kernel-
  // direct and echoes EV_MINIMIZED + the focus fall. ----
  const bws = kernel.wmList().find(s => s.sid === c1.sid);
  const pbxC = bws.x + bws.dstW - K.WM_CLOSE_W - K.WM_CLOSE_PAD;
  const pbxM = pbxC - K.WM_CLOSE_W - K.WM_BOX_GAP;
  const pbxN = pbxM - K.WM_CLOSE_W - K.WM_BOX_GAP;
  const pbyB = bws.y - K.WM_TITLE_H + K.WM_CLOSE_PAD;
  dact = kernel.wmPointer('down', pbxM + 8, pbyB + 8, { t: 9000 });
  check('max box click -> title-activate', dact === 'title-activate', dact);
  kernel.wmPointer('up', pbxM + 8, pbyB + 8, { t: 9010 });
  f = await readEvent(wm2);
  check('max box rides EV_TITLE_ACTIVATE to the subscriber',
    f.type === WMP.EV_TITLE_ACTIVATE && f.g(0) === c1.sid && idle(wm2),
    JSON.stringify([f.type, f.g(0)]));
  dact = kernel.wmPointer('down', pbxN + 8, pbyB + 8, { t: 9200 });
  check('min box click minimizes (kernel mechanism)', dact === 'minimize', dact);
  kernel.wmPointer('up', pbxN + 8, pbyB + 8, { t: 9210 });
  f = await readEvent(wm2);
  check('EV_MINIMIZED 1 pushed for the min box', f.type === WMP.EV_MINIMIZED &&
    f.g(0) === c1.sid && f.g(1) === 1, JSON.stringify([f.type, f.g(0), f.g(1)]));
  f = await readEvent(wm2);
  check('focus fall follows the min-box minimize', f.type === WMP.EV_FOCUS &&
    f.g(0) !== c1.sid, JSON.stringify([f.type, f.g(0)]));

  // ---- window cycling (todos/0032) with a subscriber: the chord is
  // intercepted at the wmKey seam and rides EV_CYCLE; the keyup is
  // swallowed too; Shift reverses; the CYCLE command is the same event
  // (wmctl cycle = the chord). c1 is minimized from the min-box leg —
  // restore it so a focused surface exists for the ring assert. ----
  f = await cmd(wm2, WMP.RESTORE, [c1.sid]);
  check('restore c1 for the cycle legs -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MINIMIZED 0
  await readEvent(wm2);                                // EV_FOCUS echo
  let kact = kernel.wmKey(true, 43, 9, 0x300, false);  // Alt+Tab down
  check('chord down intercepted', kact === 'cycle', kact);
  f = await readEvent(wm2);
  check('EV_CYCLE { +1 } pushed', f.type === WMP.EV_CYCLE && f.g(0) === 1,
    JSON.stringify([f.type, f.g(0)]));
  kact = kernel.wmKey(false, 43, 9, 0x300, false);     // keyup swallowed
  check('chord keyup swallowed (no half-chord to the app)', kact === 'cycle' &&
    drainRing(ring1).length === 0);
  kact = kernel.wmKey(true, 43, 9, 0x301, false);      // +Shift: reverse
  f = await readEvent(wm2);
  check('Shift reverses: EV_CYCLE { -1 }', kact === 'cycle' &&
    f.type === WMP.EV_CYCLE && f.g(0) === -1, JSON.stringify([f.type, f.g(0)]));
  kernel.wmKey(false, 43, 9, 0x301, false);
  f = await cmd(wm2, WMP.CYCLE, [1]);
  check('CYCLE command -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);
  check('CYCLE rides the same EV_CYCLE (wmctl cycle = the chord)',
    f.type === WMP.EV_CYCLE && f.g(0) === 1 && idle(wm2),
    JSON.stringify([f.type, f.g(0)]));
  check('plain Tab (no Alt) still reaches the app', (() => {
    kernel.wmKey(true, 43, 9, 0, false);
    kernel.wmKey(false, 43, 9, 0, false);
    const r = drainRing(ring1);
    return r.length === 2 && r[0].w[0] === 43;
  })());

  // ---- the Start chord (todos/0078): Esc with Ctrl held rides EV_MENU
  // under the exact EV_CYCLE rules — subscriber-gated, keyup swallowed,
  // plain Esc passes through; the MENU command is the same event
  // (wmctl menu = the chord). ----
  kact = kernel.wmKey(true, 41, 27, 0xC0, false);      // Ctrl+Esc down
  check('start chord down intercepted', kact === 'menu', kact);
  f = await readEvent(wm2);
  check('EV_MENU pushed', f.type === WMP.EV_MENU, f.type);
  kact = kernel.wmKey(false, 41, 27, 0xC0, false);     // keyup swallowed
  check('start chord keyup swallowed (no half-chord to the app)',
    kact === 'menu' && drainRing(ring1).length === 0);
  check('plain Esc (no Ctrl) still reaches the app', (() => {
    kernel.wmKey(true, 41, 27, 0, false);
    kernel.wmKey(false, 41, 27, 0, false);
    const r = drainRing(ring1);
    return r.length === 2 && r[0].w[0] === 41;
  })());
  f = await cmd(wm2, WMP.MENU, []);
  check('MENU command -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);
  check('MENU rides the same EV_MENU (wmctl menu = the chord)',
    f.type === WMP.EV_MENU && idle(wm2), f.type);

  // ---- the window system menu (todos/0102): Space with Alt held rides
  // EV_SYSMENU under the exact EV_CYCLE rules — subscriber-gated, keyup
  // swallowed, plain Space passes through; the event carries the FOCUSED
  // sid (policy raises the menu on it); the SYSMENU command is the same
  // event (wmctl sysmenu = the chord). ----
  const fsid = kernel.wmScene().focusSid;
  kact = kernel.wmKey(true, 44, 32, 0x300, false);     // Alt+Space down
  check('Alt+Space intercepted', kact === 'sysmenu', kact);
  f = await readEvent(wm2);
  check('EV_SYSMENU carries the focused sid',
    f.type === WMP.EV_SYSMENU && f.g(0) === fsid,
    JSON.stringify([f.type, f.g(0), fsid]));
  kact = kernel.wmKey(false, 44, 32, 0x300, false);    // keyup swallowed
  check('sysmenu chord keyup swallowed (no half-chord to the app)',
    kact === 'sysmenu' && drainRing(ring1).length === 0);
  check('plain Space (no Alt) still reaches the app', (() => {
    kernel.wmKey(true, 44, 32, 0, false);
    kernel.wmKey(false, 44, 32, 0, false);
    const r = drainRing(ring1);
    return r.length === 2 && r[0].w[0] === 44;
  })());
  f = await cmd(wm2, WMP.SYSMENU, []);
  check('SYSMENU command -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);
  check('SYSMENU rides the same EV_SYSMENU (wmctl sysmenu = the chord)',
    f.type === WMP.EV_SYSMENU && f.g(0) === fsid && idle(wm2), f.type);

  // ---- Aero Snap (todos/0095): mid-drag edge zones ride EV_SNAP_EDGE
  // (enter/leave/corners), the release rides EV_SNAP_DROP { sid, edge,
  // preX, preY } AFTER its EV_MOVED, the Win+arrow chord rides EV_SNAP_KEY
  // under the EV_CYCLE rules, and the SNAP command is the same event
  // (wmctl snap = the chord). Mechanism only: the kernel commits no
  // geometry — policy (wm.c) answers with MOVE/RESIZE/SET_DST. ----
  f = await cmd(wm2, WMP.MOVE, [c1.sid, 200, 200]);
  check('park c1 mid-screen for the snap drag -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MOVED echo
  dact = kernel.wmPointer('down', 208, 194, { t: 20000 });   // grab the title
  check('snap leg: title down starts a drag', dact === 'drag-start', dact);
  kernel.wmPointer('move', 320, 200, {});              // mid-screen: no zone
  check('mid-screen motion emits no snap event', idle(wm2));
  kernel.wmPointer('move', 3, 200, {});                // the left edge zone
  f = await readEvent(wm2);
  check('EV_SNAP_EDGE { sid, 1 } on entering the left zone',
    f.type === WMP.EV_SNAP_EDGE && f.g(0) === c1.sid && f.g(1) === 1,
    JSON.stringify([f.type, f.g(0), f.g(1)]));
  kernel.wmPointer('move', 5, 210, {});                // still inside: silent
  check('no re-emit while the zone is unchanged', idle(wm2));
  kernel.wmPointer('move', 320, 240, {});              // back out
  f = await readEvent(wm2);
  check('EV_SNAP_EDGE { sid, 0 } on leaving the zone',
    f.type === WMP.EV_SNAP_EDGE && f.g(1) === 0, JSON.stringify([f.type, f.g(1)]));
  kernel.wmPointer('move', 636, 4, {});                // the top-right corner
  f = await readEvent(wm2);
  check('corner zone reports the quarter edge (TR = 5)',
    f.type === WMP.EV_SNAP_EDGE && f.g(1) === 5, JSON.stringify([f.type, f.g(1)]));
  dact = kernel.wmPointer('up', 636, 4, {});
  check('release ends the drag', dact === 'drag-end', dact);
  f = await readEvent(wm2);
  check('the drag-end EV_MOVED comes first', f.type === WMP.EV_MOVED && f.g(0) === c1.sid,
    JSON.stringify([f.type, f.g(0)]));
  f = await readEvent(wm2);
  check('EV_SNAP_DROP { sid, edge, preX, preY } carries the zone + pre-drag spot',
    f.type === WMP.EV_SNAP_DROP && f.g(0) === c1.sid && f.g(1) === 5 &&
    f.g(2) === 200 && f.g(3) === 200 && idle(wm2),
    JSON.stringify([f.type, f.g(0), f.g(1), f.g(2), f.g(3)]));
  check('the kernel committed no geometry itself (mechanism only)',
    kernel.wmList().find(s => s.sid === c1.sid).w === 100);
  // A plain drop (no zone): EV_SNAP_DROP { sid, 0 } — the drag-off signal.
  const sw1 = kernel.wmList().find(s => s.sid === c1.sid);
  dact = kernel.wmPointer('down', sw1.x + 20, sw1.y - 6, { t: 30000 });
  check('second snap drag starts', dact === 'drag-start', dact);
  kernel.wmPointer('move', 300, 300, {});
  kernel.wmPointer('up', 300, 300, {});
  await readEvent(wm2);                                // EV_MOVED
  f = await readEvent(wm2);
  check('plain drop rides EV_SNAP_DROP { sid, 0 }',
    f.type === WMP.EV_SNAP_DROP && f.g(0) === c1.sid && f.g(1) === 0 && idle(wm2),
    JSON.stringify([f.type, f.g(1)]));
  // The chord: GUI+arrow (either GUI bit), keyup swallowed, plain arrows
  // pass through — the EV_CYCLE rules exactly.
  kact = kernel.wmKey(true, 80, 1073741904, 0x400, false);   // LGUI+Left
  check('Win+Left intercepted', kact === 'snap', kact);
  f = await readEvent(wm2);
  check('EV_SNAP_KEY { 0 } for Left', f.type === WMP.EV_SNAP_KEY && f.g(0) === 0,
    JSON.stringify([f.type, f.g(0)]));
  kact = kernel.wmKey(false, 80, 1073741904, 0x400, false);
  check('snap chord keyup swallowed (no half-chord to the app)',
    kact === 'snap' && drainRing(ring1).length === 0);
  kernel.wmKey(true, 79, 0, 0x800, false);             // RGUI+Right
  f = await readEvent(wm2);
  check('RGUI works too: EV_SNAP_KEY { 1 } for Right',
    f.type === WMP.EV_SNAP_KEY && f.g(0) === 1, JSON.stringify([f.g(0)]));
  kernel.wmKey(false, 79, 0, 0x800, false);
  kernel.wmKey(true, 82, 0, 0x400, false);             // Up
  f = await readEvent(wm2);
  check('EV_SNAP_KEY { 2 } for Up', f.type === WMP.EV_SNAP_KEY && f.g(0) === 2);
  kernel.wmKey(false, 82, 0, 0x400, false);
  kernel.wmKey(true, 81, 0, 0x400, false);             // Down
  f = await readEvent(wm2);
  check('EV_SNAP_KEY { 3 } for Down', f.type === WMP.EV_SNAP_KEY && f.g(0) === 3);
  kernel.wmKey(false, 81, 0, 0x400, false);
  check('plain arrow (no GUI) still reaches the app', (() => {
    kernel.wmKey(true, 80, 1073741904, 0, false);
    kernel.wmKey(false, 80, 1073741904, 0, false);
    const r = drainRing(ring1);
    return r.length === 2 && r[0].w[0] === 80;
  })());
  f = await cmd(wm2, WMP.SNAP, [1]);
  check('SNAP command -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);
  check('SNAP rides the same EV_SNAP_KEY (wmctl snap = the chord)',
    f.type === WMP.EV_SNAP_KEY && f.g(0) === 1 && idle(wm2),
    JSON.stringify([f.type, f.g(0)]));
  // INJECT_SCREEN (todos/0095): screen coords through the full wmPointer
  // path — a complete headless title drag, chrome included.
  const iw = kernel.wmList().find(s => s.sid === c1.sid);
  f = await cmd(wm2, WMP.INJECT_SCREEN, [1, f32bits(iw.x + 8), f32bits(iw.y - 6), 1]);
  check('INJECT_SCREEN down -> R_OK', f.type === WMP.R_OK);
  f = await cmd(wm2, WMP.INJECT_SCREEN, [0, f32bits(iw.x + 58), f32bits(iw.y + 44), 1]);
  check('INJECT_SCREEN move -> R_OK', f.type === WMP.R_OK);
  f = await cmd(wm2, WMP.INJECT_SCREEN, [2, f32bits(iw.x + 58), f32bits(iw.y + 44), 1]);
  check('INJECT_SCREEN up -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);
  check('screen-injected title drag moved the window (+50,+50)',
    f.type === WMP.EV_MOVED && f.g(1) === iw.x + 50 && f.g(2) === iw.y + 50,
    JSON.stringify([f.type, f.g(1), f.g(2), iw.x, iw.y]));
  f = await readEvent(wm2);
  check('...and rode the drop event out (edge 0)',
    f.type === WMP.EV_SNAP_DROP && f.g(1) === 0 && idle(wm2),
    JSON.stringify([f.type, f.g(1)]));

  // ---- z layers (todos/0038): SET_LAYER pins furniture above (+1, the
  // taskbar) or below (-1, the desktop layer) the normal windows; EVERY
  // z-order op — create-raise, focus-raise, restack — stays within its
  // layer, so a window can never cover the bar or sink under the desktop.
  // The record's word 11 (ex-reserved) carries the layer. MUST MATCH
  // os/wm_proto.h + the kernel.js WMP block. ----
  f = await cmd(wm2, WMP.SET_LAYER, [ct.sid, 1]);
  check('SET_LAYER top -> R_OK', f.type === WMP.R_OK);
  check('the pinned taskbar jumps above the focused window',
    kernel.wmList()[kernel.wmList().length - 1].sid === ct.sid,
    JSON.stringify(kernel.wmList().map(s => [s.sid, s.title])));
  f = await cmd(wm2, WMP.LIST);
  check('record word 11 carries the layer', f.type === WMP.R_LIST && (() => {
    let bar = null, app = null;
    for (let i = 0; i < f.g(0); i++) {
      const r0 = rec(f, 4 + i * K.WMP_REC_BYTES);
      if (r0.sid === ct.sid) bar = r0.layer;
      if (r0.sid === c1.sid) app = r0.layer;
    }
    return bar === 1 && app === 0;
  })());
  // The 0038 repro class: a NEW window creates above the old top but must
  // stay below the pinned bar (create-raise cannot cross the boundary).
  const fbL = makeFb(48, 32);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbL.sab, ring: null });
  const cl = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 48, h: 32, title: 'newwin' });
  await readEvent(wm2);                                // EV_CREATED
  await readEvent(wm2);                                // EV_FOCUS
  {
    const zs = kernel.wmList();
    check('create raises to the top of the NORMAL layer only',
      zs[zs.length - 1].sid === ct.sid && zs[zs.length - 2].sid === cl.sid,
      JSON.stringify(zs.map(s => [s.sid, s.title])));
  }
  f = await cmd(wm2, WMP.RESTACK, [c1.sid, 0]);        // raise
  check('RESTACK raise stops below the pinned taskbar', f.type === WMP.R_OK &&
    kernel.wmList()[kernel.wmList().length - 1].sid === ct.sid &&
    kernel.wmList()[kernel.wmList().length - 2].sid === c1.sid,
    JSON.stringify(kernel.wmList().map(s => [s.sid, s.title])));
  f = await cmd(wm2, WMP.FOCUS, [c1.sid]);
  check('FOCUS raise stops below the pinned taskbar too', f.type === WMP.R_OK &&
    kernel.wmList()[kernel.wmList().length - 1].sid === ct.sid &&
    kernel.wmScene().focusSid === c1.sid);
  await readEvent(wm2);                                // EV_FOCUS echo
  // The WM.md repro: a window parked over the bottom strip no longer
  // covers the bar — composite and hit-test both resolve the top layer.
  // c1 (100x70, front buffer [50,60,70]) at y 430 overlaps the taskbar
  // rows (456..479); the strip pixel must stay the bar's [10,20,30].
  f = await cmd(wm2, WMP.MOVE, [c1.sid, 300, 430]);
  check('park the window over the strip -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MOVED echo
  {
    const scr = kernel.wmScreenshotScreen();
    check('composite: the strip pixel is still the taskbar (bar above)',
      String(px(scr.rgba, scr.w, 320, 460)) === '10,20,30,255' &&
      String(px(scr.rgba, scr.w, 320, 445)) === '50,60,70,255',
      JSON.stringify([px(scr.rgba, scr.w, 320, 460), px(scr.rgba, scr.w, 320, 445)]));
    const fBefore = kernel.wmScene().focusSid;
    check('hit test on the strip resolves the bar (furniture stays clickable)',
      kernel.wmPointer('down', 320, 460, {}) === 'client' &&
      kernel.wmScene().focusSid === fBefore);
    kernel.wmPointer('up', 320, 460, {});
  }
  // The mirrored problem (the desktop layer's bottom pin): a lowered
  // window must never sink UNDER a bottom-pinned surface.
  f = await cmd(wm2, WMP.SET_LAYER, [cl.sid, -1]);
  check('SET_LAYER bottom -> R_OK + bottom of z', f.type === WMP.R_OK &&
    kernel.wmList()[0].sid === cl.sid,
    JSON.stringify(kernel.wmList().map(s => [s.sid, s.title])));
  f = await cmd(wm2, WMP.RESTACK, [c1.sid, 1]);        // lower
  check('RESTACK lower stops above the bottom layer', f.type === WMP.R_OK &&
    kernel.wmList()[0].sid === cl.sid && kernel.wmList()[1].sid === c1.sid,
    JSON.stringify(kernel.wmList().map(s => [s.sid, s.title])));
  f = await cmd(wm2, WMP.FOCUS, [cl.sid]);             // focus never re-layers
  check('focusing the bottom-layer window keeps it pinned', f.type === WMP.R_OK &&
    kernel.wmList()[0].sid === cl.sid && kernel.wmScene().focusSid === cl.sid);
  await readEvent(wm2);                                // EV_FOCUS echo
  f = await cmd(wm2, WMP.SET_LAYER, [cl.sid, 0]);
  check('SET_LAYER back to normal -> R_OK', f.type === WMP.R_OK);
  f = await cmd(wm2, WMP.SET_LAYER, [999, 1]);
  check('SET_LAYER bogus sid -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);
  f = await cmd(wm2, WMP.SET_LAYER, [c1.sid, 2]);
  check('SET_LAYER out-of-range layer -> R_ERR EINVAL', f.type === WMP.R_ERR && f.g(0) === 22);

  // ---- the focus fall skips pinned furniture (todos/0039 storm find):
  // after 0038 the top of raw z is ALWAYS the +1-pinned taskbar, so a
  // top-of-z fall parked keyboard focus on the bar whenever the focused
  // window minimized or died. The fall must prefer the topmost normal-
  // layer (0) window; furniture only takes focus when no normal window
  // remains. State here: z = [cl, c1, ct(+1 bar)], focus = cl. ----
  f = await cmd(wm2, WMP.FOCUS, [c1.sid]);
  check('focus a normal window under the pinned bar', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_FOCUS echo
  f = await cmd(wm2, WMP.MINIMIZE, [c1.sid]);
  check('MINIMIZE the focused window -> R_OK', f.type === WMP.R_OK);
  f = await readEvent(wm2);                            // EV_MINIMIZED 1
  check('EV_MINIMIZED echo', f.type === WMP.EV_MINIMIZED && f.g(0) === c1.sid);
  f = await readEvent(wm2);                            // the focus fall
  check('minimize focus fall skips the pinned bar (lands on the normal window)',
    f.type === WMP.EV_FOCUS && f.g(0) === cl.sid,
    JSON.stringify([f.type, f.g(0), { bar: ct.sid, normal: cl.sid }]));
  f = await cmd(wm2, WMP.RESTORE, [c1.sid]);
  check('RESTORE -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MINIMIZED 0
  await readEvent(wm2);                                // EV_FOCUS c1
  // The destroy path takes the same fall (c1 focused; the fall precedes
  // EV_DESTROYED — kernel emit order).
  await rpc(appPid, K.OP.SURFACE_DESTROY, { sid: c1.sid });
  f = await readEvent(wm2);
  check('destroy focus fall skips the pinned bar too',
    f.type === WMP.EV_FOCUS && f.g(0) === cl.sid,
    JSON.stringify([f.type, f.g(0), { bar: ct.sid, normal: cl.sid }]));
  f = await readEvent(wm2);
  check('EV_DESTROYED follows the fall', f.type === WMP.EV_DESTROYED && f.g(0) === c1.sid);
  // Degenerate: no normal window left -> furniture takes the fall (the
  // pre-0038 behavior survives when there is nothing else to focus).
  // A fresh window pins the focus deterministically (create always
  // focuses), so this leg can't wedge on a missing echo pre-fix.
  const fbN = makeFb(32, 24);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbN.sab, ring: null });
  const cn = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 32, h: 24, title: 'lastwin' });
  await readEvent(wm2);                                // EV_CREATED
  await readEvent(wm2);                                // EV_FOCUS cn
  f = await cmd(wm2, WMP.MINIMIZE, [cl.sid]);          // unfocused: no fall
  check('MINIMIZE the unfocused normal window -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MINIMIZED 1
  f = await cmd(wm2, WMP.MINIMIZE, [cn.sid]);          // the LAST normal window
  check('MINIMIZE the last normal window -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MINIMIZED 1
  f = await readEvent(wm2);
  check('no normal window left: furniture takes the focus (degenerate fall)',
    f.type === WMP.EV_FOCUS && f.g(0) === ct.sid,
    JSON.stringify([f.type, f.g(0)]));

  // ---- map-on-placement (todos/0069): with a WM subscribed, a new surface
  // is NOT composited / hit-tested until the WM's first geometry/stacking
  // op on it lands (wm.c answers EV_CREATED with a MOVE — the map ack), so
  // the first visible frame is at the PLACED position, never the kernel
  // cascade default. Unmapped surfaces stay listed, injectable, and
  // screenshot-able (agents unaffected). Scene here: ct (the +1 bar at
  // y 456), cl + cn minimized — everything else destroyed. ----
  const fbM = makeFb(60, 40);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbM.sab, ring: null });
  const cm = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 60, h: 40, title: 'mapwin' });
  f = await readEvent(wm2);
  const rm = rec(f);                                   // cascade default x,y
  check('EV_CREATED still pushed for the unmapped surface', f.type === WMP.EV_CREATED &&
    rm.sid === cm.sid, JSON.stringify(rm));
  await readEvent(wm2);                                // EV_FOCUS echo
  present(fbM, [222, 0, 222, 255]);
  check('created UNMAPPED while a WM is subscribed',
    kernel.wmList().find(s => s.sid === cm.sid).mapped === false,
    JSON.stringify(kernel.wmList().find(s => s.sid === cm.sid)));
  {
    const scr = kernel.wmScreenshotScreen();
    check('composite skips the unmapped surface (no cascade-default flash)',
      String(px(scr.rgba, scr.w, rm.x + 5, rm.y + 5)) === '0,128,128,255',
      JSON.stringify([rm.x, rm.y, px(scr.rgba, scr.w, rm.x + 5, rm.y + 5)]));
  }
  check('hit test skips the unmapped surface',
    kernel.wmPointer('down', rm.x + 5, rm.y + 5, {}) === 'desktop');
  kernel.wmPointer('up', rm.x + 5, rm.y + 5, {});
  drainRing(ring1);              // leftovers (the strip-click leg shares ring1)
  f = await cmd(wm2, WMP.INJECT_KEY, [cm.sid, 1, 44, 32, 0]);
  {
    const injEvs = drainRing(ring1);
    check('injection works while unmapped (agents unaffected)',
      f.type === WMP.R_OK && injEvs.length === 1 &&
      injEvs[0].type === K.WMEV.KEYDOWN && injEvs[0].win === cm.sid,
      JSON.stringify([f.type, injEvs]));
  }
  f = await cmd(wm2, WMP.SHOT, [cm.sid]);
  check('single-surface SHOT works while unmapped (the app\'s own pixels)',
    f.type === WMP.R_SHOT && f.g(1) === 60 &&
    String(px(f.bytes.subarray(20), 60, 5, 5)) === '222,0,222,255',
    JSON.stringify([f.type, f.g(1)]));
  // The WM's MOVE is the map ack: the FIRST composited position is the
  // placed one.
  f = await cmd(wm2, WMP.MOVE, [cm.sid, 250, 150]);
  check('placement MOVE -> R_OK', f.type === WMP.R_OK);
  await readEvent(wm2);                                // EV_MOVED echo
  check('the WM MOVE maps the surface',
    kernel.wmList().find(s => s.sid === cm.sid).mapped === true);
  {
    const scr = kernel.wmScreenshotScreen();
    check('first composited position IS the placed position',
      String(px(scr.rgba, scr.w, 255, 155)) === '222,0,222,255',
      px(scr.rgba, scr.w, 255, 155));
  }
  check('hit test sees the mapped surface at the placed spot',
    kernel.wmPointer('down', 255, 155, {}) === 'client');
  kernel.wmPointer('up', 255, 155, {});
  drainRing(ring1);
  // Any geometry/stacking op is the ack — SET_LAYER (even a no-op one)
  // maps too.
  const fbM2 = makeFb(40, 30);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbM2.sab, ring: null });
  const cm2 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 40, h: 30, title: 'mapwin2' });
  await readEvent(wm2); await readEvent(wm2);          // EV_CREATED + EV_FOCUS
  check('second surface also starts unmapped',
    kernel.wmList().find(s => s.sid === cm2.sid).mapped === false);
  f = await cmd(wm2, WMP.SET_LAYER, [cm2.sid, 0]);
  check('SET_LAYER maps too (any geometry/stacking op is the ack)',
    f.type === WMP.R_OK &&
    kernel.wmList().find(s => s.sid === cm2.sid).mapped === true);
  // The backstop: a surface the WM never places maps anyway after
  // WM_MAP_TIMEOUT_MS — a wedged WM can't hide windows.
  const fbM3 = makeFb(40, 30);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbM3.sab, ring: null });
  const cm3 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 40, h: 30, title: 'mapwin3' });
  await readEvent(wm2); await readEvent(wm2);          // EV_CREATED + EV_FOCUS
  check('unmapped before the backstop',
    kernel.wmList().find(s => s.sid === cm3.sid).mapped === false);
  await new Promise((r) => setTimeout(r, K.WM_MAP_TIMEOUT_MS + 100));
  check('the WM_MAP_TIMEOUT_MS backstop maps a never-placed surface',
    kernel.wmList().find(s => s.sid === cm3.sid).mapped === true);
  // Borderless dispatch: foreign borderless (wm.c ignores these — owner-
  // positioned taskbar-class) maps AT CREATE; the subscriber's OWN
  // borderless furniture (the start-menu case) waits for its self-park.
  const fbB = makeFb(100, 20);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbB.sab, ring: null });
  const cb = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 100, h: 20, title: 'foreignbar', flags: 1 });
  await readEvent(wm2); await readEvent(wm2);          // EV_CREATED + EV_FOCUS
  check('foreign borderless maps at create (not the WM\'s to place)',
    kernel.wmList().find(s => s.sid === cb.sid).mapped === true);
  const fbF = makeFb(150, 100);
  workers.get(wmPid).msg({ type: 'wm-sabs', fb: fbF.sab, ring: makeRing(64).sab });
  const cf = await rpc(wmPid, K.OP.SURFACE_CREATE, { w: 150, h: 100, title: 'startmenu', flags: 1 });
  await readEvent(wm2); await readEvent(wm2);          // EV_CREATED + EV_FOCUS
  check('subscriber-owned borderless (the start-menu case) waits unmapped',
    kernel.wmList().find(s => s.sid === cf.sid).mapped === false);
  f = await cmd(wm2, WMP.MOVE, [cf.sid, 0, 380]);
  check('its self-park MOVE maps it', f.type === WMP.R_OK &&
    kernel.wmList().find(s => s.sid === cf.sid).mapped === true);
  await readEvent(wm2);                                // EV_MOVED echo
  // The last subscriber going away maps everything pending at once — a
  // dead WM can never hide windows (the kernel-chrome fallback shows the
  // full scene immediately).
  const fbM4 = makeFb(40, 30);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbM4.sab, ring: null });
  const cm4 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 40, h: 30, title: 'mapwin4' });
  await readEvent(wm2); await readEvent(wm2);          // EV_CREATED + EV_FOCUS
  check('pending unmapped before the WM dies',
    kernel.wmList().find(s => s.sid === cm4.sid).mapped === false);
  await rpc(wmPid, K.OP.FS_CLOSE, { fd: wmFd2 });
  await tick();
  check('last subscriber gone: everything pending maps at once',
    kernel.wmList().every(s => s.mapped === true),
    JSON.stringify(kernel.wmList().map(s => [s.sid, s.mapped])));

  console.log(failures ? `\ntest_wm_policy: ${failures} FAILED` : '\ntest_wm_policy: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
