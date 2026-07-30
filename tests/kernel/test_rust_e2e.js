#!/usr/bin/env node
// todos/0413 acceptance: a #![no_std] Rust binary runs in gucOS.
//
// The binary is built OUT of this repository, in the gucos-rust sibling
// (RUST.md §3 rule 4: one producer — this repo consumes artifacts and never
// invokes rustc as part of any build). The committed artifact of record is
// tests/kernel/fixtures/hello-rust/hello-rust.wasm (sha256 beside it).
//
// THE ONE SIBLING RESOLUTION POINT: the RUST_ROOT env var below, default
// ~/git/gucos-rust. Nothing else in this repository names the sibling path
// (the repo name is provisional — a rename is a one-line change here).
//
// Legs:
//   A (unconditional, no rustc needed — the anti-vacuous half, todos/0287):
//     1. fixture integrity: sha256(fixture) == the recorded sha256
//     2. module shape (RUST.md §2): every import is from module "c";
//        exports include main, memory AND alloca; the memory is growable
//     3. host contract: `node host.js <fixture>` prints the message, exit 0;
//        `node host.js <fixture> panic` panics on purpose and the panic
//        handler ends the process via the "c" import __exit (exit 101,
//        bounded by a timeout — a hanging panic handler is the probe bug
//        this contract retires)
//     4. in-OS: the fixture is written into the root volume of a booted
//        gucOS and spawned FROM THE SHELL; stdout + $? asserted for both
//        the hello and the panic path
//   B (sibling-gated — CLANG-CPP-EPIC §4 rule 2):
//     5. freshness: rebuild via <sibling>/build.sh and prove the bytes
//        EQUAL the committed fixture (a fixture with no freshness check
//        rots quietly and then proves nothing)
//     6. Trap 2 negative: the sibling's missing-link-attr crate (an extern
//        block WITHOUT #[link(wasm_import_module = "c")]) must FAIL AT LINK
//        with a message that NAMES the symbol — proves the build links
//        without --allow-undefined
//     7. Trap 1 negative: the sibling's no-alloca crate builds, and
//        host.js REFUSES it at start-up ("alloca is not a function"),
//        before main
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
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));

const RUST_ROOT = process.env.RUST_ROOT ||
  path.join(require('os').homedir(), 'git', 'gucos-rust');
const RUST_REQUIRED = process.env.RUST_REQUIRE === '1';

const FIXDIR = path.join(__dirname, 'fixtures', 'hello-rust');
const FIXTURE = path.join(FIXDIR, 'hello-rust.wasm');
const SHAFILE = path.join(FIXDIR, 'hello-rust.wasm.sha256');
const MSG = 'hello from rust on gucOS';

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  const wasm = fs.readFileSync(FIXTURE);

  // ---- leg 1: the committed fixture matches its recorded sha256 ----
  const recorded = fs.readFileSync(SHAFILE, 'utf-8').trim().split(/\s+/)[0];
  check('fixture sha256 matches the recorded one', sha256(wasm) === recorded,
        `${sha256(wasm)} != ${recorded}`);

  // ---- leg 2: module shape per RUST.md §2 ----
  const mod = new WebAssembly.Module(wasm);
  const imports = WebAssembly.Module.imports(mod);
  const exports = WebAssembly.Module.exports(mod);
  check('every import is from module "c" (none from "env")',
        imports.length > 0 && imports.every(i => i.module === 'c'),
        JSON.stringify(imports));
  for (const name of ['main', 'memory', 'alloca']) {
    check(`module exports ${name}`, exports.some(e => e.name === name),
          JSON.stringify(exports.map(e => e.name)));
  }
  {
    // Growable memory: grow(1) throws RangeError when max == min.
    const inst = new WebAssembly.Instance(mod, {
      c: { write: () => 0, __exit: () => { throw new Error('__exit'); } },
    });
    let grew = false;
    try { inst.exports.memory.grow(1); grew = true; } catch (e) { /* not growable */ }
    check('the memory is growable (no maximum)', grew);
  }

  // ---- leg 3: the host contract, straight through node host.js ----
  {
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), FIXTURE],
                           { encoding: 'utf-8', timeout: 60000 });
    check('node host.js <fixture> prints the message', String(r.stdout).includes(MSG),
          JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
    check('...and exits 0', r.status === 0, `status=${r.status}`);
  }
  {
    // The panic path must END the process (probe shipped `loop {}`, which
    // hangs — the timeout here is the guard that makes a regression loud).
    const r = cp.spawnSync('node', [path.join(ROOT, 'host.js'), FIXTURE, 'panic'],
                           { encoding: 'utf-8', timeout: 60000 });
    check('a panic ends the process via __exit (exit 101, no hang)',
          r.status === 101 && r.signal === null,
          `status=${r.status} signal=${r.signal}`);
  }

  // ---- leg 4: in-OS — spawn the fixture from the shell in a booted gucOS ----
  {
    const { dir, image } = freshImage('rust-e2e-');
    // Seed boot creates + seeds the root volume; then inject the fixture
    // into it directly (the menubox/oomdlg pattern), then boot and spawn.
    driveBoot('echo seeded', { image });
    {
      const rootImg = image.slice(0, -4) + '-root.img';   // boot.js pairing rule
      const store = new COMMON.NodeFileStore(fs, rootImg, false);
      const rfs = BLOCK_FS.createV4(store);
      const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
      const fd = rfs.open('/root/hello-rust.wasm', O_WRONLY | O_CREAT | O_TRUNC, 0o755);
      if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
      rfs.write(fd, wasm, wasm.length);
      rfs.close(fd);
      store.close();
    }
    const r = driveBoot([
      '/root/hello-rust.wasm',
      'echo rc=$?',
      '/root/hello-rust.wasm panic',
      'echo prc=$?',
    ], { image });
    const out = String(r.stdout);
    check('in-OS: the shell-spawned fixture prints the message', out.includes(MSG),
          JSON.stringify({ stdout: out, stderr: String(r.stderr).slice(0, 400) }));
    check('in-OS: ...and exits 0', out.includes('rc=0'), out);
    check('in-OS: the panic path exits 101 via __exit', out.includes('prc=101'), out);
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

  // ---- leg 5: freshness — the committed fixture equals a fresh rebuild ----
  {
    const r = cp.spawnSync(buildSh, [], { encoding: 'utf-8', timeout: 300000 });
    check('sibling build.sh succeeds', r.status === 0,
          JSON.stringify({ status: r.status, stderr: String(r.stderr).slice(0, 800) }));
    if (r.status === 0) {
      const rebuilt = fs.readFileSync(path.join(RUST_ROOT, 'out', 'hello-rust.wasm'));
      check('rebuilt bytes EQUAL the committed fixture (freshness)',
            rebuilt.equals(wasm),
            `rebuilt sha256=${sha256(rebuilt)} fixture=${sha256(wasm)}\n` +
            '  the crate changed without a fixture refresh — see ' +
            'tests/kernel/fixtures/hello-rust/README.md');
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
}

main().then(() => {
  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('OK');
}).catch((e) => { console.error(e); process.exit(1); });
