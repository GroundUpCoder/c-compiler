#!/usr/bin/env node
// todos/0416 acceptance, headless: the -rust gucman channel end-to-end over
// the REAL gucos-rust sibling overlay.
//
//   - base purity IN-OS: the minimal image ships ZERO *-rust binaries, and
//     `wc-rust` is 127 before the install (the positive half rides below)
//   - the --rust superset repo lists the wc-rust card
//   - producer/consumer byte identity: the overlay's declared sha256 for
//     /usr/bin/wc-rust EQUALS the committed fixture's recorded sha256
//     (tests/kernel/fixtures/wc-rust) — the packaged tool IS the tested tool
//   - `gucman install wc-rust` on that repo: /opt tree + /usr/local/bin
//     symlink planted, and the tool RUNS — its output byte-equal to the
//     busybox wc applet on the same inputs in the same booted OS
//   - clean remove (symlink gone, 127 again)
//
// Requires the gucos-rust sibling's published overlay (out-image/
// overlay.json — `node tools/mk-overlay.mjs` there). Absent sibling/overlay
// → SKIP (exit 0): the base estate must never hard-require the Rust
// producer repo (RUST.md §3 rule 6 — unrequested absence is a normal
// state). RUST_REQUIRE=1 turns the skip into a loud failure with the fix.
//
// Run: node tests/kernel/test_rust_pkgs_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensureProducerPackages, startServer } = require('./lib/gucman.js');

const RUST_ROOT = process.env.RUST_ROOT ||
  path.join(require('os').homedir(), 'git', 'gucos-rust');
const OVERLAY = path.join(RUST_ROOT, 'out-image', 'overlay.json');
const RUST_REQUIRED = process.env.RUST_REQUIRE === '1';

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

async function main() {
  if (!fs.existsSync(OVERLAY)) {
    if (RUST_REQUIRED) {
      check('RUST_REQUIRE=1 but the gucos-rust overlay is absent', false,
        `no ${OVERLAY}\n  fix: cd ${RUST_ROOT} && ./build.sh && node tools/mk-overlay.mjs ` +
        '(or point RUST_ROOT at the sibling)');
      return;
    }
    console.log(`SKIP: no sibling overlay at ${OVERLAY} (gucos-rust not present/published)`);
    return;
  }

  // Producer/consumer identity: the overlay must publish exactly the bytes
  // the committed fixture pins (test_rust_e2e's freshness leg proves fixture
  // == a fresh build; this closes the triangle overlay == fixture).
  {
    const ov = JSON.parse(fs.readFileSync(OVERLAY, 'utf-8'));
    const declared = ov.files && ov.files['/usr/bin/wc-rust'] && ov.files['/usr/bin/wc-rust'].sha256;
    const recorded = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'wc-rust', 'wc-rust.wasm.sha256'), 'utf-8').trim().split(/\s+/)[0];
    check('overlay sha256 for /usr/bin/wc-rust equals the committed fixture sha256',
      declared === recorded, `overlay=${declared} fixture=${recorded}`);
  }

  const repo = ensureProducerPackages('rust', ['wc-rust'], RUST_ROOT);
  const MIN = ensureMinimalImage();
  const { dir, image } = freshImage('os-rustpkgs-');
  fs.copyFileSync(MIN, image);

  const port = await startServer(repo.dir);
  console.log(`[rust-pkgs] repo :${port}`);

  const script = [
    'echo ==purity',
    'ls /usr/bin | grep -c -- -rust',             // base image: ZERO *-rust
    'wc-rust /dev/null 2>/dev/null; echo PRE-RC=$?',
    'echo ==catalog',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman list --all | grep -- -rust',
    'echo ==install',
    'gucman install wc-rust; echo RC=$?',
    'readlink /usr/local/bin/wc-rust',
    // The paired-section oracle (the test_rust_e2e pattern): busybox wc is
    // the format oracle; the two sections must be byte-equal.
    'printf "alpha beta\\ngamma delta epsilon\\n" > /tmp/w.txt',
    'echo ==bb',
    'wc /tmp/w.txt',
    'cat /tmp/w.txt | wc -l',
    'wc -c /tmp/w.txt',
    'echo ==rs',
    'wc-rust /tmp/w.txt',
    'cat /tmp/w.txt | wc-rust -l',
    'wc-rust -c /tmp/w.txt',
    'echo ==remove',
    'gucman remove wc-rust; echo RRC=$?',
    'test ! -e /usr/local/bin/wc-rust && echo GONE',
    'wc-rust /dev/null 2>/dev/null; echo POST-RC=$?',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 480000 });
  const out = String(r.stdout || '');

  const purity = section(out, 'purity');
  check('minimal image ships zero *-rust binaries', /^0$/m.test(purity), purity);
  check('wc-rust is 127 BEFORE the install (the purity arm is not vacuous)',
    purity.includes('PRE-RC=127'), purity);

  const cat = section(out, 'catalog');
  check('catalog lists the wc-rust card', cat.includes('wc-rust'), cat);

  const inst = section(out, 'install');
  check('gucman install wc-rust exits 0', inst.includes('RC=0'), inst);
  check('/usr/local/bin/wc-rust -> the /opt tree', inst.includes('/opt/wc-rust/wc-rust'), inst);

  const bb = section(out, 'bb'), rs = section(out, 'rs');
  check('installed wc-rust output equals busybox wc (same booted OS, same inputs)',
    bb.length > 0 && /\d/.test(bb) && bb === rs, JSON.stringify({ bb, rs }));

  const rm = section(out, 'remove');
  check('gucman remove exits 0', rm.includes('RRC=0'), rm);
  check('the planted symlink is gone', rm.includes('GONE'), rm);
  check('wc-rust is 127 again after the remove', rm.includes('POST-RC=127'), rm);

  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(() => {
  if (failures) { console.log(`${failures} FAILURE(S)`); process.exit(1); }
  console.log('OK');
  // Explicit: the serve.js child's live pipes otherwise keep the loop alive
  // forever (the exit handler is what kills it).
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
