#!/usr/bin/env node
// C++ ladder acceptance, headless: the clang-built C++ apps (T1: box2d-clang,
// imgui-clang; T2: etl-clang, glm-clang — CLANG-CPP-EPIC Part II channel)
// install through gucman and RUN inside gucOS:
//
//   - base purity IN-OS: the minimal image ships ZERO *-clang binaries
//   - the --clang superset repo lists all four cards (what /bin/software renders)
//   - `gucman install box2d-clang`: /opt tree, /usr/local/bin symlink,
//     /etc/menu/Demos entry; the app LAUNCHES (window "Box2D (clang)",
//     Box2D 2.4.1 banner on stdout)
//   - `gucman install imgui-clang`: same plants; the app launches ("cc2wasm
//     Dear ImGui") and its Process Inspector reads the REAL /proc — the
//     "proc scan pids=N" line with N>0 is the leg the sibling's headless
//     harness can't run (no /proc outside gucOS)
//   - `gucman install etl-clang` (T2): the ETL template-conformance battery
//     RUNS IN-OS to completion — "Success: N tests passed." with N in the
//     thousands is the Tier-2 template-instantiation proof, executed on the
//     kernel's brokered fs/tty rather than bare host.js
//   - `gucman install glm-clang` (T2): the spinning-cube app launches
//     (window "GLM (clang)", "glm_app: glm 1.0.1 ready" banner)
//   - all four remove cleanly (symlink + menu entry gone)
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

  ensureClangPackages(['box2d-clang', 'imgui-clang', 'etl-clang', 'glm-clang']);
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
    'gucman install etl-clang; echo RC3=$?',
    'gucman install glm-clang; echo RC4=$?',
    'readlink /usr/local/bin/box2d-clang',
    'readlink /usr/local/bin/imgui-clang',
    'readlink /usr/local/bin/etl-clang',
    'readlink /usr/local/bin/glm-clang',
    'readlink /etc/menu/Demos/box2d-clang',
    'readlink /etc/menu/Demos/imgui-clang',
    'readlink /etc/menu/Demos/etl-tests',   // the term-wrapper launcher, not the tty binary
    'readlink /etc/menu/Demos/glm-clang',
    'readlink /usr/local/bin/etl-tests',
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
    'echo ==etl',
    // The Tier-2 proof: the whole ETL battery runs in-OS. tail keeps the
    // transcript small; the Success line carries the total count.
    'etl-clang > /tmp/etl.log 2>&1; echo ERC=$?',
    'tail -3 /tmp/etl.log',
    'echo ==glm',
    'glm-clang > /tmp/g.log 2>&1 &',
    'wmctl wait win "GLM (clang)"',
    'kill %1',
    'wmctl wait nowin "GLM (clang)"',
    'cat /tmp/g.log',
    'echo ==remove',
    'gucman remove box2d-clang; echo RRC=$?',
    'gucman remove imgui-clang; echo RRC2=$?',
    'gucman remove etl-clang; echo RRC3=$?',
    'gucman remove glm-clang; echo RRC4=$?',
    'test ! -e /usr/local/bin/box2d-clang && echo BOX2D-GONE',
    'test ! -e /etc/menu/Demos/imgui-clang && echo IMGUI-MENU-GONE',
    'test ! -e /usr/local/bin/etl-clang && echo ETL-GONE',
    'test ! -e /etc/menu/Demos/glm-clang && echo GLM-MENU-GONE',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');

  const purity = section(out, 'purity');
  check('minimal image ships zero *-clang binaries', /^0$/m.test(purity), purity);

  const cat = section(out, 'catalog');
  check('catalog lists box2d-clang', cat.includes('box2d-clang'), cat);
  check('catalog lists imgui-clang', cat.includes('imgui-clang'), cat);
  check('catalog lists etl-clang', cat.includes('etl-clang'), cat);
  check('catalog lists glm-clang', cat.includes('glm-clang'), cat);

  const inst = section(out, 'install');
  check('box2d-clang installs (exit 0)', inst.includes('RC=0'), inst);
  check('imgui-clang installs (exit 0)', inst.includes('RC2=0'), inst);
  check('etl-clang installs (exit 0)', inst.includes('RC3=0'), inst);
  check('glm-clang installs (exit 0)', inst.includes('RC4=0'), inst);
  check('/usr/local/bin/box2d-clang -> /opt/box2d-clang/box2d-clang',
    inst.includes('/opt/box2d-clang/box2d-clang'), inst);
  check('/usr/local/bin/imgui-clang -> /opt/imgui-clang/imgui-clang',
    inst.includes('/opt/imgui-clang/imgui-clang'), inst);
  check('/usr/local/bin/etl-clang -> /opt/etl-clang/etl-clang',
    inst.includes('/opt/etl-clang/etl-clang'), inst);
  check('/usr/local/bin/glm-clang -> /opt/glm-clang/glm-clang',
    inst.includes('/opt/glm-clang/glm-clang'), inst);
  check('Demos menu entries planted',
    inst.includes('/usr/local/bin/box2d-clang') && inst.includes('/usr/local/bin/imgui-clang') &&
    inst.includes('/usr/local/bin/etl-tests') && inst.includes('/usr/local/bin/glm-clang'), inst);
  check('etl-tests launcher resolves into the package tree',
    inst.includes('/opt/etl-clang/etl-tests'), inst);

  const box = section(out, 'box2d');
  check('box2d-clang window appeared + app quit clean', !/timed out/.test(box), box);
  check('box2d banner names Box2D 2.4.1', box.includes('box2d_app: box2d 2.4.1 ready'), box);

  const im = section(out, 'imgui');
  check('imgui-clang window appeared + app quit clean', !/timed out/.test(im), im);
  const scan = /proc scan pids=(\d+)/.exec(im);
  check('Process Inspector read the REAL /proc (pids>0)', scan && parseInt(scan[1], 10) > 0, im);

  const etl = section(out, 'etl');
  check('etl battery exits 0 in-OS', etl.includes('ERC=0'), etl);
  const suc = /Success: (\d+) tests passed\./.exec(etl);
  check('etl battery passes with a Tier-2-scale test count (>=1000)',
    suc && parseInt(suc[1], 10) >= 1000, etl);

  const gl = section(out, 'glm');
  check('glm-clang window appeared + app quit clean', !/timed out/.test(gl), gl);
  check('glm banner names glm 1.0.1', gl.includes('glm_app: glm 1.0.1 ready'), gl);

  const rm = section(out, 'remove');
  check('all four removes exit 0',
    rm.includes('RRC=0') && rm.includes('RRC2=0') && rm.includes('RRC3=0') && rm.includes('RRC4=0'), rm);
  check('bin symlink gone after remove', rm.includes('BOX2D-GONE') && rm.includes('ETL-GONE'), rm);
  check('menu entry gone after remove', rm.includes('IMGUI-MENU-GONE') && rm.includes('GLM-MENU-GONE'), rm);

  console.log(failures ? `FAILURES: ${failures}` : 'PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
