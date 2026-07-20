// Guardrail (b) — serve-with-clang.js is HARD-FAIL (CLANG-CPP-EPIC Part II §6).
// Unlike `serve.js --clang` (a missing sibling silently serves the base image),
// serve-with-clang.js REQUIRES the clang toolchain: every preflight miss is a
// loud exit(1) naming the fix command — it NEVER falls back to the base image.
//
// Hermetic: each case stages just enough of a fake sibling to fail at a specific
// preflight stage. The three stages (sibling absent, toolchain unbuilt, overlay
// artifact absent) all prove the same contract — an explicit clang request that
// can't be satisfied fails loud, it does not degrade.
//
// Run: node tests/serve/test_serve_with_clang.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const WRAPPER = path.join(ROOT, 'serve-with-clang.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Run serve-with-clang.js SYNCHRONOUSLY to completion (it must exit at
// preflight — it never reaches the listen step in these cases). Returns
// { status, stderr }.
function run(clangRoot) {
  const served = fs.mkdtempSync(path.join(os.tmpdir(), 'swc-served-'));
  try {
    const r = cp.spawnSync(process.execPath,
      [WRAPPER, served, '0', `--clang-root=${clangRoot}`],
      { cwd: ROOT, encoding: 'utf-8', timeout: 20000 });
    return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
  } finally { fs.rmSync(served, { recursive: true, force: true }); }
}

// --- 1. sibling ABSENT ------------------------------------------------------
{
  const gone = path.join(os.tmpdir(), 'swc-nonexistent-' + process.pid);
  const r = run(gone);
  check('sibling absent: exit 1', r.status === 1, 'exit ' + r.status);
  check('sibling absent: names the missing sibling path', r.stderr.includes(gone), r.stderr);
  check('sibling absent: gives the fix command', /fix: clone it next to this repo/.test(r.stderr), r.stderr);
  check('sibling absent: does NOT fall back to serving', !/Open http/.test(r.stdout), r.stdout);
}

// --- 2. sibling present, toolchain UNBUILT ----------------------------------
{
  const sib = fs.mkdtempSync(path.join(os.tmpdir(), 'swc-sib-'));
  try {
    // Sibling dir exists but simple1/out/clang does not.
    const r = run(sib);
    check('toolchain unbuilt: exit 1', r.status === 1, 'exit ' + r.status);
    check('toolchain unbuilt: names build.sh', /\.\/build\.sh/.test(r.stderr), r.stderr);
  } finally { fs.rmSync(sib, { recursive: true, force: true }); }
}

// --- 3. sibling + toolchain present, overlay artifact ABSENT ----------------
{
  const sib = fs.mkdtempSync(path.join(os.tmpdir(), 'swc-sib-'));
  try {
    fs.mkdirSync(path.join(sib, 'simple1', 'out'), { recursive: true });
    fs.writeFileSync(path.join(sib, 'simple1', 'out', 'clang'), '#!/bin/sh\n', { mode: 0o755 });
    // No out-image/overlay.json.
    const r = run(sib);
    check('overlay absent: exit 1', r.status === 1, 'exit ' + r.status);
    check('overlay absent: names mk-overlay.mjs', /mk-overlay\.mjs/.test(r.stderr), r.stderr);
    check('overlay absent: mentions --build-overlay opt-in', /--build-overlay/.test(r.stderr), r.stderr);
  } finally { fs.rmSync(sib, { recursive: true, force: true }); }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
