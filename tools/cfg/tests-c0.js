#!/usr/bin/env node
"use strict";

// Tests for c0.js. Run with: node tests.js
//
// c0.js doesn't export anything (it's a script of top-level `const`s), so we
// load it by reading the source, stripping the shebang, and eval'ing it
// inside a `new Function(...)` that returns the modules we want.
const fs = require('fs');
const srcText = fs.readFileSync(__dirname + '/c0.js', 'utf8').replace(/^#![^\n]*\n/, '');
const { AST, CFG, PARSER, CODEGEN } =
  new Function(srcText + '\n;return { AST, CFG, PARSER, CODEGEN };')();
const TYPE = AST.TYPE;
// Test-local aliases for the old names — keeps the bulk of the tests
// readable while the modules themselves moved into their namespaces.
const lowerToCFG = CFG.fromAST;
const liftToAST = CFG.intoAST;
const emitWasm = CODEGEN.emit;

// ─── tiny test harness ───
const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const eq = (a, b, msg = '') => {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}${msg ? ' — ' + msg : ''}`);
};
const throws = (fn, re) => {
  try { fn(); } catch (e) { if (!re || re.test(e.message)) return; throw new Error(`threw "${e.message}" — expected match ${re}`); }
  throw new Error('expected throw, got nothing');
};

// ─── pipeline helpers ───
const run = (bytes, exportName, ...args) => {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  return inst.exports[exportName](...args);
};
const direct = (source) => emitWasm(PARSER.parse(source)).bytes;
const roundTrip = (source) => emitWasm(liftToAST(lowerToCFG(PARSER.parse(source)))).bytes;

// ─── canonical sources ───
const SUM_STRUCTURED = `
  i32 sum(i32 n) {
    i32 total = 0;
    i32 i = 0;
    while (1) {
      if (i >= n) { return total; }
      total = total + i;
      i = i + 1;
    }
  }
`;
const SUM_WHILESWITCH = `
  i32 sum(i32 n) {
    i32 total = 0;
    i32 i = 0;
    i32 state = 0;
    while (1) {
      switch (state) {
        case 0: state = 1; break;
        case 1:
          if (i >= n) { state = 3; } else { state = 2; }
          break;
        case 2:
          total = total + i;
          i = i + 1;
          state = 1;
          break;
        case 3:
          return total;
      }
    }
  }
`;
const SUM_GOTO = `
  i32 sum(i32 n) {
    i32 total = 0;
    i32 i = 0;
    loop:
    if (i >= n) { goto end; }
    total = total + i;
    i = i + 1;
    goto loop;
    end:
    return total;
  }
`;

// ─── TYPE.of ───
t('TYPE.of basics', () => {
  const L32 = new AST.Literal(null, 'i32', 5);
  const L64 = new AST.Literal(null, 'i64', 5n);
  const Lf64 = new AST.Literal(null, 'f64', 1.5);
  eq(TYPE.of(L32), 'i32');
  eq(TYPE.of(L64), 'i64');
  eq(TYPE.of(Lf64), 'f64');
  eq(TYPE.of(new AST.Binary(null, '+', L32, L32)), 'i32');
  eq(TYPE.of(new AST.Binary(null, '<', L32, L32)), 'i32'); // comparison → i32
  eq(TYPE.of(new AST.Binary(null, '+', Lf64, Lf64)), 'f64');
  eq(TYPE.of(new AST.Unary(null, '-', Lf64)), 'f64');
  eq(TYPE.of(new AST.Unary(null, '!', L32)), 'i32');
});

// ─── parser ───
t('parser handles structured sum', () => {
  const prog = PARSER.parse(SUM_STRUCTURED);
  eq(prog.functions.length, 1);
  eq(prog.functions[0].name, 'sum');
  eq(prog.functions[0].returnType, 'i32');
  eq(prog.functions[0].parameters.length, 1);
  eq(prog.functions[0].parameters[0].type, 'i32');
});
t('parser produces flat labels', () => {
  const stmts = PARSER.parse(SUM_GOTO).functions[0].body.statements;
  const kinds = stmts.map((s) => s.constructor.name);
  eq(kinds.includes('Label'), true);
  eq(kinds.includes('Goto'), true);
  // Labels are markers, not containers.
  const label = stmts.find((s) => s instanceof AST.Label);
  eq(Object.prototype.hasOwnProperty.call(label, 'block'), false);
});
t('parser rejects duplicate locals', () => {
  throws(() => PARSER.parse(`i32 f(){i32 x=0;i32 x=1;return x;}`), /[Dd]uplicate/);
});
t('parser rejects undefined variable', () => {
  throws(() => PARSER.parse(`i32 f(){return x;}`), /[Uu]ndefined/);
});

// ─── direct emit ───
t('direct emit: structured sum(10) = 45', () => {
  eq(run(direct(SUM_STRUCTURED), 'sum', 10), 45);
});
t('direct emit: while-switch sum(10) = 45', () => {
  eq(run(direct(SUM_WHILESWITCH), 'sum', 10), 45);
});
t('direct emit rejects goto', () => {
  throws(() => direct(SUM_GOTO), /Label\/Goto/);
});

// ─── lowerToCFG ───
t('lowerToCFG: every block has a terminator', () => {
  for (const src of [SUM_STRUCTURED, SUM_WHILESWITCH, SUM_GOTO]) {
    const mod = lowerToCFG(PARSER.parse(src));
    for (const fn of mod.functions) {
      for (const b of fn.blocks) {
        if (!b.terminator) throw new Error(`fn ${fn.name} block ${b.name} has no terminator`);
      }
    }
  }
});
t('lowerToCFG: blocks hold AST statements, not stack-machine ops', () => {
  const fn = lowerToCFG(PARSER.parse(`i32 f(i32 a, i32 b){return a + b;}`)).functions[0];
  // entry has no straight-line stmts; the Return terminator carries the
  // full expression tree directly.
  eq(fn.entry.statements.length, 0);
  eq(fn.entry.terminator instanceof CFG.Return, true);
  eq(fn.entry.terminator.value instanceof AST.Binary, true);
  eq(fn.entry.terminator.value.op, '+');
  // No stack-machine instruction classes anymore.
  eq(CFG.BinaryOp, undefined);
  eq(CFG.Const, undefined);
  eq(CFG.LocalGet, undefined);
});
t('lowerToCFG: BrIf cond is an AST expression', () => {
  const fn = lowerToCFG(PARSER.parse(`
    i32 g(i32 x) { if (x >= 0) { return x; } return 0; }
  `)).functions[0];
  // entry should terminate with a BrIf carrying the >= expression.
  eq(fn.entry.terminator instanceof CFG.BrIf, true);
  eq(fn.entry.terminator.cond instanceof AST.Binary, true);
  eq(fn.entry.terminator.cond.op, '>=');
});
t('lowerToCFG: function carries AST.Variable[] for params + locals', () => {
  const fn = lowerToCFG(PARSER.parse(`
    i32 h(i32 a) { i32 b = a + 1; return b; }
  `)).functions[0];
  eq(fn.params.length, 1);
  eq(fn.params[0] instanceof AST.Variable, true);
  eq(fn.params[0].name, 'a');
  eq(fn.locals.length, 1);
  eq(fn.locals[0].name, 'b');
  eq(fn.locals[0].type, 'i32');
});

// ─── liftToAST + round-trip ───
t('round-trip: structured sum(10) = 45', () => eq(run(roundTrip(SUM_STRUCTURED), 'sum', 10), 45));
t('round-trip: while-switch sum(10) = 45', () => eq(run(roundTrip(SUM_WHILESWITCH), 'sum', 10), 45));
t('round-trip: goto sum(10) = 45', () => eq(run(roundTrip(SUM_GOTO), 'sum', 10), 45));
t('round-trip: sum across edge values', () => {
  const bytes = roundTrip(SUM_GOTO);
  for (const [n, want] of [[0, 0], [1, 0], [2, 1], [10, 45], [100, 4950]]) {
    eq(run(bytes, 'sum', n), want, `sum(${n})`);
  }
});

// ─── type coverage through lift path ───
t('lifted: i32 / i64 / f64 ops', () => {
  const bytes = roundTrip(`
    i32 sq(i32 x) { return x * x; }
    i64 mul64(i64 a, i64 b) { return a * b; }
    f64 mean(f64 a, f64 b) { return (a + b) / 2.0; }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.sq(7), 49);
  eq(m.exports.mul64(123n, 456n), 56088n);
  eq(m.exports.mean(3.0, 5.0), 4.0);
});
t('lifted: unary ! and float neg', () => {
  const bytes = roundTrip(`
    i32 isZero(i32 x) { if (!x) { return 1; } return 0; }
    f64 negf(f64 x) { return -x; }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.isZero(0), 1);
  eq(m.exports.isZero(5), 0);
  eq(m.exports.negf(3.5), -3.5);
});

// ─── idempotency: repeated round-trips ───
t('5× repeated round-trips on goto source still pass', () => {
  let prog = PARSER.parse(SUM_GOTO);
  for (let k = 0; k < 5; k++) {
    prog = liftToAST(lowerToCFG(prog));
    eq(run(emitWasm(prog).bytes, 'sum', 10), 45, `after ${k + 1}× round-trip`);
  }
});

// ─── runner ───
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok      ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL    ${name}\n        ${e.message}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
