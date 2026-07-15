'use strict';

// JS-level unit tests for the WAST whole-body inliner (todos/0201) —
// transform mechanics on hand-built node lists, one pinned case per
// REFUSAL category, and end-to-end C execution checks (the SameBoy
// framebuffer-checksum interlock in tests/bench is the integration
// oracle on top of these).
//
// Mechanics covered:
//   - single- and multi-arg param binding (reverse-order stack drain;
//     args stay put = evaluated exactly once, in source order)
//   - return -> WBr(wrapper), INCLUDING return nested inside a loop, and
//     funcLabel-targeted branches (br to function depth) -> wrapper
//   - frameless and standard-fixed-frame callees (savedSp renumbered,
//     verbatim prologue/epilogue splice)
//   - local renumber: callee param+declared index space shifted by the
//     caller's params+declared count; caller locals vector grows by the
//     callee's param types + declared RLE runs
//   - site-level recursion snapshot: a self-recursive callee inlines into
//     OTHER callers with its internal recursive call left as a real call;
//     mutual-recursion SCCs splice single snapshots and terminate
//   - nested composition: Tarjan callee-first order means a spliced body
//     already contains its own inlines
//   - pass ordering: runPasses inlines FIRST, then foldMemOffsets folds
//     const+add displacements exposed inside the inlined clone (fresh
//     node instances make the two independent — no shared-WMop double
//     fold)
// Refusals covered (site left as a call, stats bucket incremented):
//   self, imported, noBody, variadic, alloca, overAligned, structRet,
//   eh (WTryTable/WThrow), raw (WRaw), multiResult, budgetCallee
//   (real-node cap, WSrcLoc excluded), budgetCaller (growth ceiling),
//   and enabled:false.
//
// Each case prints PASS/FAIL; exits non-zero on any failure.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const C = require('../../compiler.js');
const { WAST } = C;
const {
  WastBuilder, WBlock, WLoop, WBr, WCall, WConst, WLocalGet, WLocalSet,
  WMop, WDrop, WEnd, WSrcLoc, MOP, ALU, WT_I32, WT_EMPTY,
} = WAST;

let failures = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); }
  else { console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}

// ---- fake-wmod scaffolding ----

const META0 = { variadic: false, frameSize: 0, overAligned: false, structRet: false, usesAlloca: false };

function mkWmod() {
  return { funcImports: [], funcDefs: [], typeDefs: [] };
}
function addFn(wmod, { params = [], results = [], locals = [], meta = {} }, build) {
  const typeId = wmod.typeDefs.length;
  wmod.typeDefs.push({ kind: 'func', params, results });
  const b = new WastBuilder();
  if (build) build(b);
  const def = {
    typeId, locals, body: [],
    wast: build ? b.nodes : null,
    fnMeta: build ? Object.assign({}, META0, meta) : null,
  };
  wmod.funcDefs.push(def);
  return wmod.funcDefs.length - 1; // defIdx == funcIdx (no imports by default)
}
function shape(nodes) {
  return nodes.map(n =>
    n.constructor.name +
    (n.idx !== undefined ? `(${n.idx})` :
     n.funcIdx !== undefined ? `(f${n.funcIdx})` :
     n instanceof WConst ? `(${n.value})` :
     n instanceof WMop ? `(off=${n.offset})` : '')
  ).join(' ');
}
function localTotal(def) { return def.locals.reduce((a, l) => a + l.count, 0); }
function callsIn(nodes, funcIdx) {
  let c = 0;
  for (const n of nodes) if (n instanceof WCall && (funcIdx === undefined || n.funcIdx === funcIdx)) c++;
  return c;
}

// ---- A. single-arg binding, result block, label identity ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.i32Const(1); b.aop(WT_I32, ALU.OP_ADD); b.ret();
  });
  const g = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(42); b.call(f); b.drop(); b.i32Const(0); b.ret();
  });
  const st = WAST.inlineFunctions(w);
  const n = w.funcDefs[g].wast;
  ok('basic-shape',
     shape(n) === 'WConst(42) WLocalSet(0) WBlock WLocalGet(0) WConst(1) WAop WBr WEnd WDrop WConst(0) WReturn',
     shape(n));
  const wrap = n.find(x => x instanceof WBlock);
  const br = n.find(x => x instanceof WBr);
  ok('basic-wrapper-label', br && wrap && br.target === wrap);
  ok('basic-wrapper-bt', wrap && wrap.bt === WT_I32);
  ok('basic-locals-grew', localTotal(w.funcDefs[g]) === 1);
  ok('basic-stats', st.inlined === 1);
}

// ---- B. multi-arg drain: reverse-order sets, args stay put once ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32, WT_I32, WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.localGet(1); b.aop(WT_I32, ALU.OP_SUB);
    b.localGet(2); b.aop(WT_I32, ALU.OP_SUB); b.ret();
  });
  // caller has 1 param + 1 declared local -> offset 2
  const g = addFn(w, { params: [WT_I32], results: [WT_I32], locals: [{ type: WT_I32, count: 1 }] }, b => {
    b.i32Const(100); b.i32Const(20); b.i32Const(3); b.call(f); b.ret();
  });
  WAST.inlineFunctions(w);
  const n = w.funcDefs[g].wast;
  ok('multiarg-shape',
     shape(n) === 'WConst(100) WConst(20) WConst(3) WLocalSet(4) WLocalSet(3) WLocalSet(2) '
       + 'WBlock WLocalGet(2) WLocalGet(3) WAop WLocalGet(4) WAop WBr WEnd WReturn',
     shape(n));
  ok('multiarg-locals', localTotal(w.funcDefs[g]) === 4); // 1 declared + 3 param slots
}

// ---- C. return inside a loop -> WBr(wrapper); internal branches keep cloned labels ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.block();                       // depth 1
    b.loop();                        // depth 2
    b.localGet(0);
    b.if_(WT_EMPTY);                 // depth 3
    b.localGet(0); b.ret();          //   return INSIDE loop+if
    b.end();
    b.br(0);                         // continue -> loop
    b.end();                         // loop
    b.end();                         // block
    b.i32Const(-1); b.ret();
  });
  const g = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(5); b.call(f); b.ret();
  });
  WAST.inlineFunctions(w);
  const n = w.funcDefs[g].wast;
  const wrap = n.find(x => x instanceof WBlock);           // the spliced wrapper
  const clonedLoop = n.find(x => x instanceof WLoop);
  const brs = n.filter(x => x instanceof WBr);
  ok('retloop-count', brs.length === 3, `got ${brs.length} WBr`);
  ok('retloop-return-targets-wrapper', brs[0].target === wrap);      // the return inside the loop
  ok('retloop-continue-targets-cloned-loop', brs[1].target === clonedLoop);
  ok('retloop-tail-return-targets-wrapper', brs[2].target === wrap);
  ok('retloop-validates', (() => { try { WAST.validate(n, null); return true; } catch { return false; } })());
}

// ---- D. funcLabel-targeted branch (br to function depth) -> wrapper ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0);
    b.if_(WT_EMPTY);
    b.i32Const(7); b.br(1);          // br to FUNC label == return 7
    b.end();
    b.i32Const(0); b.ret();
  });
  const g = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(1); b.call(f); b.ret();
  });
  WAST.inlineFunctions(w);
  const n = w.funcDefs[g].wast;
  const wrap = n.find(x => x instanceof WBlock);
  const brs = n.filter(x => x instanceof WBr);
  ok('funclabel-br-targets-wrapper', brs.length === 2 && brs[0].target === wrap && brs[1].target === wrap);
}

// ---- E. standard fixed frame: verbatim splice, savedSp renumbered ----
{
  const w = mkWmod();
  // callee: param(0), savedSp local(1); the standard prologue/epilogue
  const f = addFn(w, {
    params: [WT_I32], results: [WT_I32],
    locals: [{ type: WT_I32, count: 1 }],
    meta: { frameSize: 16 },
  }, b => {
    b.globalGet(0); b.localSet(1);             // savedSp = SP
    b.localGet(1); b.i32Const(16); b.aop(WT_I32, ALU.OP_SUB); b.globalSet(0);
    b.localGet(1); b.i32Const(-16); b.aop(WT_I32, ALU.OP_ADD);
    b.localGet(0); b.mop(MOP.I32_STORE, 0, 2); // frame slot = param
    b.localGet(1); b.i32Const(-16); b.aop(WT_I32, ALU.OP_ADD);
    b.mop(MOP.I32_LOAD, 0, 2);
    b.localGet(1); b.globalSet(0);             // SP = savedSp (restore BEFORE ret)
    b.ret();
  });
  // caller: 2 params + 1 declared -> offset 3
  const g = addFn(w, { params: [WT_I32, WT_I32], results: [WT_I32], locals: [{ type: WT_I32, count: 1 }] }, b => {
    b.i32Const(11); b.call(f); b.ret();
  });
  const st = WAST.inlineFunctions(w);
  const n = w.funcDefs[g].wast;
  ok('frame-inlined', st.inlined === 1);
  const localRefs = n.filter(x => x instanceof WLocalGet || x instanceof WLocalSet).map(x => x.idx);
  // every cloned local ref shifted: param 0 -> 3, savedSp 1 -> 4
  ok('frame-renumber', localRefs.every(i => i === 3 || i === 4), JSON.stringify(localRefs));
  ok('frame-locals-grew', localTotal(w.funcDefs[g]) === 3); // 1 declared + param slot + savedSp
  // the SP restore (local.get savedSp; global.set SP) still precedes the WBr
  const brIdx = n.findIndex(x => x instanceof WBr);
  const setSp = n.findIndex((x, i) => i === brIdx - 1);
  ok('frame-restore-before-br', n[brIdx - 1].constructor.name === 'WGlobalSet'
     && n[brIdx - 2] instanceof WLocalGet && n[brIdx - 2].idx === 4);
}

// ---- F. site-level recursion: self-site refused, snapshot into others ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0);
    b.if_(WT_EMPTY);
    b.localGet(0); b.i32Const(1); b.aop(WT_I32, ALU.OP_SUB);
    b.call(0);                                   // self-recursive call
    b.drop();
    b.end();
    b.localGet(0); b.ret();
  });
  const g = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(3); b.call(f); b.ret();
  });
  const st = WAST.inlineFunctions(w);
  ok('rec-self-refused', st.refused.self === 1 && callsIn(w.funcDefs[f].wast, f) === 1);
  ok('rec-snapshot-inlined', st.inlined === 1 && callsIn(w.funcDefs[g].wast, f) === 1,
     `caller keeps exactly the snapshot's INTERNAL recursive call (got ${callsIn(w.funcDefs[g].wast, f)})`);
  ok('rec-caller-validates', (() => { try { WAST.validate(w.funcDefs[g].wast, null); return true; } catch { return false; } })());
}

// ---- G. mutual recursion (SCC > 1): single snapshots, terminates ----
{
  const w = mkWmod();
  // a() calls b, b() calls a — smallest mutual SCC
  const a = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.call(1); b.ret();
  });
  const bb = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.call(0); b.ret();
  });
  const c = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(9); b.call(a); b.ret();
  });
  const st = WAST.inlineFunctions(w);
  // Every splice took a single snapshot; internal calls remain real calls,
  // so SOME WCall into the SCC survives in c (no infinite expansion).
  ok('mutual-terminates-and-validates', (() => {
    try { WAST.validate(w.funcDefs[c].wast, null); return true; } catch { return false; }
  })());
  ok('mutual-snapshot-calls-remain', callsIn(w.funcDefs[c].wast) >= 1);
  ok('mutual-some-inlining', st.inlined >= 1);
}

// ---- H. nested composition: callee-first order (h -> g -> f DAG) ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.i32Const(1); b.aop(WT_I32, ALU.OP_ADD); b.ret();
  });
  const g = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.call(f); b.i32Const(2); b.aop(WT_I32, ALU.OP_MUL); b.ret();
  });
  const h = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(10); b.call(g); b.ret();
  });
  const st = WAST.inlineFunctions(w);
  ok('compose-two-inlines', st.inlined === 2);
  ok('compose-g-has-f-inline', callsIn(w.funcDefs[g].wast) === 0);
  ok('compose-h-fully-flat', callsIn(w.funcDefs[h].wast) === 0,
     'h must contain g\'s body WITH f already inlined (callee-first order)');
  // h grew by g's param slot + g's (post-inline) declared vector, which
  // already carries f's splice slot — 2 locals total
  ok('compose-h-locals', localTotal(w.funcDefs[h]) === 2, `got ${localTotal(w.funcDefs[h])}`);
}

// ---- I. refusal categories ----
function refusalCase(name, bucket, setup, opts) {
  const w = mkWmod();
  const extra = setup(w); // returns {callee, caller} defIdx
  const before = w.funcDefs[extra.caller].wast;
  const beforeShape = shape(before);
  const st = WAST.inlineFunctions(w, opts);
  const after = w.funcDefs[extra.caller].wast;
  const untouched = extra.stillInlines
    ? true // mixed cases assert their own counts below
    : shape(after) === beforeShape && callsIn(after, extra.callee) >= 1;
  ok(`refuse-${name}`, st.refused[bucket] >= 1 && untouched && st.inlined === (extra.expectInlined || 0),
     `refused.${bucket}=${st.refused[bucket]} inlined=${st.inlined}`);
}

refusalCase('self', 'self', (w) => {
  const f = addFn(w, { params: [], results: [] }, b => { b.call(0); b.ret(); });
  return { callee: f, caller: f };
});
refusalCase('imported', 'imported', (w) => {
  w.funcImports.push({ moduleName: 'env', functionName: 'x', typeId: 0 });
  // funcIdx 0 is the import; defined funcs start at 1
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(0); b.ret(); });
  return { callee: 0, caller }; // the import's funcIdx — the call must survive
});
refusalCase('noBody', 'noBody', (w) => {
  const f = addFn(w, { params: [], results: [] }, null); // raw body: wast/fnMeta null
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('variadic', 'variadic', (w) => {
  const f = addFn(w, { params: [WT_I32], results: [], meta: { variadic: true } }, b => { b.ret(); });
  const caller = addFn(w, { params: [], results: [] }, b => { b.i32Const(0); b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('alloca', 'alloca', (w) => {
  const f = addFn(w, { params: [], results: [], meta: { usesAlloca: true } }, b => { b.ret(); });
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('overAligned', 'overAligned', (w) => {
  const f = addFn(w, { params: [], results: [], meta: { frameSize: 64, overAligned: true } }, b => { b.ret(); });
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('structRet', 'structRet', (w) => {
  const f = addFn(w, { params: [WT_I32], results: [WT_I32], meta: { structRet: true } }, b => {
    b.localGet(0); b.ret();
  });
  const caller = addFn(w, { params: [], results: [] }, b => { b.i32Const(0); b.call(f); b.drop(); b.ret(); });
  return { callee: f, caller };
});
refusalCase('eh-trytable', 'eh', (w) => {
  const f = addFn(w, { params: [], results: [] }, b => {
    b.tryTable(WT_EMPTY, []); b.end(); b.ret();
  });
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('eh-throw', 'eh', (w) => {
  const f = addFn(w, { params: [], results: [] }, b => { b.throw_(0); });
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('raw', 'raw', (w) => {
  const f = addFn(w, { params: [], results: [] }, b => { b.push(0x01); b.ret(); }); // WRaw nop
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.ret(); });
  return { callee: f, caller };
});
refusalCase('multiResult', 'multiResult', (w) => {
  const f = addFn(w, { params: [], results: [WT_I32, WT_I32] }, b => {
    b.i32Const(1); b.i32Const(2); b.ret();
  });
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.drop(); b.drop(); b.ret(); });
  return { callee: f, caller };
});
refusalCase('budgetCallee', 'budgetCallee', (w) => {
  const f = addFn(w, { params: [], results: [WT_I32] }, b => {
    for (let i = 0; i < 10; i++) { b.i32Const(i); b.drop(); }
    b.i32Const(0); b.ret();
  });
  const caller = addFn(w, { params: [], results: [] }, b => { b.call(f); b.drop(); b.ret(); });
  return { callee: f, caller };
}, { calleeCap: 8 });

// budgetCallee counts REAL nodes (WSrcLoc markers are free), and clones
// DROP the callee's markers: the flat c.sourcemap has no inline-frame
// concept, so inlined instructions attribute to the CALL SITE (the
// caller's own last marker) — tests/sourcemap/line_numbers pins the
// no-cross-function-lines invariant this preserves.
{
  const w = mkWmod();
  const f = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.srcLoc(0, 1); b.i32Const(1); b.srcLoc(0, 2); b.i32Const(2);
    b.aop(WT_I32, ALU.OP_ADD); b.srcLoc(0, 3); b.ret();
  }); // 4 real nodes, 3 srcloc
  const g = addFn(w, { params: [], results: [WT_I32] }, b => { b.call(f); b.ret(); });
  const st = WAST.inlineFunctions(w, { calleeCap: 4 });
  const cloneSrcLocs = w.funcDefs[g].wast.filter(x => x instanceof WSrcLoc).length;
  ok('budget-real-nodes-only', st.inlined === 1,
     `srcloc must not count against calleeCap (inlined=${st.inlined})`);
  ok('clone-drops-srcloc', cloneSrcLocs === 0,
     `callee markers must not leak into the caller (got ${cloneSrcLocs})`);
}

// budgetCaller: first site fits, second exceeds the growth ceiling
{
  const w = mkWmod();
  const f = addFn(w, { params: [], results: [WT_I32] }, b => {
    for (let i = 0; i < 4; i++) { b.i32Const(i); b.drop(); }
    b.i32Const(0); b.ret();
  }); // 10 real nodes
  const g = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.call(f); b.drop(); b.call(f); b.ret();
  });
  const st = WAST.inlineFunctions(w, { calleeCap: 64, callerGrowth: 15 });
  ok('budget-caller-ceiling', st.inlined === 1 && st.refused.budgetCaller === 1
     && callsIn(w.funcDefs[g].wast, f) === 1,
     `inlined=${st.inlined} budgetCaller=${st.refused.budgetCaller}`);
}

// enabled:false is a global no-op
{
  const w = mkWmod();
  const f = addFn(w, { params: [], results: [WT_I32] }, b => { b.i32Const(1); b.ret(); });
  const g = addFn(w, { params: [], results: [WT_I32] }, b => { b.call(f); b.ret(); });
  const st = WAST.inlineFunctions(w, { enabled: false });
  ok('disabled-noop', st.inlined === 0 && callsIn(w.funcDefs[g].wast, f) === 1);
}

// ---- J. runPasses ordering: inline first, THEN fold inside the clone ----
{
  const w = mkWmod();
  const f = addFn(w, { params: [WT_I32], results: [WT_I32] }, b => {
    b.localGet(0); b.i32Const(8); b.aop(WT_I32, ALU.OP_ADD);
    b.mop(MOP.I32_LOAD, 0, 2); b.ret();
  });
  const g = addFn(w, { params: [], results: [WT_I32] }, b => {
    b.i32Const(100); b.call(f); b.ret();
  });
  WAST.runPasses(w);
  const gn = w.funcDefs[g].wast;
  const fn = w.funcDefs[f].wast;
  const gMop = gn.find(x => x instanceof WMop);
  const fMop = fn.find(x => x instanceof WMop);
  // both copies folded independently to off=8, and no WConst(8) leftovers
  ok('order-clone-folded', gMop && gMop.offset === 8 && !gn.some(x => x instanceof WConst && x.value === 8),
     shape(gn));
  ok('order-original-folded', fMop && fMop.offset === 8);
  ok('order-fresh-instances', gMop !== fMop, 'clone must not share WMop instances with the callee');
  ok('order-stats', w.passStats.inline.inlined === 1 && w.passStats.offsetFolds === 2);
}

// ---- K. end-to-end C execution (compile in-process, run under host.js) ----

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wast-inline-'));

function compileC(src, name) {
  const file = path.join(TMP, name + '.c');
  fs.writeFileSync(file, src);
  const pp = C.createDefaultPPRegistry();
  pp.fileReader = (fp) => { try { return fs.readFileSync(fp, 'utf-8'); } catch { return null; } };
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };
  const compilerOptions = {
    debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
    allowKnRDefinitions: false, allowImplicitFunctionDecl: false, allowUndefined: false,
    allowZeroLengthArrays: false, gcSections: false, gcNoExportRoots: false,
    noUndefined: false, timeReport: false, requireSources: [], backend: 'default',
  };
  const units = C.parseAllUnits(fs, pp, [file], { warningFlags, compilerOptions });
  const link = C.linkTranslationUnits(units, compilerOptions);
  if (link.errors.length) throw new Error('link: ' + link.errors.map(e => e.message).join('; '));
  const wasm = C.generateCode(units, path.join(TMP, name + '.wasm'), {
    compilerOptions, warningFlags,
    fatalExit: (code) => { throw new Error('codegen fatal ' + code); },
  });
  fs.writeFileSync(path.join(TMP, name + '.wasm'), wasm);
  return { wasmPath: path.join(TMP, name + '.wasm'), stats: C.WAST.lastPassStats.inline };
}
function runWasm(wasmPath) {
  return execFileSync('node', [path.join(ROOT, 'host.js'), wasmPath], { encoding: 'utf8' });
}

// eval-once + source order: side effects of args print exactly once, in order
{
  const { wasmPath, stats } = compileC(`
#include <stdio.h>
int combine(int a, int b) { int s = a * 10; s += b; if (s < 0) { return 0; } return s; }
int side(int x) { printf("eval%d\\n", x); return x; }
int main() { printf("r=%d\\n", combine(side(1), side(2))); return 0; }
`, 'evalonce');
  const out = runWasm(wasmPath);
  ok('exec-evalonce', out === 'eval1\neval2\nr=12\n', JSON.stringify(out));
  ok('exec-evalonce-inlined', stats.inlined > 0);
}

// return inside a loop in the callee
{
  const { wasmPath } = compileC(`
#include <stdio.h>
int firstsq(int n) { for (int i = 0; i < 100; i++) { if (i * i >= n) return i; } return -1; }
int main() { printf("%d %d %d\\n", firstsq(17), firstsq(1), firstsq(0)); return 0; }
`, 'retloop');
  ok('exec-return-in-loop', runWasm(wasmPath) === '5 1 0\n');
}

// fixed-frame callee inlined into a fixed-frame caller: nested frames stay intact
{
  const { wasmPath } = compileC(`
#include <stdio.h>
int sum3(int x) { int a[3]; a[0] = x; a[1] = x + 1; a[2] = x + 2; int *p = a; return p[0] + p[1] + p[2]; }
int main() { int b[2]; b[0] = sum3(10); b[1] = sum3(20); int *q = b; printf("%d %d\\n", q[0], q[1]); return 0; }
`, 'frames');
  ok('exec-nested-frames', runWasm(wasmPath) === '33 63\n');
}

// recursion snapshot: fact inlines ONE level into main, internal call recurses
{
  const { wasmPath, stats } = compileC(`
#include <stdio.h>
int fact(int n) { if (n < 2) return 1; return n * fact(n - 1); }
int main() { printf("%d\\n", fact(6)); return 0; }
`, 'fact');
  ok('exec-recursion-snapshot', runWasm(wasmPath) === '720\n');
  ok('exec-recursion-self-refused', stats.refused.self >= 1);
}

fs.rmSync(TMP, { recursive: true, force: true });

if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('all WAST inline tests passed');
