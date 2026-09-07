#!/usr/bin/env node
'use strict';
// #773: aggregate-return temporaries live in STATIC caller frame slots, not in a
// runtime shadow-stack bump released by a codegen counter.
//
// The instrument is the inliner's own refusal tally. Under the base convention
// every aggregate-returning callee was refused (`refused.structRet > 0`) because
// splicing a callee into a caller holding an outstanding deferred SP bump
// interleaves two stack-pointer disciplines. Frame slots remove the bump, so an
// sret callee becomes an ordinary callee and the refusal REASON is retired
// outright — leg 1 requires the key to be gone, not merely zero, so a tally that
// is silently never incremented cannot pass for a fix.
//
// Leg 3 is the RED CONTROL: the same program with __attribute__((noinline)) on the
// aggregate-returning callees must still refuse them — by the `noinline` reason,
// not `structRet` — so a green leg 1 cannot be an artifact of a stats tally that
// simply stopped counting.
// Leg 4 pins the REDESIGN rather than its symptom: deleting the inliner refusal
// while leaving the deferred bump in place would satisfy legs 1-3 unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CC = require('../../compiler.js');
const HOST = require('../../host.js');

const NAME = '/agg-frame.c';
function source(attr) {
  return `
#include <stdio.h>
typedef struct { int x, y; } P;
${attr} static P mk(int a, int b) { P p; p.x = a; p.y = b; return p; }
${attr} static P addp(P a, P b) { return mk(a.x + b.x, a.y + b.y); }
static int sum2(P a, P b) { return a.x + a.y + b.x + b.y; }
int main(void) {
  P acc = mk(0, 0);
  for (int i = 0; i < 50; i++) acc = addp(acc, mk(i, i * 2));
  printf("%d %d %d\\n", acc.x, acc.y, sum2(mk(1, 2), addp(mk(3, 4), mk(5, 6))));
  return 0;
}
`;
}

function build(attr) {
  const src = source(attr);
  const pp = CC.createDefaultPPRegistry();
  pp.fileReader = p => (p === NAME ? src : null);
  const opts = { compilerOptions: {}, warningFlags: {}, writeErr: s => { throw new Error(s); } };
  const units = CC.parseAllUnits(
    { readFileSync: p => { if (p !== NAME) throw new Error(p); return src; } }, pp, [NAME], opts);
  assert.deepStrictEqual(CC.linkTranslationUnits(units, opts.compilerOptions).errors, []);
  const bytes = CC.generateCode(units, 'a.wasm', opts);
  return { bytes, stats: CC.WAST.lastPassStats.inline };
}

async function run(bytes) {
  let out = '';
  await HOST({ bytes, args: ['agg'], fs, writeOut: b => { out += new TextDecoder().decode(b); } });
  return out;
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}

(async () => {
  const dflt = build('');
  const pinned = build('__attribute__((noinline))');

  await check('aggregate-returning callees are no longer refused', () => {
    assert(!('structRet' in dflt.stats.refused),
      'the structRet refusal reason still exists: ' + JSON.stringify(dflt.stats.refused));
    assert(dflt.stats.inlined > 0, 'nothing inlined at all: ' + JSON.stringify(dflt.stats));
  });

  await check('inlining an aggregate-returning callee keeps the answer', async () => {
    const a = await run(dflt.bytes), b = await run(pinned.bytes);
    assert.strictEqual(a, b, 'inlined output ' + JSON.stringify(a) +
      ' != noinline-pinned output ' + JSON.stringify(b));
    assert.strictEqual(a.trim(), '1225 2450 21', a);
  });

  await check('RED CONTROL: noinline still refuses, by its own reason', () => {
    assert(pinned.stats.refused.noinline > 0,
      'noinline attribute stopped being counted: ' + JSON.stringify(pinned.stats.refused));
    assert(!('structRet' in pinned.stats.refused),
      'the structRet refusal reason still exists: ' + JSON.stringify(pinned.stats.refused));
  });

  await check('the deferred shadow-stack bump is gone from the emitter', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../compiler.js'), 'utf8');
    for (const dead of ['structRetDeferred', 'structRetAllocSize']) {
      assert(!src.includes(dead),
        'compiler.js still carries `' + dead + '` — the inliner refusal was lifted ' +
        'without retiring the runtime bump it existed to protect');
    }
  });

  process.exit(failures ? 1 : 0);
})();
