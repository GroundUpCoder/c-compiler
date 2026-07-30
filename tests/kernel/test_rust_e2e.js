#!/usr/bin/env node
// todos/0413 + todos/0414 + todos/0415 acceptance: Rust binaries run in
// gucOS, gucos-sys is the ONE Rust binding to the "c" ABI, and a real
// -rust tool works over BlockFS.
//
// The binaries are built OUT of this repository, in the gucos-rust sibling
// (RUST.md §3 rule 4: one producer — this repo consumes artifacts and never
// invokes rustc as part of any build). The committed artifacts of record:
//   tests/kernel/fixtures/hello-rust/hello-rust.wasm  (0413; sha256 beside it)
//   tests/kernel/fixtures/alloc-rust/alloc-rust.wasm  (0414; sha256 beside it)
//   tests/kernel/fixtures/wc-rust/wc-rust.wasm        (0415; sha256 beside it)
//
// THE ONE SIBLING RESOLUTION POINT: the RUST_ROOT env var below, default
// ~/git/gucos-rust. Nothing else in this repository names the sibling path
// (the repo name is provisional — a rename is a one-line change here).
//
// Legs:
//   A (unconditional, no rustc needed — the anti-vacuous half, todos/0287):
//     1. fixture integrity: sha256(fixture) == the recorded sha256 (both)
//     2. module shape (RUST.md §2): every import is from module "c";
//        exports include main, memory AND alloca; the memory is growable
//        (both fixtures)
//     3. host contract: `node host.js hello-rust.wasm` prints the message,
//        exit 0; the panic path reports on stderr and ends via __exit
//        (exit 101, bounded by a timeout — a hanging panic handler is the
//        probe bug this contract retires); `node host.js alloc-rust.wasm`
//        prints its fixed lines through "alloc-demo: OK", exit 0 — this is
//        the 0414 allocator answer: Vec/String/Box/BTreeMap/sort/format!
//        over the libc-backed #[global_allocator], plus the interop leg
//        (Rust and C allocate INTERLEAVED on the one heap; nothing
//        corrupts)
//     4. in-OS: the fixtures are written into the root volume of a booted
//        gucOS and spawned FROM THE SHELL; stdout + $? asserted for the
//        hello, panic and alloc paths
//     4b. in-OS wc-rust (todos/0415): the tool's output is compared against
//        the busybox wc applet ON THE SAME INPUTS in the same booted OS
//        (default, -l/-w/-c, combined flags, -L/-m, multi-file total,
//        piped stdin, the "-" operand, and the missing-path stdout +
//        exit-status behaviour). Two large-input legs, one per read loop:
//        - LARGE REGULAR FILE proves the KERNEL's reassembly loop
//          (RemoteFS.read re-issues the RPC for S_IFREG — todos/0140); it
//          could pass even if the tool never handled a short read.
//        - LARGE PIPED STDIN proves the TOOL's own read loop: fd 0 on a
//          pipe is not S_IFREG, so the kernel does NOT reassemble; the
//          input is sized past the 256K pipe ring AND past KP_FS_CHUNK
//          (both derived, never hardcoded), so short reads really occur
//          and only the tool's loop-until-EOF makes the count correct.
//   B (sibling-gated — CLANG-CPP-EPIC §4 rule 2):
//     5. freshness: rebuild via <sibling>/build.sh and prove the bytes of
//        BOTH artifacts EQUAL the committed fixtures (a fixture with no
//        freshness check rots quietly and then proves nothing)
//     6. Trap 2 negative: the sibling's missing-link-attr crate (an extern
//        block WITHOUT #[link(wasm_import_module = "c")]) must FAIL AT LINK
//        with a message that NAMES the symbol — proves the build links
//        without --allow-undefined
//     7. Trap 1 negative: the sibling's no-alloca crate builds, and
//        host.js REFUSES it at start-up ("alloca is not a function"),
//        before main
//     8. 0414 negative: the sibling's absent-import crate names a "c"
//        import the host does not supply; the module must FAIL AT LOAD and
//        the message must NAME the import (loud failure, never a silent
//        stub)
//     9. 0414 single-declaration guard: no crate under <sibling>/crates/
//        other than gucos-sys contains a wasm_import_module block, and no
//        import name is declared twice inside gucos-sys (one ABI, one
//        binding)
//   Sibling absent: leg B SKIPs (the normal state) — unless RUST_REQUIRE=1,
//   which makes the absence a loud failure with the fix command (RUST.md §3
//   rule 6: an explicit ask for Rust never degrades to a silent skip).
//
// Run: node tests/kernel/test_rust_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));
// The fs bulk-transfer chunk, DERIVED from the kernel page layout — the
// 0415 large-input legs size their inputs from it, never from a literal.
const { KP_FS_CHUNK } = require(path.join(ROOT, 'kernel.js'));

const RUST_ROOT = process.env.RUST_ROOT ||
  path.join(require('os').homedir(), 'git', 'gucos-rust');
const RUST_REQUIRED = process.env.RUST_REQUIRE === '1';

// fixture name → its directory; the artifact is <name>.wasm both here and
// under the sibling's out/.
const FIXTURES = {
  'hello-rust': { dir: path.join(__dirname, 'fixtures', 'hello-rust') },
  'alloc-rust': { dir: path.join(__dirname, 'fixtures', 'alloc-rust') },
  'wc-rust': { dir: path.join(__dirname, 'fixtures', 'wc-rust') },
};
const MSG = 'hello from rust on gucOS';

// ---- the 0415 wc corpus, built once and shared by the in-OS legs ----
// wc-a deliberately carries every divergence-prone byte class of the
// busybox algorithm (locale/unicode off): tab, double space, \r\n, a
// control byte, high (non-ASCII) bytes, \f, \v, and no trailing newline.
// latin1 keeps each JS char one byte.
const WC_A = Buffer.from(
  'hello world\n' +
  '\tleading tab and  double space\n' +
  'CR line\r\n' +
  'ctrl\x01byte and caf\xc3\xa9 accent\n' +
  'form\x0cfeed and vert\x0btab\n' +
  'end without newline', 'latin1');
const WC_B = Buffer.from('one two three\nfour five\n');
// The big input: past the 256K pipe ring AND well past one KP_FS_CHUNK
// transfer, with a non-multiple tail so the last read is genuinely short.
const WC_LINE = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n';
const WC_BIG_BYTES = 5 * KP_FS_CHUNK + 12347;
const WC_BIG_LINES = Math.floor(WC_BIG_BYTES / WC_LINE.length);
const WC_BIG_TAIL = WC_BIG_BYTES - WC_BIG_LINES * WC_LINE.length;
const WC_BIG = Buffer.from(WC_LINE.repeat(WC_BIG_LINES) + 'y'.repeat(WC_BIG_TAIL));
const WC_BIG_WORDS = WC_BIG_LINES * WC_LINE.trim().split(/\s+/).length +
                     (WC_BIG_TAIL > 0 ? 1 : 0);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  const wasm = {};
  for (const name of Object.keys(FIXTURES)) {
    wasm[name] = fs.readFileSync(path.join(FIXTURES[name].dir, name + '.wasm'));
  }

  // ---- leg 1: each committed fixture matches its recorded sha256 ----
  for (const name of Object.keys(FIXTURES)) {
    const recorded = fs.readFileSync(
      path.join(FIXTURES[name].dir, name + '.wasm.sha256'), 'utf-8')
      .trim().split(/\s+/)[0];
    check(`${name}: fixture sha256 matches the recorded one`,
          sha256(wasm[name]) === recorded, `${sha256(wasm[name])} != ${recorded}`);
  }

  // ---- leg 2: module shape per RUST.md §2 (both fixtures) ----
  for (const name of Object.keys(FIXTURES)) {
    const mod = new WebAssembly.Module(wasm[name]);
    const imports = WebAssembly.Module.imports(mod);
    const exports = WebAssembly.Module.exports(mod);
    check(`${name}: every import is from module "c" (none from "env")`,
          imports.length > 0 && imports.every(i => i.module === 'c'),
          JSON.stringify(imports));
    for (const exp of ['main', 'memory', 'alloca']) {
      check(`${name}: module exports ${exp}`, exports.some(e => e.name === exp),
            JSON.stringify(exports.map(e => e.name)));
    }
    {
      // Growable memory: grow(1) throws RangeError when max == min. Stubs
      // are derived from the import list so a fixture that gains an import
      // keeps instantiating here.
      const stubs = {};
      for (const i of imports) stubs[i.name] = () => 0;
      const inst = new WebAssembly.Instance(mod, { c: stubs });
      let grew = false;
      try { inst.exports.memory.grow(1); grew = true; } catch (e) { /* not growable */ }
      check(`${name}: the memory is growable (no maximum)`, grew);
    }
  }

  // ---- leg 3: the host contract, straight through node host.js ----
  const fixPath = (name) => path.join(FIXTURES[name].dir, name + '.wasm');
  {
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), fixPath('hello-rust')],
                           { encoding: 'utf-8', timeout: 60000 });
    check('hello-rust: node host.js prints the message', String(r.stdout).includes(MSG),
          JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
    check('...and exits 0', r.status === 0, `status=${r.status}`);
  }
  {
    // The panic path must END the process (probe shipped `loop {}`, which
    // hangs — the timeout here is the guard that makes a regression loud),
    // and since 0414 it must REPORT: the gucos-sys panic handler writes the
    // panic message to stderr before __exit(101).
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), fixPath('hello-rust'), 'panic'],
                           { encoding: 'utf-8', timeout: 60000 });
    check('hello-rust: a panic ends the process via __exit (exit 101, no hang)',
          r.status === 101 && r.signal === null,
          `status=${r.status} signal=${r.signal}`);
    check('hello-rust: the panic is reported on stderr, with its message',
          String(r.stderr).includes('panic') &&
          String(r.stderr).includes('deliberate panic requested by argv[1]'),
          JSON.stringify({ stderr: r.stderr }));
  }
  {
    // The 0414 allocator answer, standalone flavor.
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), fixPath('alloc-rust')],
                           { encoding: 'utf-8', timeout: 60000 });
    const out = String(r.stdout);
    check('alloc-rust: Vec + sort work (fixed line)',
          out.includes('alloc-demo: vec len=512 sorted=true sum=16759528'), out);
    check('alloc-rust: String + format! work (fixed line)',
          out.includes('alloc-demo: string len=34 [gucOS says hello through gucos-sys]'), out);
    check('alloc-rust: Box + BTreeMap work (fixed line)',
          out.includes('alloc-demo: btree len=64 key07=49'), out);
    check('alloc-rust: the interop leg — interleaved Rust/C allocation on the ONE heap',
          out.includes('alloc-demo: interop strdups=32 len_ok=true vec_intact=true'), out);
    check('alloc-rust: verdict OK and exit 0',
          out.includes('alloc-demo: OK') && r.status === 0,
          JSON.stringify({ status: r.status, stdout: out, stderr: String(r.stderr).slice(0, 400) }));
  }

  {
    // wc-rust standalone (0415): stdin fallback + the bare single-count
    // format + the missing-path error. The standalone fs is the private
    // in-process one, so any real path is absent — exactly what the
    // error leg needs. Format equality against busybox is the in-OS
    // leg's job; these pin the standalone entry contract.
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), fixPath('wc-rust')],
                           { input: 'alpha beta\ngamma\n', encoding: 'utf-8', timeout: 60000 });
    check('wc-rust: stdin fallback counts, no name column (busybox 9-wide format)',
          String(r.stdout) === '        2         3        17\n' && r.status === 0,
          JSON.stringify({ status: r.status, stdout: r.stdout, stderr: String(r.stderr).slice(0, 400) }));
    const r2 = cp.spawnSync('node', [path.join(ROOT, 'host.js'), fixPath('wc-rust'), '-l'],
                            { input: 'a\nb\nc\n', encoding: 'utf-8', timeout: 60000 });
    check('wc-rust: single flag + stdin prints the bare count',
          String(r2.stdout) === '3\n' && r2.status === 0,
          JSON.stringify({ status: r2.status, stdout: r2.stdout }));
    const r3 = cp.spawnSync('node', [path.join(ROOT, 'host.js'), fixPath('wc-rust'), '/nope'],
                            { input: '', encoding: 'utf-8', timeout: 60000 });
    check('wc-rust: a missing path reports on stderr and exits non-zero',
          r3.status !== 0 && String(r3.stderr).includes("can't open '/nope'"),
          JSON.stringify({ status: r3.status, stdout: r3.stdout,
                           stderr: String(r3.stderr).slice(0, 400) }));
  }

  // ---- leg 4: in-OS — spawn both fixtures from the shell in a booted gucOS ----
  {
    const { dir, image } = freshImage('rust-e2e-');
    // Seed boot creates + seeds the root volume; then inject the fixtures
    // into it directly (the menubox/oomdlg pattern), then boot and spawn.
    driveBoot('echo seeded', { image });
    {
      const rootImg = image.slice(0, -4) + '-root.img';   // boot.js pairing rule
      const store = new COMMON.NodeFileStore(fs, rootImg, false);
      const rfs = BLOCK_FS.createV4(store);
      const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
      for (const name of Object.keys(FIXTURES)) {
        const fd = rfs.open(`/root/${name}.wasm`, O_WRONLY | O_CREAT | O_TRUNC, 0o755);
        if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
        rfs.write(fd, wasm[name], wasm[name].length);
        rfs.close(fd);
      }
      // The 0415 wc corpus rides the same injection.
      for (const [p, buf] of [['/root/wc-a.txt', WC_A], ['/root/wc-b.txt', WC_B],
                              ['/root/wc-big.txt', WC_BIG]]) {
        const fd = rfs.open(p, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
        if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
        rfs.write(fd, buf, buf.length);
        rfs.close(fd);
      }
      store.close();
    }
    const r = driveBoot([
      '/root/hello-rust.wasm',
      'echo rc=$?',
      '/root/hello-rust.wasm panic',
      'echo prc=$?',
      '/root/alloc-rust.wasm',
      'echo arc=$?',
    ], { image });
    const out = String(r.stdout);
    check('in-OS: the shell-spawned hello prints the message', out.includes(MSG),
          JSON.stringify({ stdout: out, stderr: String(r.stderr).slice(0, 400) }));
    check('in-OS: ...and exits 0', out.includes('rc=0'), out);
    check('in-OS: the panic path exits 101 via __exit', out.includes('prc=101'), out);
    check('in-OS: the panic message is reported (fd 2, boot stdout or stderr)',
          (out + String(r.stderr)).includes('deliberate panic requested by argv[1]'),
          JSON.stringify({ stdout: out, stderr: String(r.stderr).slice(0, 600) }));
    check('in-OS: alloc-rust passes its interop leg and reports OK',
          out.includes('alloc-demo: interop strdups=32 len_ok=true vec_intact=true') &&
          out.includes('alloc-demo: OK'), out);
    check('in-OS: ...and exits 0', out.includes('arc=0'), out);

    // ---- leg 4b (0415): wc-rust vs the busybox wc applet, same booted OS,
    //      same inputs. Paired ==bbN/==rsN sections must be byte-equal; a
    //      hand-written expected string could encode the very bug the
    //      comparison exists to catch, so busybox is the format oracle and
    //      JS-derived numbers pin the big-input counts independently.
    const WCR = '/root/wc-rust.wasm';
    const w = driveBoot([
      'echo ==bb1',
      'wc /root/wc-a.txt',
      'echo ==rs1',
      `${WCR} /root/wc-a.txt`,
      'echo ==bb2',
      'wc /root/wc-a.txt /root/wc-b.txt /root/wc-big.txt',
      'echo ==rs2',
      `${WCR} /root/wc-a.txt /root/wc-b.txt /root/wc-big.txt`,
      'echo ==bb3',
      'wc -l /root/wc-a.txt',
      'wc -w /root/wc-a.txt',
      'wc -c /root/wc-a.txt',
      'wc -m /root/wc-a.txt',
      'wc -L /root/wc-a.txt',
      'wc -lw /root/wc-a.txt /root/wc-b.txt',
      'echo ==rs3',
      `${WCR} -l /root/wc-a.txt`,
      `${WCR} -w /root/wc-a.txt`,
      `${WCR} -c /root/wc-a.txt`,
      `${WCR} -m /root/wc-a.txt`,
      `${WCR} -L /root/wc-a.txt`,
      `${WCR} -lw /root/wc-a.txt /root/wc-b.txt`,
      'echo ==bb4',
      'cat /root/wc-a.txt | wc',
      'cat /root/wc-a.txt | wc -l',
      'cat /root/wc-a.txt | wc -c -',
      'echo ==rs4',
      `cat /root/wc-a.txt | ${WCR}`,
      `cat /root/wc-a.txt | ${WCR} -l`,
      `cat /root/wc-a.txt | ${WCR} -c -`,
      // Missing path: stdout (survivor line + total) must match busybox,
      // and both exit 1. Stderr goes to the boot's fd 2, so the stdout
      // sections stay clean; wc-rust's message is re-captured below.
      'echo ==bb5',
      'wc /root/wc-nope.txt /root/wc-a.txt',
      'bbrc=$?',
      'echo ==rs5',
      `${WCR} /root/wc-nope.txt /root/wc-a.txt`,
      'rsrc=$?',
      'echo ==rc5',
      'echo "bbrc=$bbrc rsrc=$rsrc"',
      // The big-input legs. bigfile proves the KERNEL loop (S_IFREG
      // reassembly); bigstdin proves the TOOL's loop (fd 0 is a pipe —
      // the kernel never reassembles it, and the input outsizes the ring).
      'echo ==bigfile',
      `${WCR} /root/wc-big.txt`,
      'echo ==bigstdin',
      `cat /root/wc-big.txt | ${WCR}`,
      'echo ==errmsg',
      `${WCR} /root/wc-nope.txt 2>/root/wc-rs.err`,
      'lonerc=$?',
      'cat /root/wc-rs.err',
      'echo "lonerc=$lonerc"',
      'echo ==end',
    ], { image });
    const wout = String(w.stdout);
    for (const n of ['1', '2', '3', '4', '5']) {
      const bb = section(wout, 'bb' + n), rs = section(wout, 'rs' + n);
      check(`wc-rust: output equals busybox wc (pair ${n})`,
            bb.length > 0 && /\d/.test(bb) && bb === rs,
            JSON.stringify({ bb, rs }));
    }
    check('wc-rust: missing path exits 1, exactly like busybox',
          section(wout, 'rc5').includes('bbrc=1 rsrc=1'), section(wout, 'rc5'));
    {
      const line = section(wout, 'bigfile').trim().split(/\s+/);
      check('wc-rust: LARGE REGULAR FILE count is exact (proves the KERNEL loop)',
            line[0] === String(WC_BIG_LINES) && line[1] === String(WC_BIG_WORDS) &&
            line[2] === String(WC_BIG_BYTES) && line[3] === '/root/wc-big.txt',
            JSON.stringify({ got: line,
                             want: [WC_BIG_LINES, WC_BIG_WORDS, WC_BIG_BYTES] }));
    }
    {
      const line = section(wout, 'bigstdin').trim().split(/\s+/);
      check('wc-rust: LARGE PIPED STDIN count is exact (proves the TOOL\'s own loop)',
            line[0] === String(WC_BIG_LINES) && line[1] === String(WC_BIG_WORDS) &&
            line[2] === String(WC_BIG_BYTES) && line.length === 3,
            JSON.stringify({ got: line,
                             want: [WC_BIG_LINES, WC_BIG_WORDS, WC_BIG_BYTES] }));
    }
    check('wc-rust: the lone missing path reports on stderr and exits 1',
          section(wout, 'errmsg').includes("wc-rust: can't open '/root/wc-nope.txt'") &&
          section(wout, 'errmsg').includes('lonerc=1'),
          section(wout, 'errmsg'));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- leg B: the sibling-gated half ----
  const buildSh = path.join(RUST_ROOT, 'build.sh');
  if (!fs.existsSync(buildSh)) {
    if (RUST_REQUIRED) {
      check('RUST_REQUIRE=1 but the gucos-rust sibling is absent', false,
            `no ${buildSh}\n  fix: restore the sibling at ${RUST_ROOT} ` +
            `(see tests/kernel/fixtures/hello-rust/README.md), or point RUST_ROOT at it`);
    } else {
      console.log(`  SKIP freshness + negative legs: no sibling at ${RUST_ROOT} ` +
                  '(normal state; set RUST_ROOT or RUST_REQUIRE=1 to demand it)');
    }
    return;
  }

  // ---- leg 5: freshness — the committed fixtures equal a fresh rebuild ----
  {
    const r = cp.spawnSync(buildSh, [], { encoding: 'utf-8', timeout: 300000 });
    check('sibling build.sh succeeds', r.status === 0,
          JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 800) }));
    if (r.status === 0) {
      for (const name of Object.keys(FIXTURES)) {
        const rebuilt = fs.readFileSync(path.join(RUST_ROOT, 'out', name + '.wasm'));
        check(`${name}: rebuilt bytes EQUAL the committed fixture (freshness)`,
              rebuilt.equals(wasm[name]),
              `rebuilt sha256=${sha256(rebuilt)} fixture=${sha256(wasm[name])}\n` +
              `  the crate changed without a fixture refresh — see ` +
              `tests/kernel/fixtures/${name}/README.md`);
      }
    }
  }

  // ---- leg 6 (Trap 2): a missing #[link(wasm_import_module = "c")] must
  //      fail AT LINK, and the message must NAME the symbol ----
  {
    const r = cp.spawnSync('cargo',
      ['build', '--release', '--target', 'wasm32-unknown-unknown'],
      { cwd: path.join(RUST_ROOT, 'tests', 'negative', 'missing-link-attr'),
        encoding: 'utf-8', timeout: 300000 });
    const err = String(r.stderr);
    check('missing link attr: the LINK fails (no --allow-undefined default)',
          r.status !== 0, `status=${r.status}`);
    check('missing link attr: the failure NAMES the symbol (write)',
          /undefined symbol[^\n]*\bwrite\b/.test(err), err.slice(0, 800));
  }

  // ---- leg 7 (Trap 1): a module with no alloca export traps at start-up ----
  {
    const dir = path.join(RUST_ROOT, 'tests', 'negative', 'no-alloca');
    const b = cp.spawnSync('cargo',
      ['build', '--quiet', '--release', '--target', 'wasm32-unknown-unknown'],
      { cwd: dir, encoding: 'utf-8', timeout: 300000 });
    check('no-alloca crate builds (the defect is at run time)', b.status === 0,
          String(b.stderr).slice(0, 800));
    if (b.status === 0) {
      const mod2 = path.join(dir, 'target', 'wasm32-unknown-unknown', 'release',
                             'no_alloca.wasm');
      const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), mod2],
                             { encoding: 'utf-8', timeout: 60000 });
      check('no alloca export: host.js traps at start-up, before main',
            r.status !== 0 &&
            String(r.stderr).includes('alloca is not a function') &&
            !String(r.stdout).includes('never reach main'),
            JSON.stringify({ status: r.status, stdout: r.stdout,
                             stderr: String(r.stderr).slice(0, 400) }));
    }
  }

  // ---- leg 8 (0414): a module naming an absent "c" import fails AT LOAD,
  //      and the message names the import ----
  {
    const dir = path.join(RUST_ROOT, 'tests', 'negative', 'absent-import');
    const b = cp.spawnSync('cargo',
      ['build', '--quiet', '--release', '--target', 'wasm32-unknown-unknown'],
      { cwd: dir, encoding: 'utf-8', timeout: 300000 });
    check('absent-import crate builds (imports need no definition at link)',
          b.status === 0, String(b.stderr).slice(0, 800));
    if (b.status === 0) {
      const mod3 = path.join(dir, 'target', 'wasm32-unknown-unknown', 'release',
                             'absent_import.wasm');
      const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), mod3],
                             { encoding: 'utf-8', timeout: 60000 });
      check('absent import: the module fails at load (never runs main)',
            r.status !== 0 && String(r.stdout).length === 0,
            JSON.stringify({ status: r.status, stdout: r.stdout }));
      check('absent import: the failure message NAMES the import',
            String(r.stderr).includes('__gucos_absent_import') &&
            String(r.stderr).includes('"c"'),
            String(r.stderr).slice(0, 400));
    }
  }

  // ---- leg 9 (0414): gucos-sys is the ONE declaration site ----
  {
    // 9a: no crate under crates/ other than gucos-sys mentions
    // wasm_import_module (tests/negative/ fixtures are defect fixtures and
    // declare their own on purpose — see the sibling README).
    const cratesDir = path.join(RUST_ROOT, 'crates');
    const offenders = [];
    for (const crate of fs.readdirSync(cratesDir)) {
      if (crate === 'gucos-sys') continue;
      const srcDir = path.join(cratesDir, crate, 'src');
      if (!fs.existsSync(srcDir)) continue;
      for (const f of fs.readdirSync(srcDir)) {
        if (!f.endsWith('.rs')) continue;
        const text = fs.readFileSync(path.join(srcDir, f), 'utf-8');
        if (text.includes('wasm_import_module')) offenders.push(`${crate}/src/${f}`);
      }
    }
    check('one binding: no program crate declares a host import',
          offenders.length === 0, JSON.stringify(offenders));

    // 9b: inside gucos-sys, every import name is declared exactly once.
    // Only the attributed blocks count — the libc.rs link-time block is
    // exempt by construction (it deliberately has no attribute).
    const sysDir = path.join(cratesDir, 'gucos-sys', 'src');
    const seen = new Map();  // name -> file
    const dups = [];
    for (const f of fs.readdirSync(sysDir)) {
      if (!f.endsWith('.rs')) continue;
      const text = fs.readFileSync(path.join(sysDir, f), 'utf-8');
      const re = /#\[link\(wasm_import_module = "c"\)\]\s*extern "C" \{([\s\S]*?)\n\}/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        for (const fm of m[1].matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
          if (seen.has(fm[1])) dups.push(`${fm[1]} (${seen.get(fm[1])} and ${f})`);
          else seen.set(fm[1], f);
        }
      }
    }
    check(`one binding: no import declared twice in gucos-sys (${seen.size} imports)`,
          seen.size > 0 && dups.length === 0, JSON.stringify(dups));
  }
}

main().then(() => {
  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('OK');
}).catch((e) => { console.error(e); process.exit(1); });
