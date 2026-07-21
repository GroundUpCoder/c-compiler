#!/usr/bin/env node
// The keys.h named-action registry + override resolution + chord parse/format
// (todos/KEYBINDING-OVERRIDE-SYSTEM.md §2/§5, CHUNK 2 policy layer). keys.h is
// SDL-header-free POSIX, so the logic is exercised DIRECTLY by a native-C probe
// (keybind_registry_probe.c) — no boot, no wasm — compiled with clang and run
// here. The probe prints ok/FAIL lines + exits with its failure count; this
// runner surfaces them and adds ONE cross-file invariant that only the JS side
// can check:
//   - the scancode twin: keys.h ks_chord_scancode() must agree with the
//     kernel's WM_DEFAULT_GRABS scancodes for the shared chords (tab/esc/space/
//     arrows), the same lockstep discipline test_keybind.js keeps for the
//     km-fold. wm.c (chunk iii) feeds ks_chord_scancode into GRAB_SET, so a
//     divergence here would silently mis-target the kernel grab table.
//
// The probe itself covers: registry defaults per scheme (windows vs macos incl
// the new macos line/doc-nav + relocated Ctrl+Alt+arrow tiling + Ctrl+Alt+E overview),
// bind.<action> override change/move/unbind, the `default` sentinel, malformed
// loud-fallback, readline-row immunity, scheme-independence, and chord
// parse/format round-trip.
//
// Run: node tests/kernel/test_keybind_registry.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const PROBE = path.join(__dirname, 'keybind_registry_probe.c');
const K = require(path.join(REPO, 'kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// ---- locate a native C compiler (clang, else cc) ----
function findCC() {
  for (const cc of ['clang', 'cc']) {
    const r = spawnSync(cc, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return cc;
  }
  return null;
}

const CC = findCC();
if (!CC) {
  // The kernel suite runs on the dev machine (clang present); a missing native
  // toolchain degrades to a visible skip, not a hard fail (the missing-
  // Playwright sweep precedent) — keys.h logic is still covered by the keymap
  // e2e's consumer legs.
  console.log('  SKIP native C probe — no clang/cc on PATH');
  console.log('\nkeybind_registry: SKIPPED (no C compiler)');
  process.exit(0);
}

// ---- compile + run the probe ----
const bin = path.join(os.tmpdir(), `kbprobe-${process.pid}`);
const cr = spawnSync(CC, ['-std=c11', '-I', REPO, PROBE, '-o', bin], { encoding: 'utf8' });
check('probe compiles (clang)', cr.status === 0, cr.stderr);
if (cr.status !== 0) {
  console.log('\nkeybind_registry: ' + failures + ' FAILED');
  process.exit(1);
}

const pr = spawnSync(bin, [], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
fs.rmSync(bin, { force: true });
process.stdout.write(pr.stdout || '');
if (pr.stderr) process.stderr.write(pr.stderr);
// The probe exits nonzero on any internal FAIL; treat that as our failure.
check('native probe: all registry/override/parse checks pass', pr.status === 0,
  'exit=' + pr.status);

// ---- the scancode twin: keys.h vs kernel.js WM_DEFAULT_GRABS ----
// Parse the probe's `SCANCODE ...` line (keys.h ks_chord_scancode outputs) and
// assert it matches the scancodes the kernel's built-in grab table uses.
const m = (pr.stdout || '').match(/SCANCODE ([^\n]+)/);
check('probe emitted the SCANCODE twin line', !!m, JSON.stringify(pr.stdout && pr.stdout.slice(0, 80)));
if (m) {
  const sc = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const [k, v] = pair.split('=');
    sc[k] = parseInt(v, 10);
  }
  // The kernel default table's scancodes (kernel.js WM_DEFAULT_GRABS): 43 Tab,
  // 41 Esc, 44 Space, 79 Right / 80 Left / 81 Down / 82 Up. Pull them back out
  // of the exported table so this stays a real twin (not a re-hardcode).
  const grabs = K.WM_DEFAULT_GRABS;
  const cyc = grabs.find((g) => g.token === K.WM_TOK_CYCLE);   // Tab
  const menu = grabs.find((g) => g.token === K.WM_TOK_MENU);   // Esc
  const sys = grabs.find((g) => g.token === K.WM_TOK_SYSMENU); // Space
  const snaps = grabs.filter((g) => g.token === K.WM_TOK_SNAP).map((g) => g.scancode);
  check('scancode twin: keys.h tab == kernel cycle-grab scancode',
    sc.tab === cyc.scancode, JSON.stringify([sc.tab, cyc.scancode]));
  check('scancode twin: keys.h esc == kernel menu-grab scancode',
    sc.esc === menu.scancode, JSON.stringify([sc.esc, menu.scancode]));
  check('scancode twin: keys.h space == kernel sysmenu-grab scancode',
    sc.space === sys.scancode, JSON.stringify([sc.space, sys.scancode]));
  // the four snap arrows are the four WM_TOK_SNAP scancodes (79-82)
  check('scancode twin: keys.h arrows == the kernel snap-grab scancodes',
    [sc.left, sc.right, sc.down, sc.up].every((v) => snaps.includes(v)) &&
    new Set([sc.left, sc.right, sc.down, sc.up]).size === 4,
    JSON.stringify([[sc.left, sc.right, sc.down, sc.up], snaps]));
}

console.log(failures ? ('\nkeybind_registry: ' + failures + ' FAILED')
                     : '\nkeybind_registry: all passed');
process.exit(failures ? 1 : 0);
