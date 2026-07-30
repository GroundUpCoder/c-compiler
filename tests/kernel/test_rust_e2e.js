#!/usr/bin/env node
// todos/0413 + todos/0414 acceptance: Rust binaries run in gucOS, and
// gucos-sys is the ONE Rust binding to the "c" ABI.
//
// The binaries are built OUT of this repository, in the gucos-rust sibling
// (RUST.md §3 rule 4: one producer — this repo consumes artifacts and never
// invokes rustc as part of any build). The committed artifacts of record:
//   tests/kernel/fixtures/hello-rust/hello-rust.wasm  (0413; sha256 beside it)
//   tests/kernel/fixtures/alloc-rust/alloc-rust.wasm  (0414; sha256 beside it)
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
//     4. in-OS: both fixtures are written into the root volume of a booted
//        gucOS and spawned FROM THE SHELL; stdout + $? asserted for the
//        hello, panic and alloc paths
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
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));

const RUST_ROOT = process.env.RUST_ROOT ||
  path.join(require('os').homedir(), 'git', 'gucos-rust');
const RUST_REQUIRED = process.env.RUST_REQUIRE === '1';

// fixture name → its directory; the artifact is <name>.wasm both here and
// under the sibling's out/.
const FIXTURES = {
  'hello-rust': { dir: path.join(__dirname, 'fixtures', 'hello-rust') },
  'alloc-rust': { dir: path.join(__dirname, 'fixtures', 'alloc-rust') },
};
const MSG = 'hello from rust on gucOS';

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
