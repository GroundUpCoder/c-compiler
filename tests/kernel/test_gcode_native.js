#!/usr/bin/env node
'use strict';
// #314: the NATIVE gcode oracle, gated. os/gcode/test/smoke.mjs builds gcode.c
// with clang (real libcurl + real cJSON — the reference oracle for /bin/code's
// presentation: speaker headers, isatty gating, the Cost line, the diff
// renderer; test_code_e2e.js checks the in-OS build against the same fake SSE
// server shape) and before this wrapper it ran in NO suite.
//
// The oracle prints one "  ok "/"  FAIL " line per check and a bare final PASS
// with NO total — so exit 0 and PASS are equally true of a run that silently
// executed fewer checks. The denominator is derived from the SOURCE: the
// number of check( call sites (the function DEFINITION is itself one textual
// occurrence, hence the -1). A new check added to smoke.mjs raises the
// requirement automatically; a run that drops one fails here even at exit 0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSyncBudgeted } = require('../lib/spawn-budget.js');

const smoke = path.resolve(__dirname, '../../os/gcode/test/smoke.mjs');
const src = fs.readFileSync(smoke, 'utf-8');
const expected = (src.match(/\bcheck\(/g) || []).length
               - (src.match(/\bfunction check\(/g) || []).length;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
}

check(expected > 0, `smoke.mjs declares a positive check count (derived ${expected})`);

// Private TMPDIR: smoke.mjs builds its binary at a FIXED os.tmpdir() path
// (code-smoke-bin), so two concurrent instances — --repeat runs this file
// against itself — would race the clang -o and the running binary.
// os.tmpdir() honours TMPDIR, so a per-instance dir isolates both the binary
// and the oracle's scratch files.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-oracle-'));
// spawnSyncBudgeted (#513): a kill of the oracle — this file's 480s budget or
// an external signal on a contended box — must self-describe, never render as
// the product-shaped "oracle exits 0 (got null, signal ...)" line. Red either
// way, but the message points at the harness/environment, not at gcode.
const { r, kill } = spawnSyncBudgeted(process.execPath, [smoke], {
  encoding: 'utf-8', timeout: 480000,
  env: Object.assign({}, process.env, { TMPDIR: tmp }),
});
fs.rmSync(tmp, { recursive: true, force: true });

if (kill) {
  check(false, kill.message);
  console.log(`\n--- oracle stdout (partial) ---\n${r.stdout || ''}`);
  console.log(`\n1 FAILURE(S) (the oracle was KILLED — see the FAIL line above)`);
  process.exit(1);
}

const out = r.stdout || '';
const oks = (out.match(/^  ok /mg) || []).length;
const fails = (out.match(/^  FAIL /mg) || []).length;
check(r.status === 0, `oracle exits 0 (got ${r.status}${r.signal ? `, signal ${r.signal}` : ''})`);
check(fails === 0, `oracle reports zero FAIL lines (got ${fails})`);
check(oks === expected, `oracle ran ALL ${expected} checks (counted ${oks} ok lines)`);
check(/\nPASS\n?$/.test(out), 'oracle printed its final PASS');

if (failures) {
  console.log(`\n--- oracle stdout ---\n${out}`);
  console.log(`--- oracle stderr ---\n${r.stderr || ''}`);
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nPASS');
