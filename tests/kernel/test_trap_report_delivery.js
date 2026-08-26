#!/usr/bin/env node
// #759 leg: the trap report's fd-2 delivery under the KERNEL arrangement.
//
// WHY THIS EXISTS. tests/host/test_trap_backtrace.js proves delivery over a
// standalone BlockFS. Inside gucOS the process's fs is a RemoteFS and fd 2 is
// served by the kernel over an FS_WRITE RPC — a DIFFERENT code path. Until
// this leg existed that path was ARGUED FROM SOURCE, and #763 is precisely a
// case where the fd-2 seam looked fine in source and silently dropped bytes.
// An argued delivery claim is exactly the kind that turns out false.
//
// Deliberately fake-worker and deterministic (the test_kernel.js pattern): no
// wasm, no boot, no threads, so it takes NO heavy lock and can run any time.
// It pins the two halves that compose into the in-OS claim:
//
//   HALF 1 — RemoteFS.write(2, ...) takes the BROKERED path. It must NOT have
//     a console fast path and must NOT inherit BlockFS's swallow (#763): the
//     bytes have to leave the process as an FS_WRITE RPC naming fd 2.
//   HALF 2 — the kernel, receiving that RPC for a pcb whose fd 2 is a file,
//     writes the bytes into the file. That is what `./game 2> err.log`
//     resolves to.
//
// Plus the guard that keeps host.js's delivery choice correct in-OS:
//   HALF 3 — RemoteFS answers NONE of the fd-2 classifiers deliverTrapReport
//     consults, so its console/absent branches cannot fire under the kernel and
//     the write really is brokered. The classifier NAMES are derived from
//     host.js itself (and that derivation is positive-controlled), because the
//     first cut of this guard named one spelling and went stale the moment
//     #759's own counter-pass renamed it.
//
// Run: node tests/kernel/test_trap_report_delivery.js
'use strict';
const fs = require('fs');
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const HOST = require(path.resolve(__dirname, '../../host.js'));
const BLOCK_FS = HOST.BLOCK_FS;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '\n         ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

const O_WRONLY = 0x1, O_CREAT = 0x40, O_TRUNC = 0x200, O_RDONLY = 0x0;

// ---- fake worker plumbing (test_kernel.js pattern) -------------------------
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

const store = new BLOCK_FS.MemoryByteStore(4 * 1024 * 1024);
const kfs = BLOCK_FS.create(store);
const consoleOut = [];
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: () => new Uint8Array([0]),
  onOutput: (pid, fd, bytes) => consoleOut.push([pid, fd, Buffer.from(bytes).toString()]),
  log: () => {},
});

function pageOf(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
async function rpc(pid, op, req) {
  const h = workers.get(pid), { i32, u8 } = pageOf(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const resp = K.readPayload(i32, u8);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
  return resp;
}

/* A KernelClient stand-in that drives the REAL kernel on this thread instead of
 * parking on Atomics.wait (which would deadlock a single-threaded test). It
 * performs exactly the steps KernelClient._finish does, minus the park — and it
 * REFUSES if the kernel did not answer synchronously, so a deferred/parked RPC
 * can never be mistaken for a delivered one. */
function syncClient(pid) {
  const h = workers.get(pid), { i32, u8 } = pageOf(pid);
  const finish = (op) => {
    Atomics.store(i32, K.KP_RPC_OP, op);
    Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
    h.msg({ type: 'krpc' });
    if (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) {
      throw new Error('kernel did not answer op ' + op + ' synchronously — this leg ' +
                      'cannot distinguish a parked RPC from a delivered write');
    }
    const resp = K.readPayload(i32, u8);
    Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
    return resp;
  };
  const calls = [];
  return {
    calls,
    call(op, req) { calls.push({ op, req }); K.writePayload(i32, u8, req); return finish(op); },
    callRaw(op, bytes) { calls.push({ op, raw: Uint8Array.from(bytes) }); K.writeRawPayload(i32, u8, bytes); return finish(op); },
    pending() { return false; },
    getppid() { return 0; },
  };
}

function readWholeFile(p) {
  const st = kfs.stat(p);
  if (!st) return null;
  const fd = kfs.open(p, O_RDONLY);
  const b = new Uint8Array(st.size);
  kfs.read(fd, b, st.size);
  kfs.close(fd);
  return new TextDecoder().decode(b);
}

// #759 HALF 3 oracle, v2. Derives the fs methods deliverTrapReport consults.
//
// 🔴 ORDERING IS THE WHOLE FIX. v1 produced a comment/string-blanked `code`
// and then went on scanning the RAW body anyway, so the sanitiser existed and
// was bypassed. Two fail-open mutations followed from that, both reproduced:
//   * a STALE COMMENT (`/* ...fs.fdSink */`) satisfied the guard while the real
//     classifier went through a helper (`Reflect.get`) and was unguarded;
//   * a `/* } */` comment moved the brace-matched body boundary, because brace
//     matching also ran before blanking.
// A SANITISER THAT IS BYPASSED IS WORSE THAN NO SANITISER: its presence reads
// as protection, so a reviewer seeing `code` produced reasonably assumes it is
// what gets scanned.
//
// v2 blanks ONCE, up front, over the whole source, and thereafter the blanked
// text is the ONLY thing scanned — declaration search, brace matching, and
// name extraction alike. The raw text survives for exactly two purposes, both
// non-deciding: reading a bracket literal's name at an offset the blanked scan
// already accepted, and quoting context in an error message.
function deriveDispatchClassifiers(hostSrc) {
  const bad = (reason) => ({ ok: false, reason, names: [], sawWrite: false, bodyLen: 0 });
  if (typeof hostSrc !== 'string' || !hostSrc.length) return bad('host.js unreadable or empty');

  // ---- step 1: blank comments and string CONTENTS, length-preserving, ONCE,
  // over the whole source. Offsets stay aligned with hostSrc, so a span
  // accepted on the blanked text can be read back from the raw text safely.
  const blankAll = (src) => {
    const out = src.split('');
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '*') {
        const e = src.indexOf('*/', i + 2), stop = e < 0 ? n : e + 2;
        for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
        i = stop; continue;
      }
      if (c === '/' && d === '/') {
        let e = src.indexOf('\n', i); if (e < 0) e = n;
        for (let k = i; k < e; k++) out[k] = ' ';
        i = e; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        let k = i + 1;
        while (k < n && src[k] !== c) { if (src[k] === '\\') k++; k++; }
        for (let j = i + 1; j < Math.min(k, n); j++) if (out[j] !== '\n') out[j] = ' ';
        i = Math.min(k + 1, n); continue;
      }
      i++;
    }
    return out.join('');
  };
  const blanked = blankAll(hostSrc);

  // ---- step 2: locate the declaration IN THE BLANKED TEXT (so a commented-out
  // or quoted declaration cannot be found), with an EXACT name boundary — the
  // `\s*\(` is what stops `deliverTrapReportRenamed` matching by prefix.
  const decl = /\bfunction\s+deliverTrapReport\s*\(/g;
  const starts = [];
  for (let m; (m = decl.exec(blanked)) !== null; ) starts.push(m.index);
  if (starts.length === 0) return bad('no `function deliverTrapReport(` declaration found');
  if (starts.length > 1) return bad('several `deliverTrapReport` declarations — "the body" is ambiguous');

  // ---- step 3: brace-match IN THE BLANKED TEXT, so a brace inside a comment
  // or a string cannot move the boundary.
  const open = blanked.indexOf('{', starts[0]);
  if (open < 0) return bad('declaration found but no opening brace');
  let depth = 0, end = -1;
  for (let i = open; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return bad('unbalanced braces — body truncated or unparseable');

  // `code` is the ONLY thing scanned. `raw` is display/offset-read only and
  // never decides anything.
  const code = blanked.slice(open, end + 1);
  const raw = hostSrc.slice(open, end + 1);

  // ---- step 4: every recognised way the dispatch reaches a method on `fs`.
  const found = new Set();
  const consumed = [];
  const eat = (m) => consumed.push([m.index, m.index + m[0].length]);
  for (let m, re = /\bfs\s*\??\.\s*([A-Za-z_$][\w$]*)/g; (m = re.exec(code)) !== null; ) { eat(m); found.add(m[1]); }
  // Bracket form: the literal's CONTENT is blanked, so accept the shape on
  // `code` and read the name back from `raw` over the same accepted span.
  for (let m, re = /\bfs\s*\[\s*['"][^'"\n]*['"]\s*\]/g; (m = re.exec(code)) !== null; ) {
    eat(m);
    const lit = /['"]([A-Za-z_$][\w$]*)['"]/.exec(raw.slice(m.index, m.index + m[0].length));
    if (!lit) return bad('bracket access on `fs` with a non-identifier literal key');
    found.add(lit[1]);
  }
  for (let m, re = /\bconst\s*\{([^}]*)\}\s*=\s*fs\b/g; (m = re.exec(code)) !== null; ) {
    eat(m);
    for (const part of m[1].split(',')) {
      const nm = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) found.add(nm);
    }
  }

  // ---- step 5: a bare `fs` is only interesting when it REACHES INTO the
  // object. `fs &&`, `typeof fs`, and `pick(fs, k)` name no method. A reach
  // this oracle cannot read (a computed key) fails LOUD.
  for (let m, re = /\bfs\b/g; (m = re.exec(code)) !== null; ) {
    const at = m.index;
    const reach = (code.slice(at + 2).match(/^\s*(\?\.|\.|\[)?/) || [])[1];
    if (!reach) continue;
    if (consumed.some(([s, e]) => at >= s && at < e)) continue;
    const ctx = raw.slice(Math.max(0, at - 45), at + 55).replace(/\s+/g, ' ');
    return bad('unreadable property access on `fs` (computed key, or a shape this ' +
               'oracle does not know) near: …' + ctx + '…');
  }

  const sawWrite = found.has('write');
  found.delete('write');
  return { ok: true, reason: null, names: [...found].sort(), sawWrite, bodyLen: code.length };
}

(async () => {
  console.log('#759 — trap-report delivery under the KERNEL (RemoteFS -> FS_WRITE) arrangement');

  // ---- HALF 3 first: the property host.js's delivery choice depends on -----
  //
  // deliverTrapReport asks the fs where fd 2 goes before writing. Under the
  // kernel the answer must be "I have no opinion", so the write is brokered
  // through FS_WRITE. If RemoteFS ever grew that classifier and answered
  // 'console', every in-OS trap report would silently reroute to the console;
  // if it answered 'absent', they would be silently DROPPED.
  //
  // 🔴 THIS GUARD IS LOAD-BEARING ON A SYMBOL NAME, and the first cut of it
  // went stale within the same ticket: #759's own counter-pass renamed
  // isConsoleFd to fdSink, and the guard went on asserting the absence of a
  // method that existed nowhere — passing while protecting nothing. An ABSENCE
  // guard gets MORE true and less useful when its subject disappears, so it
  // rots silently where a presence guard would break loudly.
  //
  // The oracle above derives the names FROM host.js so a rename cannot repeat
  // that. It is positive-controlled below, because an oracle that can return
  // "nothing found" makes "nothing wrong here" and "I looked nowhere" the same
  // green.

  // The classifier spellings the dispatch has EVER used. Historical entries
  // stay: an absence guard gets MORE true and less useful when the thing it
  // names disappears, so dropping one silently widens the hole.
  const GUARDED = ['fdSink', 'isConsoleFd'];
  // How many classifiers the CURRENT dispatch consults. A bare "non-empty"
  // check cannot tell one classifier from three, and adding a second without
  // updating this line should be a decision, not a default.
  const EXPECTED_CLASSIFIERS = 1;

  console.log('\nHALF 3. RemoteFS must not answer the fd-2 classifier at all');

  let hostSrc = '';
  try { hostSrc = fs.readFileSync(path.resolve(__dirname, '../../host.js'), 'utf8'); }
  catch (e) { hostSrc = ''; }
  const d = deriveDispatchClassifiers(hostSrc);

  // -- the instrument, positive-controlled BEFORE anything is concluded from it
  check('ORACLE: deliverTrapReport located and its body parsed',
        d.ok === true, d.reason || '(ok)');
  check('ORACLE POSITIVE CONTROL: the parse reached the fs.write delivery call',
        d.ok === true && d.sawWrite === true,
        d.ok ? 'landmark fs.write NOT found — the body was truncated or reshaped'
             : 'skipped: parse already failed');
  check('ORACLE POSITIVE CONTROL: it derived EXACTLY ' + EXPECTED_CLASSIFIERS +
        ' classifier call(s), not "some"',
        d.ok === true && d.names.length === EXPECTED_CLASSIFIERS,
        d.ok ? 'derived ' + JSON.stringify(d.names) +
               ' — an EMPTY set satisfies every claim below, so this guard would ' +
               'pass while checking nothing. If the dispatch really changed, update ' +
               'EXPECTED_CLASSIFIERS and GUARDED together.'
             : 'skipped: parse already failed');

  // -- only now, the thing the oracle exists to support
  const unguarded = (d.names || []).filter((n) => !GUARDED.includes(n));
  check('every classifier the dispatch consults is named in GUARDED',
        d.ok === true && unguarded.length === 0,
        'unguarded: ' + JSON.stringify(unguarded) +
        ' — add them to GUARDED, or this tripwire protects nothing');

  // -- the requirement itself. Null-safe: if RemoteFS itself went missing this
  //    must report ONE red leg, not throw and take the other twenty checks
  //    down with it.
  const rfsProto = (K && K.RemoteFS && K.RemoteFS.prototype) || null;
  check('RemoteFS is exported and has a prototype (leg premise)', !!rfsProto);
  const rfsOwn = rfsProto ? Object.getOwnPropertyNames(rfsProto) : [];
  for (const name of GUARDED.concat(unguarded)) {
    check('RemoteFS defines NO `' + name + '`, so the write stays brokered',
          !!rfsProto && !rfsOwn.includes(name) && typeof rfsProto[name] !== 'function',
          'if RemoteFS answers ' + name + ', in-OS trap reports reroute to the ' +
          'console (\'console\') or vanish (\'absent\')');
  }
  check('RemoteFS does define write (so there IS a brokered path to take)',
        !!rfsProto && typeof rfsProto.write === 'function');

  // ---- set up a process whose fd 2 is a FILE ------------------------------
  const pid = await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  check('booted pid 1', pid === 1, String(pid));

  const opened = await rpc(1, K.OP.FS_OPEN, { path: '/err.log', flags: O_WRONLY | O_CREAT | O_TRUNC, mode: 0o644 });
  check('opened /err.log in the process fd table', typeof opened.fd === 'number' && opened.fd >= 3,
        JSON.stringify(opened));
  // NB the kernel's FS_DUP2 names its source `fd`, not `oldfd`, and ofdOf
  // coerces with `fd | 0` — so a mis-named field silently becomes fd 0 and
  // dup2 STILL RETURNS {fd: 2}. That cost this leg a false premise on its
  // first run: fd 2 became a copy of stdin, FS_WRITE fell through to the
  // null-device arm, and the kernel reported n = count for bytes that went
  // nowhere. So the premise is verified BY READING BACK the fd's identity,
  // never by the call's success-shaped return.
  const dup = await rpc(1, K.OP.FS_DUP2, { fd: opened.fd, newfd: 2 });
  check('dup2 onto fd 2 returned success (necessary, NOT sufficient)',
        !dup.errno && dup.fd === 2, JSON.stringify(dup));
  const fd2st = await rpc(1, K.OP.FS_FSTAT, { fd: 2 });
  const fileIno = kfs.stat('/err.log').ino;
  check('READ BACK: fd 2 now really IS /err.log (same inode) — the premise',
        !fd2st.errno && fd2st.st && fd2st.st.ino === fileIno,
        'fd2 ino=' + (fd2st.st && fd2st.st.ino) + ' /err.log ino=' + fileIno +
        ' resp=' + JSON.stringify(fd2st));

  // ---- HALF 1 + HALF 2: the REAL RemoteFS.write, on fd 2 ------------------
  console.log('\nHALF 1+2. the real RemoteFS.write(2, ...) must reach the file');
  const client = syncClient(1);
  const rfs = new K.RemoteFS(client, null);
  const REPORT = 'fatal: wasm trap: memory access out of bounds\n  at depth3 fix.c:4\n';
  const bytes = new TextEncoder().encode(REPORT);
  const before = client.calls.length;
  const n = rfs.write(2, bytes, bytes.length);

  check('write reported the full byte count', n === bytes.length, 'got ' + n + ' want ' + bytes.length);
  const issued = client.calls.slice(before);
  check('it issued exactly one RPC', issued.length === 1, JSON.stringify(issued.map(c => c.op)));
  check('and that RPC is FS_WRITE — i.e. the bytes really LEFT the process',
        issued.length === 1 && issued[0].op === K.OP.FS_WRITE,
        'op=' + (issued[0] && issued[0].op) + ' want ' + K.OP.FS_WRITE);
  check('the RPC payload names fd 2 in its little-endian header',
        issued.length === 1 && !!issued[0].raw &&
        (issued[0].raw[0] | (issued[0].raw[1] << 8) | (issued[0].raw[2] << 16) | (issued[0].raw[3] << 24)) === 2,
        issued[0] && issued[0].raw ? Array.from(issued[0].raw.slice(0, 4)).join(',') : 'no raw payload');

  const landed = readWholeFile('/err.log');
  check('THE BYTES ARE IN THE FILE, byte-exact', landed === REPORT,
        'got ' + JSON.stringify(landed));
  check('and NOTHING went to the console sink (the #763 swallow did not happen)',
        consoleOut.length === 0, JSON.stringify(consoleOut));

  // ---- NEGATIVE CONTROL: the instrument can distinguish a non-delivery ----
  // Point fd 2 at a fresh file, write nothing, and confirm the reader reports
  // the absence. Without this, "the bytes are in the file" could be satisfied
  // by a reader that returns the previous file's contents.
  // ---- ACCEPTANCE CLAUSE 5, at the altitude the clause is WRITTEN AT ------
  //
  // #759 clause 5 says the exit status is unchanged: "139 / W_TERMSIG(SIG.SEGV)"
  // and the `crashed` message to the kernel is unchanged. That is an
  // EXTERNALLY OBSERVABLE statement about what a PARENT sees, and it cannot be
  // tested by asserting an internal invariant inside runModule. The host suite
  // pins the near end (runModule still rejects with the original
  // RuntimeError, which is what os/process-worker.js turns into `crashed`);
  // this is the far end.
  console.log('\nCLAUSE 5. a `crashed` child is reported to its PARENT as 139');
  const spawned = await rpc(1, K.OP.SPAWN,
    { path: '/bin/init', argv: ['child'], envp: [], cwd: '/', actions: [], flags: 0, pgid: 0 });
  const childPid = spawned.pid;
  check('spawned a child (leg premise)', typeof childPid === 'number' && childPid > 1,
        JSON.stringify(spawned));

  // Exactly what os/process-worker.js:126 and kernel.js's BOOT_SOURCE post
  // when runModule rejects — a stringified stack, the shape #759 produces.
  workers.get(childPid).msg({
    type: 'crashed',
    error: 'RuntimeError: memory access out of bounds\n    at boom (wasm://wasm/abc:wasm-function[5]:0x1a)',
  });
  const reaped = await rpc(1, K.OP.WAIT, { pid: childPid, options: 0 });
  check('the parent reaps that child', reaped.pid === childPid, JSON.stringify(reaped));
  check('and the status is W_TERMSIG(SIG.SEGV) — unchanged by the diagnostic',
        reaped.status === K.W_TERMSIG(K.SIG.SEGV),
        'got ' + reaped.status + ' want ' + K.W_TERMSIG(K.SIG.SEGV));
  check('WIFSIGNALED with SIGSEGV, i.e. the shell reports $? = 139',
        (reaped.status & 0x7f) === K.SIG.SEGV && 128 + (reaped.status & 0x7f) === 139,
        'termsig=' + (reaped.status & 0x7f));

  // NEGATIVE CONTROL for the clause: a NORMAL exit must NOT look like this, or
  // the assertion above would be satisfied by a kernel that reported SEGV for
  // everything.
  const spawned2 = await rpc(1, K.OP.SPAWN,
    { path: '/bin/init', argv: ['child2'], envp: [], cwd: '/', actions: [], flags: 0, pgid: 0 });
  workers.get(spawned2.pid).msg({ type: 'exited', code: 7 });
  const reaped2 = await rpc(1, K.OP.WAIT, { pid: spawned2.pid, options: 0 });
  check('a clean exit is NOT reported as a signal (the discriminator works)',
        (reaped2.status & 0x7f) === 0 && reaped2.status === K.W_EXITCODE(7),
        'status=' + reaped2.status);

  console.log('\nNEGATIVE CONTROL. the reader must be able to report an empty result');
  const o2 = await rpc(1, K.OP.FS_OPEN, { path: '/empty.log', flags: O_WRONLY | O_CREAT | O_TRUNC, mode: 0o644 });
  await rpc(1, K.OP.FS_DUP2, { fd: o2.fd, newfd: 2 });
  check('a file that was never written back reads as empty, not as the previous content',
        readWholeFile('/empty.log') === '', JSON.stringify(readWholeFile('/empty.log')));

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('leg crashed: ' + (e && e.stack || e)); process.exit(1); });
