'use strict';

// JS-level unit tests for the WAST pass layer (todos/0200) — the
// offset-fold peephole's match/skip rules, which the .c-test suite can
// only exercise behaviorally:
//   - load fold: [const k, i32.add, load off=0] -> [load off=k]
//   - store fold ACROSS one pure value node (const/local.get/global.get)
//     — and, critically, NO fold when the const+add adjacent to a store
//     produced the store's VALUE (the miscompile the value-node rule
//     prevents: a store pops [value, addr] with the value on top)
//   - skip rules: negative k, wrapped-negative k (u32 form), non-add,
//     i64 add, pre-existing nonzero offset, WSrcLoc/WRaw barriers,
//     complex store values
//   - greedy +0 chains fold in one pass, and a SECOND pass is a no-op
//     (idempotence — the "second pass must be a safe no-op" rule)
//
// Each case prints PASS/FAIL; exits non-zero on any failure.

const C = require('../../compiler.js');
const { WAST } = C;
const { WastBuilder, WConst, WMop, MOP, ALU, WT_I32, WT_I64 } = WAST;

let failures = 0;

function mk(build) { const b = new WastBuilder(); build(b); return b.nodes; }

function runOn(nodes) {
  const wmod = { funcDefs: [{ wast: nodes }] };
  WAST.runPasses(wmod);
  return { nodes: wmod.funcDefs[0].wast, folds: wmod.passStats.offsetFolds };
}

// Render a node list as a comparable shape string (class names, plus the
// immediates the fold reads/writes).
function shape(nodes) {
  return nodes.map(n =>
    n.constructor.name +
    (n instanceof WMop ? `(op=${n.opcode},off=${n.offset})` :
     n instanceof WConst ? `(${n.value})` : '')
  ).join(' ');
}

function check(name, nodes, expShape, expFolds) {
  const r1 = runOn(nodes);
  const got = shape(r1.nodes);
  if (got !== expShape || r1.folds !== expFolds) {
    console.log(`FAIL ${name}`);
    console.log(`  got   ${got} (folds=${r1.folds})`);
    console.log(`  want  ${expShape} (folds=${expFolds})`);
    failures++;
    return;
  }
  // Idempotence: a second run of the pass must change nothing.
  const r2 = runOn(r1.nodes);
  if (r2.folds !== 0 || shape(r2.nodes) !== expShape) {
    console.log(`FAIL ${name}: second pass not a no-op ` +
                `(folds=${r2.folds}, shape=${shape(r2.nodes)})`);
    failures++;
    return;
  }
  console.log(`PASS ${name}`);
}

// ---- load folds ----
check('load-basic',
  mk(b => { b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WMop(op=40,off=8)', 1);
check('load-zero-k',
  mk(b => { b.localGet(0); b.i32Const(0); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WMop(op=40,off=0)', 1);
check('load-zero-chain-greedy',
  mk(b => { b.localGet(0); b.i32Const(16); b.aop(WT_I32, ALU.OP_ADD); b.i32Const(0); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WMop(op=40,off=16)', 2);
check('load-const-base',
  mk(b => { b.i32Const(65536); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WConst(65536) WMop(op=40,off=8)', 1);

// ---- load skip rules ----
check('load-negative-k',
  mk(b => { b.localGet(0); b.i32Const(-8); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WConst(-8) WAop WMop(op=40,off=0)', 0);
// 4294967288 is the u32 spelling of -8: serialize() emits it via
// Number(v)|0, so its semantic value IS negative — must not fold.
check('load-wrapped-negative-k',
  mk(b => { b.localGet(0); b.i32Const(4294967288); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WConst(4294967288) WAop WMop(op=40,off=0)', 0);
check('load-sub-not-add',
  mk(b => { b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_SUB); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WConst(8) WAop WMop(op=40,off=0)', 0);
check('load-i64-add',
  mk(b => { b.localGet(0); b.i64Const(8n); b.aop(WT_I64, ALU.OP_ADD); b.mop(MOP.I64_LOAD, 0, 3); }),
  'WLocalGet WConst(8) WAop WMop(op=41,off=0)', 0);
check('load-preexisting-offset',
  mk(b => { b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 4, 2); }),
  'WLocalGet WConst(8) WAop WMop(op=40,off=4)', 0);
check('load-srcloc-barrier',
  mk(b => { b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD); b.srcLoc(0, 3); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WConst(8) WAop WSrcLoc WMop(op=40,off=0)', 0);
check('load-raw-barrier',
  mk(b => { b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD); b.push(0x01); b.mop(MOP.I32_LOAD, 0, 2); }),
  'WLocalGet WConst(8) WAop WRaw WMop(op=40,off=0)', 0);

// ---- store folds (across ONE pure value node) ----
check('store-localget-value',
  mk(b => { b.localGet(0); b.i32Const(12); b.aop(WT_I32, ALU.OP_ADD); b.localGet(1); b.mop(MOP.I32_STORE, 0, 2); }),
  'WLocalGet WLocalGet WMop(op=54,off=12)', 1);
check('store-const-value',
  mk(b => { b.localGet(0); b.i32Const(12); b.aop(WT_I32, ALU.OP_ADD); b.i32Const(99); b.mop(MOP.I32_STORE, 0, 2); }),
  'WLocalGet WConst(99) WMop(op=54,off=12)', 1);
check('store-globalget-value',
  mk(b => { b.localGet(0); b.i32Const(12); b.aop(WT_I32, ALU.OP_ADD); b.globalGet(0); b.mop(MOP.I64_STORE, 0, 3); }),
  'WLocalGet WGlobalGet WMop(op=55,off=12)', 1);
check('store-zero-chain-greedy',
  mk(b => { b.localGet(0); b.i32Const(24); b.aop(WT_I32, ALU.OP_ADD); b.i32Const(0); b.aop(WT_I32, ALU.OP_ADD); b.localGet(1); b.mop(MOP.I32_STORE, 0, 2); }),
  'WLocalGet WLocalGet WMop(op=54,off=24)', 2);

// ---- store skip rules ----
// *p = x + 4: [local.get p, local.get x, const 4, add, store] — the
// const+add adjacent to the store computed the VALUE. Folding here would
// store x at p+4 instead of x+4 at p. THE critical no-fold case.
check('store-value-is-the-add',
  mk(b => { b.localGet(0); b.localGet(1); b.i32Const(4); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_STORE, 0, 2); }),
  'WLocalGet WLocalGet WConst(4) WAop WMop(op=54,off=0)', 0);
// Value produced by a load (not a pure single-push node): skip.
check('store-complex-value',
  mk(b => { b.localGet(0); b.i32Const(12); b.aop(WT_I32, ALU.OP_ADD); b.localGet(1); b.mop(MOP.I32_LOAD, 0, 2); b.mop(MOP.I32_STORE, 0, 2); }),
  'WLocalGet WConst(12) WAop WLocalGet WMop(op=40,off=0) WMop(op=54,off=0)', 0);
check('store-negative-k',
  mk(b => { b.localGet(0); b.i32Const(-4); b.aop(WT_I32, ALU.OP_ADD); b.localGet(1); b.mop(MOP.I32_STORE, 0, 2); }),
  'WLocalGet WConst(-4) WAop WLocalGet WMop(op=54,off=0)', 0);

// ---- structural safety ----
// Folding inside control flow: label identities must survive (validate
// runs inside runPasses on every rewritten function and throws if not).
check('fold-inside-block',
  mk(b => {
    b.block();
    b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD); b.mop(MOP.I32_LOAD, 0, 2);
    b.brIf(0);
    b.end();
  }),
  'WBlock WLocalGet WMop(op=40,off=8) WBrIf WEnd', 1);
// Control node between add and mop is a barrier by class mismatch.
check('block-boundary-barrier',
  mk(b => {
    b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD);
    b.block(); b.end();
    b.mop(MOP.I32_LOAD, 0, 2);
  }),
  'WLocalGet WConst(8) WAop WBlock WEnd WMop(op=40,off=0)', 0);

if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all WAST pass tests passed');
