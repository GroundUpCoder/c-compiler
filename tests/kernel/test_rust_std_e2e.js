#!/usr/bin/env node
// todos/0442 acceptance: std on wasip1 — host.js serves wasi_snapshot_preview1
// beside "c" by delegating to the fs method surface (BlockFS.toWasiPreview1),
// and a NORMAL Rust bin crate (upstream std, stable rustc, wasm32-wasip1)
// runs in gucOS standalone and in-OS.
//
// The binary is built OUT of this repository, in the gucos-rust sibling
// (RUST.md §3 rule 4). The committed artifact of record:
//   tests/kernel/fixtures/std-rust/std-rust.wasm  (sha256 beside it)
//
// Legs:
//   A (unconditional, no rustc needed):
//     1. fixture integrity: sha256(fixture) == the recorded sha256
//     2. module shape: imports come from EXACTLY {wasi_snapshot_preview1,
//        "c"} (two namespaces, ONE module — the 0418 coexistence
//        criterion); the "c" list is [getpid]; none of the five
//        DELIBERATELY-ABSENT preview 1 imports (sock_*, proc_raise) is
//        imported; the entry is _start with NO main export (the wasip1
//        entry, RUST.md §2); the memory is growable
//     3. shim unit legs (BlockFS + a raw WebAssembly.Memory, no wasm):
//        - the "/" preopen is a REAL fd in the fs fd table (census gap 4):
//          it occupies the lowest free slot, prestat round-trips, and a
//          "c"-side open() after the shim build gets a HIGHER fd (no
//          collision between the namespaces' fd spaces)
//        - O_DIRECTORY substrate (the todos/0400 fs half): plain O_RDONLY
//          on a directory stays EISDIR (unchanged estate behavior); with
//          O_DIRECTORY it opens, read(2) on it is EISDIR, fstat sees a
//          directory, close frees the slot
//        - poll_oneoff pure-clock (no kernel): really sleeps, returns the
//          clock event
//        - poll_oneoff fd subscription (no kernel): a pipe with bytes is
//          an immediate fd_read event carrying nbytes; an empty pipe plus
//          a clock sub times out to the clock event
//        - poll_oneoff kernel path (STUB hooks.waitMulti): the ONE request
//          carries BOTH lists — r AND w — plus ring:0 and the clock
//          timeout (census gap 2: the existing __wait wrapper drops
//          write-fd interest; this is the regression guard), a {why:1}
//          answer maps to the right subscription's event, and an EINTR
//          answer surfaces as WASI EINTR (27)
//        - the served/absent split (the 0442 arm-6 contradiction): the
//          five absent names are NOT in the namespace (a module importing
//          them fails AT INSTANTIATION naming module+symbol — proven with
//          a real one-import wasm module built by hand), and the three
//          ENOTSUP names ARE served and answer 58
//     4. standalone (node host.js --block-fs): the full deterministic
//        output (std::fs round trip, env, args, SystemTime/Instant,
//        HashMap, sleep-through-poll_oneoff), $? == 0; exit7 arm
//        propagates 7 (proc_exit); panic arm reports on stderr and ends
//        nonzero (upstream panic=abort trap semantics); the Node-fs
//        flavor refuses LOUD with the actionable message
//     5. in-OS: the fixture is injected into the root volume of a booted
//        gucOS and spawned FROM THE SHELL; full output + rc asserted for
//        the normal, exit7 and panic paths; the env crosses the shell
//   B (sibling-gated — CLANG-CPP-EPIC §4 rule 2):
//     6. freshness: rebuild via <sibling>/build.sh; out/std-rust.wasm
//        bytes EQUAL the committed fixture
//     7. the -Zbuild-std refusal: RUSTFLAGS=-Zbuild-std ./build.sh must
//        exit 1 naming the 0418 ruling BEFORE any cargo runs (leg 6 is
//        the positive control that the same script builds without it)
//   Sibling absent: leg B SKIPs (normal state) unless RUST_REQUIRE=1.
//
// Run: node tests/kernel/test_rust_std_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));

const RUST_ROOT = process.env.RUST_ROOT ||
  path.join(require('os').homedir(), 'git', 'gucos-rust');
const RUST_REQUIRED = process.env.RUST_REQUIRE === '1';

const FIXDIR = path.join(__dirname, 'fixtures', 'std-rust');
const FIX = path.join(FIXDIR, 'std-rust.wasm');

// The deliberately-ABSENT preview 1 imports (the served/absent split — the
// shim's header comment is the recorded decision; this list must match it).
const ABSENT = ['sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown',
                'proc_raise'];
// The served-but-ENOTSUP trio.
const ENOTSUP_SET = ['fd_fdstat_set_flags', 'fd_fdstat_set_rights',
                     'fd_allocate'];
const W_ENOTSUP = 58, W_EINTR = 27, W_EBADF = 8;

// Deterministic output lines the demo prints (fixtures/std-rust/README.md).
const LINES = [
  'std-demo: env STD_WHO=jku',
  'std-demo: read back 34 bytes: hello through std::fs',
  'second line',
  'std-demo: metadata len=34 is_file=true',
  'std-demo: read_dir ["f.txt"]',
  'std-demo: seek+read "through"',
  'std-demo: fs cleanup ok=true',
  'std-demo: epoch sane=true',
  'std-demo: slept50 at_least=true',
  'std-demo: hashmap len=64 k07=21',
  'std-demo: gucos-sys pid_positive=true',
  'std-demo: OK',
];

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ---- a minimal wasm module importing ONE named preview 1 function ----
// (module (import "wasi_snapshot_preview1" NAME (func)))
// Hand-encoded so the absent-import LinkError leg runs against a REAL
// instantiation, not a simulation.
function oneImportModule(name) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const modBytes = enc.encode('wasi_snapshot_preview1');
  const importEntry = [
    modBytes.length, ...modBytes, nameBytes.length, ...nameBytes,
    0x00, 0x00,                       // kind func, type index 0
  ];
  const importSec = [0x01, ...importEntry];
  const typeSec = [0x01, 0x60, 0x00, 0x00];   // one type: () -> ()
  function sec(id, body) {
    // sizes here are < 128, so one LEB byte is exact
    return [id, body.length, ...body];
  }
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sec(1, typeSec), ...sec(2, importSec),
  ]);
}

// ---- shim harness: a BlockFS + raw memory, no wasm involved ----
function makeShim(hooks) {
  const store = new BLOCK_FS.MemoryByteStore(1 << 20);
  const bfs = BLOCK_FS.createV4(store);
  const mem = new WebAssembly.Memory({ initial: 2 });
  const out = [];
  const ctx = {
    getMemory: () => mem,
    writeOut: (b) => out.push(Buffer.from(b)),
    writeErr: (b) => out.push(Buffer.from(b)),
  };
  const ns = BLOCK_FS.BlockFS.prototype.toWasiPreview1.call(bfs, ctx, {
    args: ['prog', 'a1'], env: { K: 'V' },
    hooks: hooks || null,
    procExit: (code) => { const e = new Error('exit'); e.code = code; throw e; },
  });
  return { bfs, mem, ns, out };
}
function dv(mem) { return new DataView(mem.buffer); }
// Write one 48-byte poll subscription at ptr.
function writeClockSub(mem, ptr, userdata, timeoutNs) {
  const v = dv(mem);
  v.setBigUint64(ptr, BigInt(userdata), true);
  v.setUint8(ptr + 8, 0);                       // tag clock
  v.setUint32(ptr + 16, 1, true);               // monotonic
  v.setBigUint64(ptr + 24, BigInt(timeoutNs), true);
  v.setUint16(ptr + 40, 0, true);               // relative
}
function writeFdSub(mem, ptr, userdata, tag, fd) {
  const v = dv(mem);
  v.setBigUint64(ptr, BigInt(userdata), true);
  v.setUint8(ptr + 8, tag);                     // 1 read / 2 write
  v.setInt32(ptr + 16, fd, true);
}
function readEvent(mem, ptr) {
  const v = dv(mem);
  return {
    userdata: Number(v.getBigUint64(ptr, true)),
    errno: v.getUint16(ptr + 8, true),
    type: v.getUint8(ptr + 10),
    nbytes: Number(v.getBigUint64(ptr + 16, true)),
  };
}

async function main() {
  const wasm = fs.readFileSync(FIX);

  // ---- leg 1: fixture sha256 ----
  {
    const recorded = fs.readFileSync(FIX + '.sha256', 'utf-8').trim().split(/\s+/)[0];
    check('std-rust: fixture sha256 matches the recorded one',
          sha256(wasm) === recorded, `${sha256(wasm)} != ${recorded}`);
  }

  // ---- leg 2: module shape ----
  {
    const mod = new WebAssembly.Module(wasm);
    const imports = WebAssembly.Module.imports(mod);
    const exports = WebAssembly.Module.exports(mod);
    const mods = new Set(imports.map(i => i.module));
    check('std-rust: imports come from exactly {wasi_snapshot_preview1, "c"}',
          mods.size === 2 && mods.has('wasi_snapshot_preview1') && mods.has('c'),
          JSON.stringify([...mods]));
    const cNames = imports.filter(i => i.module === 'c').map(i => i.name);
    check('std-rust: the "c" import is getpid (gucos-sys beside std)',
          cNames.length === 1 && cNames[0] === 'getpid', JSON.stringify(cNames));
    const wasiNames = imports.filter(i => i.module === 'wasi_snapshot_preview1')
      .map(i => i.name);
    check('std-rust: no deliberately-absent preview 1 name is imported',
          wasiNames.every(n => !ABSENT.includes(n)), JSON.stringify(wasiNames));
    check('std-rust: the entry is _start (wasip1), with NO main export',
          exports.some(e => e.name === '_start') && !exports.some(e => e.name === 'main'),
          JSON.stringify(exports.map(e => e.name)));
    check('std-rust: module exports memory', exports.some(e => e.name === 'memory'));
  }

  // ---- leg 3: shim unit legs ----
  {
    // 3a: the preopen is a REAL fd, lowest free slot, no "c" collision.
    const { bfs, mem, ns } = makeShim(null);
    const pre = bfs._fdTable[3];
    check('shim: the "/" preopen occupies fd 3 in the REAL fd table (dir entry)',
          !!pre && pre.dir === true && pre.path === '/', JSON.stringify(pre));
    const v = dv(mem);
    check('shim: fd_prestat_get(3) answers tag=dir len=1',
          ns.fd_prestat_get(3, 64) === 0 &&
          v.getUint8(64) === 0 && v.getUint32(68, true) === 1);
    check('shim: fd_prestat_get on an unrelated fd answers EBADF (probe stop)',
          ns.fd_prestat_get(9, 64) === W_EBADF);
    ns.fd_prestat_dir_name(3, 80, 1);
    check('shim: fd_prestat_dir_name writes "/"', new Uint8Array(mem.buffer)[80] === 47);
    const O_CREAT = 0x40, O_WRONLY = 1;
    const cfd = bfs.open('/from-c.txt', O_WRONLY | O_CREAT, 0o644);
    check('shim: a "c"-side open AFTER the shim build gets a fd above the preopen',
          typeof cfd === 'number' && cfd > 3, String(cfd));

    // 3b: O_DIRECTORY substrate (todos/0400 fs half).
    check('open(dir, O_RDONLY) without O_DIRECTORY stays EISDIR (unchanged)',
          bfs.open('/', 0, 0) === null && bfs._lastError === 'EISDIR');
    bfs.mkdir('/d1', 0o755);
    const dfd = bfs.open('/d1', 0x10000, 0);
    check('open(dir, O_DIRECTORY) opens a directory fd', typeof dfd === 'number' && dfd > 3);
    check('read(2) on a directory fd is EISDIR',
          bfs.read(dfd, new Uint8Array(4), 4) === null && bfs._lastError === 'EISDIR');
    const dst = bfs.fstat(dfd);
    check('fstat on a directory fd sees a directory',
          dst && (dst.mode & 0o170000) === 0o040000);
    check('O_DIRECTORY on a non-directory is ENOTDIR',
          bfs.open('/from-c.txt', 0x10000, 0) === null && bfs._lastError === 'ENOTDIR');
    check('O_DIRECTORY with write intent is EISDIR',
          bfs.open('/d1', 0x10000 | 1, 0) === null && bfs._lastError === 'EISDIR');
    bfs.close(dfd);
    check('closing the directory fd frees the slot', !bfs._fdTable[dfd]);

    // 3c: poll_oneoff pure-clock (no kernel) really sleeps.
    writeClockSub(mem, 256, 7, 40 * 1e6);       // 40ms
    const t0 = Date.now();
    const rc = ns.poll_oneoff(256, 512, 1, 1024);
    const took = Date.now() - t0;
    const nev = v.getUint32(1024, true);
    const ev = readEvent(mem, 512);
    check('poll_oneoff pure-clock: returns the clock event after really sleeping',
          rc === 0 && nev === 1 && ev.userdata === 7 && ev.errno === 0 &&
          ev.type === 0 && took >= 30,
          JSON.stringify({ rc, nev, ev, took }));

    // 3d: fd subscriptions over a real pipe (no kernel).
    const pfds = bfs.pipe();
    bfs.write(pfds[1], Buffer.from('abc'), 3);
    writeFdSub(mem, 256, 11, 1, pfds[0]);       // fd_read on the read end
    writeClockSub(mem, 304, 12, 500 * 1e6);
    const rc2 = ns.poll_oneoff(256, 512, 2, 1024);
    const ev2 = readEvent(mem, 512);
    check('poll_oneoff fd_read: a pipe with bytes is an IMMEDIATE event with nbytes',
          rc2 === 0 && v.getUint32(1024, true) === 1 && ev2.userdata === 11 &&
          ev2.type === 1 && ev2.nbytes === 3,
          JSON.stringify(ev2));
    bfs.read(pfds[0], new Uint8Array(3), 3);    // drain
    writeFdSub(mem, 256, 13, 1, pfds[0]);
    writeClockSub(mem, 304, 14, 30 * 1e6);      // 30ms
    const t1 = Date.now();
    const rc3 = ns.poll_oneoff(256, 512, 2, 1024);
    const ev3 = readEvent(mem, 512);
    check('poll_oneoff: an empty pipe + clock sub times out to the CLOCK event',
          rc3 === 0 && v.getUint32(1024, true) === 1 && ev3.userdata === 14 &&
          ev3.type === 0 && (Date.now() - t1) >= 20,
          JSON.stringify(ev3));

    // 3e: the served/absent split.
    check('shim: the five absent names are NOT in the namespace',
          ABSENT.every(n => !(n in ns)), JSON.stringify(Object.keys(ns).sort()));
    check('shim: the ENOTSUP trio is SERVED and answers 58',
          ENOTSUP_SET.every(n => typeof ns[n] === 'function' && ns[n](3, 0, 0, 0) === W_ENOTSUP));
    // ...and a REAL module importing an absent name fails AT INSTANTIATION
    // naming module and symbol (the loud half — free from the engine).
    for (const name of ['sock_recv', 'proc_raise']) {
      const m = new WebAssembly.Module(oneImportModule(name));
      let msg = '';
      try { new WebAssembly.Instance(m, { wasi_snapshot_preview1: ns }); }
      catch (e) { msg = String(e); }
      check(`absent import ${name}: instantiation fails naming module+symbol`,
            msg.includes('wasi_snapshot_preview1') && msg.includes(name),
            msg.slice(0, 200));
    }
  }

  // 3f: the kernel path — a STUB waitMulti proves the ONE request carries
  // BOTH fd lists (the census gap-2 regression guard) and maps answers.
  {
    const calls = [];
    let answer = { why: 1, r: [5], w: [] };
    const hooks = { waitMulti: (req) => { calls.push(req); return answer; } };
    const { mem, ns } = makeShim(hooks);
    writeFdSub(mem, 256, 21, 1, 5);             // fd_read fd 5
    writeFdSub(mem, 304, 22, 2, 6);             // fd_write fd 6
    writeClockSub(mem, 352, 23, 100 * 1e6);     // 100ms
    const rc = ns.poll_oneoff(256, 512, 3, 1024);
    const ev = readEvent(mem, 512);
    check('kernel poll: ONE waitMulti request with BOTH lists (r=[5], w=[6]) + ring 0',
          calls.length === 1 && JSON.stringify(calls[0].r) === '[5]' &&
          JSON.stringify(calls[0].w) === '[6]' && calls[0].ring === 0 &&
          typeof calls[0].timeoutMs === 'number' && calls[0].timeoutMs <= 100,
          JSON.stringify(calls));
    check('kernel poll: {why:1, r:[5]} maps to the fd_read subscription\'s event',
          rc === 0 && dv(mem).getUint32(1024, true) === 1 &&
          ev.userdata === 21 && ev.type === 1,
          JSON.stringify(ev));
    answer = { errno: 'EINTR' };
    writeFdSub(mem, 256, 24, 1, 5);
    check('kernel poll: an EINTR answer surfaces as WASI EINTR (27)',
          ns.poll_oneoff(256, 512, 1, 1024) === W_EINTR);
  }

  // ---- leg 4: standalone (node host.js --block-fs) ----
  {
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), FIX, '--block-fs', 'a1', 'a2'],
      { encoding: 'utf-8', timeout: 120000, env: { ...process.env, STD_WHO: 'jku' } });
    const out = String(r.stdout);
    check('standalone: argv crosses (args_get)',
          out.includes('std-demo: args ["a1", "a2"]'), out.slice(0, 400));
    for (const line of LINES) {
      check(`standalone: ${JSON.stringify(line)}`, out.includes(line), out);
    }
    check('standalone: stderr line lands on fd 2 only',
          String(r.stderr).includes('std-demo: stderr line') &&
          !out.includes('std-demo: stderr line'), String(r.stderr).slice(0, 200));
    check('standalone: exit 0', r.status === 0, `status=${r.status}`);

    const r7 = cp.spawnSync('node', [path.join(ROOT, 'host.js'), FIX, '--block-fs', 'exit7'],
      { encoding: 'utf-8', timeout: 120000 });
    check('standalone: std::process::exit(7) propagates through proc_exit',
          r7.status === 7, `status=${r7.status}`);

    const rp = cp.spawnSync('node', [path.join(ROOT, 'host.js'), FIX, '--block-fs', 'panic'],
      { encoding: 'utf-8', timeout: 120000 });
    check('standalone: a std panic reports its message on stderr and ends nonzero',
          rp.status !== 0 && rp.signal === null &&
          String(rp.stderr).includes('deliberate std panic requested by argv[1]'),
          JSON.stringify({ status: rp.status, stderr: String(rp.stderr).slice(0, 300) }));

    // The Node-fs flavor does not serve the namespace — loud, actionable.
    const rn = cp.spawnSync('node', [path.join(ROOT, 'host.js'), FIX],
      { encoding: 'utf-8', timeout: 120000 });
    check('standalone: the Node-fs flavor refuses LOUD with the --block-fs hint',
          rn.status !== 0 && String(rn.stderr).includes('wasi_snapshot_preview1') &&
          String(rn.stderr).includes('--block-fs'),
          String(rn.stderr).slice(0, 300));
  }

  // ---- leg 5: in-OS — spawned from the shell in a booted gucOS ----
  {
    const { dir, image } = freshImage('rust-std-e2e-');
    driveBoot('echo seeded', { image });
    {
      const rootImg = image.slice(0, -4) + '-root.img';   // boot.js pairing rule
      const store = new COMMON.NodeFileStore(fs, rootImg, false);
      const rfs = BLOCK_FS.createV4(store);
      const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
      const fd = rfs.open('/root/std-rust.wasm', O_WRONLY | O_CREAT | O_TRUNC, 0o755);
      if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
      rfs.write(fd, wasm, wasm.length);
      rfs.close(fd);
      store.close();
    }
    const r = driveBoot([
      'echo ==run',
      'STD_WHO=jku /root/std-rust.wasm a1 a2',
      'echo rc=$?',
      'echo ==exit7',
      '/root/std-rust.wasm exit7',
      'echo rc7=$?',
      'echo ==panic',
      '/root/std-rust.wasm panic',
      'echo prc=$?',
      'echo ==end',
    ], { image });
    const out = String(r.stdout);
    const run = section(out, 'run');
    check('in-OS: argv crosses the shell (args_get)',
          run.includes('std-demo: args ["a1", "a2"]'), run.slice(0, 600));
    for (const line of LINES) {
      check(`in-OS: ${JSON.stringify(line)}`, run.includes(line), run);
    }
    check('in-OS: exit 0', run.includes('rc=0'), run);
    check('in-OS: exit7 propagates', section(out, 'exit7').includes('rc7=7'),
          section(out, 'exit7'));
    const pan = section(out, 'panic');
    check('in-OS: the panic path ends nonzero (no hang)',
          /prc=(?!0\b)\d+/.test(pan), pan);
    check('in-OS: the panic message is reported (fd 2, boot stdout or stderr)',
          (out + String(r.stderr)).includes('deliberate std panic requested by argv[1]'),
          JSON.stringify({ pan, stderr: String(r.stderr).slice(0, 400) }));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- leg B: the sibling-gated half ----
  const buildSh = path.join(RUST_ROOT, 'build.sh');
  if (!fs.existsSync(buildSh)) {
    if (RUST_REQUIRED) {
      check('RUST_REQUIRE=1 but the gucos-rust sibling is absent', false,
            `no ${buildSh}\n  fix: restore the sibling at ${RUST_ROOT}, or point RUST_ROOT at it`);
    } else {
      console.log(`  SKIP freshness + refusal legs: no sibling at ${RUST_ROOT} ` +
                  '(normal state; set RUST_ROOT or RUST_REQUIRE=1 to demand it)');
    }
    return;
  }

  // ---- leg 6: freshness (also the refusal leg's positive control) ----
  {
    const r = cp.spawnSync(buildSh, [], { encoding: 'utf-8', timeout: 300000 });
    check('sibling build.sh succeeds (the refusal leg\'s positive control)',
          r.status === 0, JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 800) }));
    if (r.status === 0) {
      const rebuilt = fs.readFileSync(path.join(RUST_ROOT, 'out', 'std-rust.wasm'));
      check('std-rust: rebuilt bytes EQUAL the committed fixture (freshness)',
            rebuilt.equals(wasm),
            `rebuilt sha256=${sha256(rebuilt)} fixture=${sha256(wasm)}\n` +
            `  the crate changed without a fixture refresh — see ` +
            `tests/kernel/fixtures/std-rust/README.md`);
    }
  }

  // ---- leg 7: the -Zbuild-std refusal ----
  {
    const r = cp.spawnSync(buildSh, [], {
      encoding: 'utf-8', timeout: 60000,
      env: { ...process.env, RUSTFLAGS: '-Zbuild-std' },
    });
    check('build.sh REFUSES -Zbuild-std (exit 1, names the 0418 ruling)',
          r.status === 1 && String(r.stderr).includes('build-std') &&
          String(r.stderr).includes('0418'),
          JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 400) }));
  }
}

main().then(() => {
  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('OK');
}).catch((e) => { console.error(e); process.exit(1); });
