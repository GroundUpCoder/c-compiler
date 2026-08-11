#!/usr/bin/env node
'use strict';
// #639 — the preprocessor honours SOURCE_DATE_EPOCH (the reproducible-builds
// convention gcc/clang implement) for __DATE__/__TIME__.
//
// The two axes of the bug, both probed here:
//   time:     without an override, every build stamps a different string;
//   timezone: the unset path uses LOCAL accessors, so two machines building
//             at the SAME instant in different zones already disagree.
// The TZ axis is exercised with Pacific/Kiritimati (UTC+14) against
// Pacific/Pago_Pago (UTC-11): their offsets are 25 h apart year-round (no
// DST in either), so at ANY instant their local calendar dates differ —
// no midnight race, no clock in the assertion.
//
// LEG ORDER IS LOAD-BEARING: leg 1 asserts the epoch-derived UTC rendering
// directly and in isolation, so at the pre-fix base commit this file fails
// AT THAT CLAIM (the red control proves the right thing), not on some
// downstream comparison.
var fs = require('fs');
var os = require('os');
var path = require('path');
var { spawnSync } = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var COMPILER = path.join(ROOT, 'compiler.js');
var failures = 0;

function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sde-'));
var SRC = path.join(tmp, 'probe.c');
fs.writeFileSync(SRC, 'const char d[] = __DATE__;\n'
  + 'const char t[] = __TIME__;\n'
  + 'int main(void) { return d[0] ^ t[0]; }\n');

// Every child gets a purpose-built environment: ambient SOURCE_DATE_EPOCH
// stripped first, then the leg's own settings applied. TZ is honoured by a
// FRESH node process (never mutated in-process — node caches its zone).
function runCli(args, envOverrides) {
  var env = Object.assign({}, process.env);
  delete env.SOURCE_DATE_EPOCH;
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [COMPILER].concat(args),
    { env: env, encoding: 'utf8' });
}

function lexStrings(envOverrides) {
  var r = runCli(['-a', 'lex', SRC], envOverrides);
  if (r.status !== 0) return { status: r.status, stderr: r.stderr, date: null, time: null };
  // Two STRING tokens, in source order: __DATE__ then __TIME__. Escaped
  // inner quotes in formatToken output: STRING "\"Sep  9 2001\"".
  var m = r.stdout.match(/STRING "\\"([^\\]*)\\""/g) || [];
  return {
    status: 0,
    date: m[0] ? m[0].replace(/^STRING "\\"|\\""$/g, '') : null,
    time: m[1] ? m[1].replace(/^STRING "\\"|\\""$/g, '') : null,
  };
}

var TZ_EAST = 'Pacific/Kiritimati';  // UTC+14
var TZ_WEST = 'Pacific/Pago_Pago';   // UTC-11
var EPOCH = '1000000000';            // 2001-09-09 01:46:40 UTC

// ---- leg 1: the load-bearing claim, direct and in isolation --------------
// SOURCE_DATE_EPOCH set => __DATE__/__TIME__ are that epoch rendered in UTC.
// This is the assertion the base commit fails (it stamps the local wall
// clock instead), so the red control fails HERE and for THIS reason.
var east = lexStrings({ SOURCE_DATE_EPOCH: EPOCH, TZ: TZ_EAST });
check('leg1: epoch-derived UTC __DATE__ (day space-padded)',
  east.date === 'Sep  9 2001', 'got ' + JSON.stringify(east.date));
check('leg1: epoch-derived UTC __TIME__',
  east.time === '01:46:40', 'got ' + JSON.stringify(east.time));

// ---- leg 2: the timezone axis -------------------------------------------
// The SAME epoch under a zone 25 h away renders identically, and the two
// full compiles are byte-identical wasm (acceptance's literal wording) even
// though the runs happen at different wall-clock moments.
var west = lexStrings({ SOURCE_DATE_EPOCH: EPOCH, TZ: TZ_WEST });
check('leg2: __DATE__ identical across TZ', west.date === east.date,
  east.date + ' vs ' + west.date);
check('leg2: __TIME__ identical across TZ', west.time === east.time,
  east.time + ' vs ' + west.time);
var outA = path.join(tmp, 'a.wasm'), outB = path.join(tmp, 'b.wasm');
var ra = runCli([SRC, '-o', outA], { SOURCE_DATE_EPOCH: EPOCH, TZ: TZ_EAST });
var rb = runCli([SRC, '-o', outB], { SOURCE_DATE_EPOCH: EPOCH, TZ: TZ_WEST });
check('leg2: both compiles exit 0', ra.status === 0 && rb.status === 0,
  'exit ' + ra.status + '/' + rb.status + ' ' + (ra.stderr || '') + (rb.stderr || ''));
check('leg2: wasm byte-identical across TZ + wall-clock',
  ra.status === 0 && rb.status === 0 &&
  Buffer.compare(fs.readFileSync(outA), fs.readFileSync(outB)) === 0);

// ---- leg 3: zero is a valid instant (the falsy-zero bug class) ----------
var zero = lexStrings({ SOURCE_DATE_EPOCH: '0', TZ: TZ_EAST });
check('leg3: epoch 0 renders 1970-01-01 UTC, not the wall clock',
  zero.date === 'Jan  1 1970' && zero.time === '00:00:00',
  JSON.stringify([zero.date, zero.time]));

// ---- leg 4: the cap is inclusive and the year stays 4 digits ------------
var max = lexStrings({ SOURCE_DATE_EPOCH: '253402300799', TZ: TZ_WEST });
check('leg4: max epoch 253402300799 accepted, renders 9999-12-31',
  max.date === 'Dec 31 9999' && max.time === '23:59:59',
  JSON.stringify([max.date, max.time]));

// ---- leg 5: the unset path is UNCHANGED (still local wall clock) --------
// 25 h of offset means the two zones NEVER share a calendar date, so with
// the variable unset the two dates must differ — local accessors are still
// in effect — and both must be well-formed asctime-style dates.
var uEast = lexStrings({ TZ: TZ_EAST });
var uWest = lexStrings({ TZ: TZ_WEST });
var DATE_RE = /^[A-Z][a-z]{2} [ 1-9]\d \d{4}$/;
check('leg5: unset path still renders local dates (well-formed)',
  DATE_RE.test(uEast.date || '') && DATE_RE.test(uWest.date || ''),
  JSON.stringify([uEast.date, uWest.date]));
check('leg5: unset path still LOCAL — 25h-apart zones disagree on the date',
  uEast.date !== null && uEast.date !== uWest.date,
  JSON.stringify([uEast.date, uWest.date]));
check('leg5: unset path is not the epoch rendering',
  uEast.date !== 'Sep  9 2001');

// ---- leg 6: invalid values refuse loudly, by the stated rule ------------
// Rule (documented at parseSourceDateEpoch in compiler.js): the value must
// be ASCII decimal digits, numerically <= 253402300799. Everything else —
// empty, sign, whitespace, hex, fractional, over-cap — exits 1 with a
// diagnostic naming the variable, and NOT an uncaught stack trace.
['', 'abc', '-1', '+5', ' 5', '12x', '1.5', '0x10', '253402300800']
  .forEach(function (bad) {
    var r = runCli(['-a', 'lex', SRC], { SOURCE_DATE_EPOCH: bad });
    var named = /SOURCE_DATE_EPOCH/.test(r.stderr || '');
    var traced = /\n\s+at /.test(r.stderr || '');
    check('leg6: ' + JSON.stringify(bad) + ' -> exit 1, named, no stack trace',
      r.status === 1 && named && !traced,
      'exit ' + r.status + ' stderr: ' + JSON.stringify((r.stderr || '').slice(0, 200)));
  });

// ---- leg 7: the exported parser, boundary-exact -------------------------
var CompilerJS = require(COMPILER);
check('leg7: parseSourceDateEpoch exported',
  typeof CompilerJS.parseSourceDateEpoch === 'function');
if (typeof CompilerJS.parseSourceDateEpoch === 'function') {
  check('leg7: "0" -> 0', CompilerJS.parseSourceDateEpoch('0') === 0);
  check('leg7: cap inclusive',
    CompilerJS.parseSourceDateEpoch('253402300799') === 253402300799);
  var threw = false;
  try { CompilerJS.parseSourceDateEpoch('253402300800'); } catch (e) { threw = true; }
  check('leg7: cap+1 throws', threw);
}

// ---- leg 8: the in-OS cc driver refuses with a NAMED cc: line -----------
// createCcDriver wraps registry creation so an invalid host value (boot.js
// hosts the kernel inside the host's environment) surfaces as a named
// diagnostic, not the compile hook's catch-all EIO. The throw happens
// before any kfs access, so a null kfs proves the ordering too.
var COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
var saved = process.env.SOURCE_DATE_EPOCH;
process.env.SOURCE_DATE_EPOCH = 'bogus';
try {
  var res = COMMON.createCcDriver(CompilerJS, null)(['cc', 'x.c'], '/');
  check('leg8: cc driver exitCode 1 + named stderr',
    res.exitCode === 1 && /SOURCE_DATE_EPOCH/.test(res.stderr),
    JSON.stringify(res));
} finally {
  if (saved === undefined) delete process.env.SOURCE_DATE_EPOCH;
  else process.env.SOURCE_DATE_EPOCH = saved;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? failures + ' check(s) FAILED' : 'all checks passed');
process.exit(failures ? 1 : 0);
