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
  return buildSource(source(attr));
}

function buildSource(src, compilerOptions = {}) {
  const pp = CC.createDefaultPPRegistry();
  pp.fileReader = p => (p === NAME ? src : null);
  const opts = { compilerOptions, warningFlags: {}, writeErr: s => { throw new Error(s); } };
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

  // Both arms must remain in the AST (volatile condition), but only one can
  // execute. At 35 KiB per arm, summing their frame slots exceeds the default
  // 64 KiB stack. Check actual execution, with inlining both enabled/disabled.
  const arm = start => Array.from({ length: 35 }, (_, i) => `mk(${start + i})`).join(', ');
  const branchSource = `
#include <stdio.h>
typedef struct { int a[256]; } P;
static int calls;
static P mk(int n) { P p; p.a[0] = n; p.a[255] = n + 1; calls++; return p; }
int main(void) {
  for (volatile int c = 0; c < 2; c++) {
    P p = c ? (${arm(100)}) : (${arm(200)});
    printf("%d %d %d\\n", p.a[0], p.a[255], calls);
  }
  return 0;
}`;
  for (const noInline of [false, true]) {
    await check(`exclusive aggregate arms fit the default stack (noInline=${noInline})`, async () => {
      const { bytes } = buildSource(branchSource, { noInline });
      assert.strictEqual(await run(bytes), '234 235 35\n134 135 70\n');
    });
  }


  const lifetimeSource = `
#include <stdio.h>
#include <stdarg.h>
typedef struct { int a[2]; } Small;
typedef struct { int a[8]; } Large;
static int *saved;
static Small small(int n) { Small p = {{n, n + 1}}; return p; }
static Large large(int n) { Large p = {{n, n + 1}}; return p; }
static int check(int *a, int *b, int *c, int choose) {
  return a[0] == 10 && a[1] == 11 && b[0] == (choose ? 20 : 30) &&
    b[1] == b[0] + 1 && c[0] == 40 && c[1] == 41 && saved[0] == choose;
}
static Small variadic(int n, ...) {
  va_list ap; va_start(ap, n); Small p = {{n, va_arg(ap, int)}};
  va_end(ap); return p;
}
static int pair(int *a, int *b) { return a[0] + a[1] + b[0] + b[1]; }
int main(void) {
  Small (*fp)(int, ...) = variadic;
  for (volatile int c = 0; c < 2; c++) {
    // The condition's temporary and both sibling arguments stay live while
    // the selected arm runs. Arms differ in size and number of call sites.
    printf("%d ", check(small(10).a,
      ((saved = small(c).a), saved[0]) ?
        (c > 0 ? small(20).a : large(99).a) : (small(90), large(30).a),
      large(40).a, c));
    printf("%d\\n", small(c).a[0] ?: large(50).a[0]);
  }
  // Both variadic emission paths copy the result out before freeing their
  // argument block; a later call must not overwrite either result.
  printf("%d\\n", pair(variadic(1, small(2).a[0]).a, fp(3, 4).a));
  return 0;
}`;
  for (const noInline of [false, true]) {
    await check(`pooled slots preserve condition, siblings and variadic results (noInline=${noInline})`, async () => {
      const { bytes } = buildSource(lifetimeSource, { noInline });
      assert.strictEqual(await run(bytes), '1 50\n1 1\n10\n');
    });
  }


  // Per-ordinal max sizes also overallocate: [40000, 16] and [16, 40000]
  // must share a ~40 KiB arena, not become [40000, 40000]. The large callee
  // returns static storage so it does not itself need another 40 KiB frame.
  const mixedSizeSource = `
#include <stdio.h>
typedef struct { int a[10000]; } Big;
typedef struct { int a[2]; } Tiny;
static Big big(int n) { static Big p; p.a[0] = n; return p; }
static Tiny tiny(int n) { Tiny p = {{n, n + 1}}; return p; }
static int pair(int *a, int *b) { return a[0] + b[0]; }
int main(void) {
  for (volatile int c = 0; c < 2; c++)
    printf("%d\\n", c ? pair(big(10).a, tiny(20).a) : pair(tiny(30).a, big(40).a));
  // Independent full expressions share the same arena too.
  printf("%d\\n", pair(big(50).a, tiny(60).a));
  printf("%d\\n", pair(tiny(70).a, big(80).a));
  return 0;
}`;
  for (const noInline of [false, true]) {
    await check(`opposite-sized paths share bytes, not ordinal maxima (noInline=${noInline})`, async () => {
      const { bytes } = buildSource(mixedSizeSource, { noInline });
      assert.strictEqual(await run(bytes), '70\n30\n110\n150\n');
    });
  }

  process.exit(failures ? 1 : 0);
})();
