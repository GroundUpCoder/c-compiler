#!/usr/bin/env node
// Phase 3 tty semantics (todos/0002), no wasm: a real kernel + Tty with fake
// workers; the test is both the UI bridge (tty.input / captured echo) and
// the consumer (reads the shared ring directly). Covers the line
// discipline: canonical editing (erase/kill/EOF), echo, ICRNL, raw mode,
// ISIG control chars -> signals to the FOREGROUND pgroup only, TCSAFLUSH,
// SIGWINCH, and the termios RPCs.
//
// Run: node tests/kernel/test_tty.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, exitCb: null, terminated: false,
    postMessage() {}, onMessage(fn) { h.msg = fn; }, onExit(fn) { h.exitCb = fn; },
    terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}

const kernel = new K.Kernel({
  createWorker,
  loadImage: () => new Uint8Array([1]),
  onHalt: () => {},
  log: () => {},
});

let echoed = [];
const tty = kernel.createTty({
  cols: 80, rows: 24,
  output: (bytes) => echoed.push(Buffer.from(bytes).toString('latin1')),
});
const takeEcho = () => { const s = echoed.join(''); echoed = []; return s; };

// The test doubles as the ring consumer (what BlockFS._readStdinSab does).
const SI_AVAIL = 1, SI_READPOS = 3, SI_EOF = 4, SI_HDR = 32;
const ttyI32 = new Int32Array(tty.sab, 0, 8);
const ttyRing = new Uint8Array(tty.sab, SI_HDR, tty.sab.byteLength - SI_HDR);
function ringAvail() { return Atomics.load(ttyI32, SI_AVAIL); }
function ringTake() {
  const n = ringAvail();
  const rp = Atomics.load(ttyI32, SI_READPOS);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(ttyRing[(rp + i) % ttyRing.length]);
  Atomics.store(ttyI32, SI_READPOS, (rp + n) % ttyRing.length);
  Atomics.sub(ttyI32, SI_AVAIL, n);
  return s;
}

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
async function rpc(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const resp = K.readPayload(i32, u8);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
  return resp;
}
const pend = (pid) => Atomics.load(page(pid).i32, K.KP_SIGPEND);
const clearPend = (pid) => Atomics.store(page(pid).i32, K.KP_SIGPEND, 0);
const bit = (sig) => 1 << (sig - 1);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'] });
  check('tty attached to init', workers.get(1).procSpec.ttySab === tty.sab);
  check('boot sets fg pgroup', tty.fgPgid === 1, String(tty.fgPgid));

  // ---- canonical mode: buffering, ICRNL, echo ----
  tty.input('hi');
  check('canonical buffers until NL', ringAvail() === 0);
  check('echo of typed chars', takeEcho() === 'hi');
  tty.input('\r');                       // ICRNL: CR -> NL, commits
  check('CR commits as NL', ringTake() === 'hi\n');
  check('NL echoes CRLF (ONLCR)', takeEcho() === '\r\n');

  // ---- erase / kill editing ----
  tty.input('ab\x7f');                   // VERASE
  check('erase echoes backspace-space-backspace', takeEcho() === 'ab\b \b');
  tty.input('\r');
  check('erased char not committed', ringTake() === 'a\n');
  takeEcho();
  tty.input('junk\x15done\r');           // VKILL ^U wipes the line
  check('kill wipes the line', ringTake() === 'done\n');
  takeEcho();

  // ---- IUTF8: char-wise ERASE/KILL on multi-byte input (Unicode Phase B) ----
  check('IUTF8 defaults on', (tty.termios.iflag & 0x4000) !== 0,
    '0x' + tty.termios.iflag.toString(16));
  tty.input('aé');                       // é = 2 UTF-8 bytes (C3 A9)
  takeEcho();
  tty.input('\x7f');                     // ONE erase
  check('IUTF8 erase echoes ONE cell for a 2-byte char', takeEcho() === '\b \b');
  tty.input('\r');
  check('IUTF8 erase removed the whole char', ringTake() === 'a\n');
  takeEcho();
  tty.input('x😀');                      // U+1F600 = 4 UTF-8 bytes
  takeEcho();
  tty.input('\x7f\r');
  check('IUTF8 erase pops all 4 bytes of an astral char', ringTake() === 'x\n');
  takeEcho();
  tty.input('éé');                       // 2 chars, 4 bytes
  takeEcho();
  tty.input('\x15');                     // VKILL
  check('IUTF8 kill echoes one cell per char', takeEcho() === '\b \b\b \b');
  tty.input('\r'); ringTake(); takeEcho();

  // ---- Phase D: wcwidth-aware erase — a double-width char erases BOTH
  // its cells (terminals render CJK across 2 cells; one [BS SP BS] triple
  // per cell, per the kernel.js wcwidthCp / os/wcwidth.h twin tables) ----
  tty.input('a日');                      // U+65E5, 3 UTF-8 bytes, width 2
  takeEcho();
  tty.input('\x7f');                     // ONE erase
  check('IUTF8 erase echoes TWO cells for a double-width char',
    takeEcho() === '\b \b\b \b');
  tty.input('\r');
  check('IUTF8 wide erase removed the whole char', ringTake() === 'a\n');
  takeEcho();
  tty.input('日é');                      // wide + narrow, mixed line
  takeEcho();
  tty.input('\x15');                     // VKILL
  check('IUTF8 kill echoes width-true cells per char (1 + 2)',
    takeEcho() === '\b \b\b \b\b \b');
  tty.input('\r'); ringTake(); takeEcho();
  tty.termios.iflag &= ~0x4000;          // historical byte-wise mode
  tty.input('aé');
  takeEcho();
  tty.input('\x7f\x7f');                 // TWO erases for the 2-byte char
  check('without IUTF8 erase is byte-wise', takeEcho() === '\b \b\b \b');
  tty.input('\r');
  check('without IUTF8 both bytes gone after two erases', ringTake() === 'a\n');
  takeEcho();
  tty.termios.iflag |= 0x4000;

  // ---- VEOF: commit-without-NL, sticky EOF on empty line ----
  tty.input('ab\x04');                   // ^D commits "ab" with no newline
  check('VEOF commits partial line', ringTake() === 'ab');
  check('VEOF alone is not EOF yet', Atomics.load(ttyI32, SI_EOF) === 0);
  tty.input('\x04');                     // ^D on empty line -> EOF
  check('empty-line VEOF sets EOF', Atomics.load(ttyI32, SI_EOF) === 1);
  Atomics.store(ttyI32, SI_EOF, 0);      // reset for the rest of the test
  takeEcho();

  // ---- ISIG: ^C -> SIGINT to the fg pgroup (init has a handler) ----
  await rpc(1, K.OP.SIGDISP, { sig: 2, kind: 2 });
  tty.input('partial\x03');              // typed text then ^C
  check('^C posts SIGINT to fg', (pend(1) & bit(2)) !== 0);
  check('^C echoes caret form', takeEcho() === 'partial^C\r\n');
  tty.input('after\r');
  check('^C flushed the edit buffer', ringTake() === 'after\n');
  clearPend(1);
  takeEcho();

  // ---- #433: VINTR flushes queued COOKED type-ahead too (POSIX: INTR
  // flushes the input queue unless NOFLSH) — a completed line typed +
  // Entered while the fg app was busy must not reach its next read ----
  tty.input('queued line\r');            // completed type-ahead, unread
  check('type-ahead queued before ^C', ringAvail() === 12, String(ringAvail()));
  tty.input('\x03');
  check('^C flushes queued cooked input', ringAvail() === 0, String(ringAvail()));
  check('^C still posts SIGINT with type-ahead queued', (pend(1) & bit(2)) !== 0);
  clearPend(1);
  takeEcho();
  tty.input('fresh\r');
  check('post-^C read sees only post-^C bytes', ringTake() === 'fresh\n');
  takeEcho();

  // ---- #433: NOFLSH suppresses the flush (Linux n_tty isig semantics:
  // with NOFLSH set nothing is discarded — cooked queue AND edit buffer
  // survive; the signal itself still fires) ----
  tty.termios.lflag = (tty.termios.lflag | 0x80000000) >>> 0;   // NOFLSH
  tty.input('kept line\r');
  tty.input('part\x03');                 // ^C mid-line, NOFLSH set
  check('NOFLSH: ^C still posts SIGINT', (pend(1) & bit(2)) !== 0);
  check('NOFLSH: queued cooked input survives', ringTake() === 'kept line\n');
  tty.input('ial\r');
  check('NOFLSH: the edit buffer survives too', ringTake() === 'partial\n');
  clearPend(1);
  takeEcho();
  tty.termios.lflag = (tty.termios.lflag & ~0x80000000) >>> 0;

  // ---- foreground routing: tcsetpgrp moves the target ----
  let r = await rpc(1, K.OP.SPAWN, { path: '/bin/a', argv: ['a'], envp: null, cwd: null, actions: [], flags: 1, pgid: 0 }); // pid 2, pgid 2
  await rpc(2, K.OP.SIGDISP, { sig: 2, kind: 2 });
  r = await rpc(1, K.OP.TCSETPGRP, { pgid: 2 });
  check('tcsetpgrp accepted', !r.errno);
  r = await rpc(1, K.OP.TCGETPGRP, {});
  check('tcgetpgrp reads it back', r.pgid === 2, JSON.stringify(r));
  tty.input('\x03');
  check('^C hits new fg pgroup', (pend(2) & bit(2)) !== 0);
  check('^C spares the old fg', (pend(1) & bit(2)) === 0);
  clearPend(2);
  takeEcho();

  // ---- termios RPCs: getattr, raw mode, TCSAFLUSH ----
  r = await rpc(1, K.OP.TCGETATTR, {});
  check('getattr: canonical defaults', (r.lflag & 0x100) !== 0 && (r.lflag & 0x8) !== 0 && r.cc[8] === 3, JSON.stringify(r));
  const raw = { actions: 0, iflag: 0, oflag: r.oflag, cflag: r.cflag, lflag: 0, cc: r.cc };
  await rpc(1, K.OP.TCSETATTR, raw);
  tty.input('x\x03y\r');                 // raw: no ISIG, no ICRNL, no echo
  check('raw mode passes everything through', ringTake() === 'x\x03y\r');
  check('raw mode does not echo', takeEcho() === '');
  check('raw ^C posts nothing', (pend(2) & bit(2)) === 0);

  tty.input('pending');
  r = await rpc(1, K.OP.TCGETATTR, {});
  await rpc(1, K.OP.TCSETATTR, { actions: 2 /* TCSAFLUSH */, iflag: 0x100, oflag: r.oflag, cflag: r.cflag, lflag: 0x18E, cc: r.cc });
  check('TCSAFLUSH discards unread input', ringAvail() === 0);
  takeEcho();

  // ---- canonical -> raw mid-line: the edit buffer must become readable
  // (Linux n_tty semantics; the 0171 wedge class). Bytes typed while a
  // shell is BETWEEN reads (cooked window) go into the canonical edit
  // buffer; when the shell's line editor then switches the tty raw, those
  // bytes must flow to the reader — stranding them splits the typed line
  // (head lost, tail executed: 'echo X' arrives as 'cho X', or an
  // unbalanced quote locks the shell into PS2 continuation forever). ----
  tty.input('head ');                    // canonical, no newline: edit buffer
  r = await rpc(1, K.OP.TCGETATTR, {});
  await rpc(1, K.OP.TCSETATTR, { actions: 0, iflag: 0, oflag: r.oflag, cflag: r.cflag, lflag: 0, cc: r.cc });
  tty.input('tail\r');                   // raw tail of the same typed line
  check('canonical->raw flushes the edit buffer to the reader (no stranding)',
    ringTake() === 'head tail\r');
  // and TCSAFLUSH across the same switch still discards BOTH halves
  await rpc(1, K.OP.TCSETATTR, { actions: 0, iflag: 0x100, oflag: r.oflag, cflag: r.cflag, lflag: 0x18E, cc: r.cc });
  tty.input('doomed');                   // canonical edit buffer again
  await rpc(1, K.OP.TCSETATTR, { actions: 2 /* TCSAFLUSH */, iflag: 0, oflag: r.oflag, cflag: r.cflag, lflag: 0, cc: r.cc });
  tty.input('x');
  check('TCSAFLUSH across canonical->raw discards the edit buffer too',
    ringTake() === 'x');
  await rpc(1, K.OP.TCSETATTR, { actions: 0, iflag: 0x100, oflag: r.oflag, cflag: r.cflag, lflag: 0x18E, cc: r.cc });
  takeEcho();

  // ---- SIGWINCH on resize (fg pgroup, handler disposition) ----
  await rpc(2, K.OP.SIGDISP, { sig: 28, kind: 2 });
  tty.resize(100, 50);
  check('resize posts SIGWINCH to fg', (pend(2) & bit(28)) !== 0);
  check('winsize words updated', Atomics.load(ttyI32, 5) === 100 && Atomics.load(ttyI32, 6) === 50);
  tty.resize(100, 50);
  clearPend(2);
  check('no-op resize posts nothing', (pend(2) & bit(28)) === 0);

  console.log(failures === 0 ? '\ntty semantics: PASS' : `\ntty semantics: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
