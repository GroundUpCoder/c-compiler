#!/usr/bin/env node
'use strict';
// todos/0320 regression guard — the preprocessor must not blow the JS stack on
// a macro that expands to a very large token list.
//
// WHY THIS SHAPE, and not a corpus fixture: the failure was
// `dst.push(...src)`, whose argument count is `src.length`, against V8's
// argument limit. That limit is the AVAILABLE STACK, not a constant — measured
// here, a 400,000-element spread dies on a default main-thread stack and
// SURVIVES under `node --stack-size=200000`. So any test tuned to a token
// count is a latent flake that flips on the next Node bump or when the runner
// moves the work into a worker (which is exactly what happened when this was
// first tried as a conformance fixture: it XPASSed under tests/run-unit.js's
// worker_threads stack). The two guards below are limit-INDEPENDENT:
//
//   (1) a source lint: no call-argument spread survives in compiler.js outside
//       the one bounded helper, so a new `x.push(...tokens)` fails here;
//   (2) the helper's contract: no matter how long the input, no single push
//       call receives more than SPREAD_CHUNK arguments.
//
// (3) is an end-to-end smoke that the real preprocessor swallows a wide macro
// in a FRESH main-thread process (the worst-case stack). It is a positive
// check only — it can never fail spuriously, and on a hypothetically larger
// stack it would merely stop being informative, which is why (1) and (2) are
// the actual guards.
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

// ---------------------------------------------------------------- (1) lint
// A call-argument spread is `<callee>(...<expr>`. Array literals (`[...a]`),
// object literals (`{...o}`) and rest parameters (`f(...args) {`) are all
// safe — only a CALL passes each element as its own argument — so key on a
// `(` that directly follows an identifier / `)` / `]`.
var src = fs.readFileSync(COMPILER, 'utf8');
var lines = src.split('\n');
var SPREAD_CALL = /[A-Za-z_0-9)\]]\(\s*\.\.\.[A-Za-z_$[{(]/;
// A rest PARAMETER (`join(...locs) {`, `function f(...a) {`) declares a
// signature; it never passes an argument list, so it is not this hazard.
var REST_PARAM = /(function\s*)?[A-Za-z_$][\w$]*\s*\(\s*\.\.\.[A-Za-z_$][\w$]*\s*\)\s*\{/;
// The two deliberate, bounded spreads inside pushAll itself.
var ALLOWED = /dst\.push\(\.\.\.src(\.slice\(o, o \+ SPREAD_CHUNK\))?\)/;
var offenders = [];
for (var i = 0; i < lines.length; i++) {
  var line = lines[i];
  if (/^\s*(\/\/|\*)/.test(line)) continue;   // comment line
  if (!SPREAD_CALL.test(line)) continue;
  if (ALLOWED.test(line)) continue;
  if (REST_PARAM.test(line)) continue;
  offenders.push('compiler.js:' + (i + 1) + ': ' + line.trim());
}
check('no unbounded call-argument spread in compiler.js',
      offenders.length === 0,
      offenders.length
        ? offenders.length + ' site(s):\n       ' + offenders.join('\n       ') +
          '\n       Use pushAll(dst, src) (or an explicit loop) — a spread over an ' +
          'input-sized array is a RangeError waiting for a big enough input.'
        : 'only pushAll\'s own SPREAD_CHUNK-bounded spreads remain');

// pushAll must actually be wired in — a lint that passes because every call
// site was deleted would be vacuous.
var pushAllUses = (src.match(/\bpushAll\(/g) || []).length;
check('pushAll is wired at the converted sites', pushAllUses >= 12,
      pushAllUses + ' call(s) (12 converted sites + its own definition)');

// ------------------------------------------------- (2) the helper's contract
var CC = require(COMPILER);
check('compiler.js exports pushAll/SPREAD_CHUNK',
      typeof CC.pushAll === 'function' && typeof CC.SPREAD_CHUNK === 'number',
      'SPREAD_CHUNK=' + CC.SPREAD_CHUNK);

var N = 500000;
var big = new Array(N);
for (var k = 0; k < N; k++) big[k] = k;

var maxArgs = 0;
var calls = 0;
var probe = [];
probe.push = function () {
  calls++;
  if (arguments.length > maxArgs) maxArgs = arguments.length;
  return Array.prototype.push.apply(this, arguments);
};
CC.pushAll(probe, big);
check('pushAll appends every element', probe.length === N &&
      probe[0] === 0 && probe[N - 1] === N - 1,
      'length=' + probe.length);
check('pushAll bounds the per-call argument count',
      maxArgs <= CC.SPREAD_CHUNK,
      'max ' + maxArgs + ' arg(s) over ' + calls + ' call(s), limit ' + CC.SPREAD_CHUNK);
// Small inputs must keep taking the single fast spread (this is a hot
// preprocessor path — the loop form measured 3-4x slower at n<=256).
var small = [1, 2, 3];
var probe2 = [];
var smallCalls = 0;
probe2.push = function () {
  smallCalls++;
  return Array.prototype.push.apply(this, arguments);
};
CC.pushAll(probe2, small);
check('pushAll keeps the one-call fast path for small inputs',
      smallCalls === 1 && probe2.length === 3, smallCalls + ' call(s)');
var probe3 = [];
var emptyCalls = 0;
probe3.push = function () { emptyCalls++; return 0; };
CC.pushAll(probe3, []);
check('pushAll skips the call entirely for an empty source', emptyCalls === 0);

// -------------------------------------------------------- (3) e2e smoke
// A fresh `node compiler.js` — main thread, default stack, the worst case for
// the argument limit. 400k tokens is ~6x the measured pre-fix failure point.
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-0320-'));
var wide = path.join(tmp, 'wide.c');
try {
  var TOK = 400000;
  fs.writeFileSync(wide,
    '#define BIG ' + new Array(TOK).fill('1,').join(' ') + '0\n' +
    'int a[] = { BIG };\n' +
    'int main(void) { return 0; }\n');
  var r = spawnSync(process.execPath, [COMPILER, '-a', 'lex', wide],
                    { encoding: 'utf8', maxBuffer: 1 << 30 });
  var stderr = (r.stderr || '').trim();
  check('a ' + TOK + '-token macro preprocesses in a fresh main-thread process',
        r.status === 0 && !/RangeError/.test(stderr + (r.stdout || '')),
        r.status === 0 ? 'exit 0' : 'exit ' + r.status + ': ' + stderr.split('\n')[0]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failures ? 1 : 0);
