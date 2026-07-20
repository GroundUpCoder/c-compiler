#!/usr/bin/env node
// T1 C++ ladder acceptance, headless: the clang-built C++ apps (box2d-clang,
// imgui-clang — CLANG-CPP-EPIC Part II channel) install through gucman and RUN
// inside gucOS:
//
//   - base purity IN-OS: the minimal image ships ZERO *-clang binaries
//   - the --clang superset repo lists both cards (what /bin/software renders)
//   - `gucman install box2d-clang`: /opt tree, /usr/local/bin symlink,
//     /etc/menu/Demos entry; the app LAUNCHES (window "Box2D (clang)",
//     Box2D 2.4.1 banner on stdout)
//   - `gucman install imgui-clang`: same plants; the app launches ("cc2wasm
//     Dear ImGui") and its Process Inspector reads the REAL /proc — the
//     "proc scan pids=N" line with N>0 is the leg the sibling's headless
//     harness can't run (no /proc outside gucOS)
//   - both remove cleanly (symlink + menu entry gone)
//
// Requires the clang-simplified sibling's published overlay (out-image/
// overlay.json). Absent sibling → SKIP (exit 0): the base estate must never
// hard-require the clang toolchain repo.
//
// Run: node tests/kernel/test_clang_pkgs_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, startServer } = require('./lib/gucman.js');

const CLANG_ROOT = process.env.CLANG_ROOT ||
  path.join(require('os').homedir(), 'git', 'clang-simplified');
const OVERLAY = path.join(CLANG_ROOT, 'out-image', 'overlay.json');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* The --clang superset repo (mkpkg --clang), rebuilt in place; the base
 * pipeline's next plain mkpkg re-prunes the clang payloads — the accepted
 * thrash (CLANG-CPP-EPIC Part II §7). */
function ensureClangPackages(need) {
  const r = cp.spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet', '--clang', `--clang-root=${CLANG_ROOT}`],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
  if (r.status !== 0) throw new Error('mkpkg --clang failed');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'packages', 'index.json'), 'utf-8'));
  for (const n of need) {
    if (!idx.packages[n]) throw new Error(`mkpkg --clang produced no ${n} entry`);
  }
  return idx;
}

async function main() {
  if (!fs.existsSync(OVERLAY)) {
    console.log(`SKIP: no sibling overlay at ${OVERLAY} (clang-simplified not present/published)`);
    return;
  }

  ensureClangPackages(['box2d-clang', 'imgui-clang']);
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-clangpkgs-');
  fs.copyFileSync(MIN, image);

  const port = await startServer(path.join(ROOT, 'dist', 'packages'));
  console.log(`[clang-pkgs] repo :${port}`);

  const script = [
    'echo ==purity',
    'ls /usr/bin | grep -c -- -clang',            // base image: ZERO *-clang
    'echo ==catalog',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman list --all | grep -- -clang',
    'echo ==install',
    'gucman install box2d-clang; echo RC=$?',
    'gucman install imgui-clang; echo RC2=$?',
    'readlink /usr/local/bin/box2d-clang',
    'readlink /usr/local/bin/imgui-clang',
    'readlink /etc/menu/Demos/box2d-clang',
    'readlink /etc/menu/Demos/imgui-clang',
    'echo ==box2d',
    'box2d-clang > /tmp/b.log 2>&1 &',
    'wmctl wait win "Box2D (clang)"',
    'kill %1',
    'wmctl wait nowin "Box2D (clang)"',
    'cat /tmp/b.log',
    'echo ==imgui',
    'imgui-clang > /tmp/i.log 2>&1 &',
    'wmctl wait win "cc2wasm Dear ImGui"',
    'kill %1',
    'wmctl wait nowin "cc2wasm Dear ImGui"',
    'cat /tmp/i.log',
    'echo ==remove',
    'gucman remove box2d-clang; echo RRC=$?',
    'gucman remove imgui-clang; echo RRC2=$?',
    'test ! -e /usr/local/bin/box2d-clang && echo BOX2D-GONE',
    'test ! -e /etc/menu/Demos/imgui-clang && echo IMGUI-MENU-GONE',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');

  const purity = section(out, 'purity');
  check('minimal image ships zero *-clang binaries', /^0$/m.test(purity), purity);

  const cat = section(out, 'catalog');
  check('catalog lists box2d-clang', cat.includes('box2d-clang'), cat);
  check('catalog lists imgui-clang', cat.includes('imgui-clang'), cat);

  const inst = section(out, 'install');
  check('box2d-clang installs (exit 0)', inst.includes('RC=0'), inst);
  check('imgui-clang installs (exit 0)', inst.includes('RC2=0'), inst);
  check('/usr/local/bin/box2d-clang -> /opt/box2d-clang/box2d-clang',
    inst.includes('/opt/box2d-clang/box2d-clang'), inst);
  check('/usr/local/bin/imgui-clang -> /opt/imgui-clang/imgui-clang',
    inst.includes('/opt/imgui-clang/imgui-clang'), inst);
  check('Demos menu entries planted',
    inst.includes('/usr/local/bin/box2d-clang') && inst.includes('/usr/local/bin/imgui-clang'), inst);

  const box = section(out, 'box2d');
  check('box2d-clang window appeared + app quit clean', !/timed out/.test(box), box);
  check('box2d banner names Box2D 2.4.1', box.includes('box2d_app: box2d 2.4.1 ready'), box);

  const im = section(out, 'imgui');
  check('imgui-clang window appeared + app quit clean', !/timed out/.test(im), im);
  const scan = /proc scan pids=(\d+)/.exec(im);
  check('Process Inspector read the REAL /proc (pids>0)', scan && parseInt(scan[1], 10) > 0, im);

  const rm = section(out, 'remove');
  check('both removes exit 0', rm.includes('RRC=0') && rm.includes('RRC2=0'), rm);
  check('bin symlink gone after remove', rm.includes('BOX2D-GONE'), rm);
  check('menu entry gone after remove', rm.includes('IMGUI-MENU-GONE'), rm);

  console.log(failures ? `FAILURES: ${failures}` : 'PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
