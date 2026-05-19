#!/usr/bin/env node
"use strict";

// Tests for c1.js. Run with: node tests-c1.js
const fs = require('fs');
const srcText = fs.readFileSync(__dirname + '/c1.js', 'utf8').replace(/^#![^\n]*\n/, '');
const { AST, CFG, PARSER, CODEGEN } =
  new Function(srcText + '\n;return { AST, CFG, PARSER, CODEGEN };')();
const TYPE = AST.TYPE;
// Test-local aliases for the old names — keeps the bulk of the tests
// readable while the modules themselves moved into their namespaces.
const lowerToCFG = CFG.fromAST;
const liftToAST = CFG.intoAST;
const emitWasm = (p) => CODEGEN.emit(p).bytes;

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
const run = (bytes, name, ...args) => {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  return inst.exports[name](...args);
};
const direct = (source) => emitWasm(PARSER.parse(source));
const roundTrip = (source) => emitWasm(liftToAST(lowerToCFG(PARSER.parse(source))));

// ─── canonical sources (same as c0's) ───
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

// ─── existing c0 tests, ported ───

t('TYPE.of with && || ?:', () => {
  const L32 = new AST.Literal(null, 'i32', 5);
  const Lf64 = new AST.Literal(null, 'f64', 1.5);
  eq(TYPE.of(new AST.Binary(null, '&&', L32, L32)), 'i32');
  eq(TYPE.of(new AST.Binary(null, '||', L32, L32)), 'i32');
  eq(TYPE.of(new AST.Ternary(null, L32, Lf64, Lf64)), 'f64');
});

t('parser handles structured sum', () => {
  const prog = PARSER.parse(SUM_STRUCTURED);
  eq(prog.functions[0].name, 'sum');
});

t('parser: precedence (&& binds tighter than ||)', () => {
  // 0 && 1 || 1   should parse as   (0 && 1) || 1   → evaluates to 1
  eq(run(direct(`i32 f(){return 0 && 1 || 1;}`), 'f'), 1);
});
t('parser: ?: is right-associative and lowest', () => {
  // 1 ? 2 : 3 + 4   →   1 ? 2 : (3+4)   →   2
  eq(run(direct(`i32 f(){return 1 ? 2 : 3 + 4;}`), 'f'), 2);
  // 0 ? 1 : 0 ? 2 : 3   →   0 ? 1 : (0 ? 2 : 3)   →   3
  eq(run(direct(`i32 f(){return 0 ? 1 : 0 ? 2 : 3;}`), 'f'), 3);
});

// ─── direct emit of new operators ───

t('direct emit: && / || short-circuit semantics', () => {
  const bytes = direct(`
    i32 and1(){return 5 && 7;}
    i32 and2(){return 0 && 7;}
    i32 and3(){return 5 && 0;}
    i32 or1(){return 0 || 7;}
    i32 or2(){return 0 || 0;}
    i32 or3(){return 3 || 0;}
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.and1(), 1);
  eq(m.exports.and2(), 0);
  eq(m.exports.and3(), 0);
  eq(m.exports.or1(), 1);
  eq(m.exports.or2(), 0);
  eq(m.exports.or3(), 1);
});
t('direct emit: ?: works on i32 and f64', () => {
  const bytes = direct(`
    i32 pick(i32 c) { return c ? 42 : 99; }
    f64 pickf(i32 c) { return c ? 1.5 : 2.5; }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.pick(1), 42);
  eq(m.exports.pick(0), 99);
  eq(m.exports.pickf(1), 1.5);
  eq(m.exports.pickf(0), 2.5);
});
t('direct emit: structured / while-switch sum(10) = 45', () => {
  eq(run(direct(SUM_STRUCTURED), 'sum', 10), 45);
  eq(run(direct(SUM_WHILESWITCH), 'sum', 10), 45);
});
t('direct emit rejects goto', () => {
  throws(() => direct(SUM_GOTO), /Label\/Goto/);
});

// ─── TAC CFG shape ───

t('CFG is TAC: blocks hold instructions with dest + operands', () => {
  const fn = lowerToCFG(PARSER.parse(`i32 f(i32 a, i32 b){return a + b;}`)).functions[0];
  // entry should contain one BinaryOp(__t0 = a + b) then Return(__t0).
  const insts = fn.entry.instructions;
  eq(insts.length, 1);
  eq(insts[0] instanceof CFG.BinaryOp, true);
  eq(insts[0].op, '+');
  eq(insts[0].lhs === fn.params[0], true);    // identity check, not name
  eq(insts[0].rhs === fn.params[1], true);
  eq(insts[0].dest instanceof AST.Variable, true);
  eq(insts[0].dest.type, 'i32');
  // Return.value references the dest VReg, not an expression tree.
  const term = fn.entry.terminator;
  eq(term instanceof CFG.Return, true);
  eq(term.value === insts[0].dest, true);
});
t('CFG has no statement-CFG primitives (Assign in blocks)', () => {
  const fn = lowerToCFG(PARSER.parse(`i32 f(i32 a){return a;}`)).functions[0];
  for (const ins of fn.entry.instructions) {
    if (ins instanceof AST.Assign) throw new Error('TAC CFG should not contain AST.Assign');
  }
});
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
t('lowerToCFG: && / || open extra blocks', () => {
  const fnSimple = lowerToCFG(PARSER.parse(`i32 f(i32 a){return a;}`)).functions[0];
  const fnAnd = lowerToCFG(PARSER.parse(`i32 f(i32 a, i32 b){return a && b;}`)).functions[0];
  // Short-circuit lowering adds basic blocks (seed/rhs/flip/exit) compared
  // to the no-op baseline.
  if (fnAnd.blocks.length <= fnSimple.blocks.length) {
    throw new Error(`expected more blocks for &&: got ${fnAnd.blocks.length}, baseline ${fnSimple.blocks.length}`);
  }
});

// ─── round-trip (parse → lower → lift → emit) ───

t('round-trip: structured sum(10) = 45', () => eq(run(roundTrip(SUM_STRUCTURED), 'sum', 10), 45));
t('round-trip: while-switch sum(10) = 45', () => eq(run(roundTrip(SUM_WHILESWITCH), 'sum', 10), 45));
t('round-trip: goto sum(10) = 45', () => eq(run(roundTrip(SUM_GOTO), 'sum', 10), 45));
t('round-trip: sum across edge values', () => {
  const bytes = roundTrip(SUM_GOTO);
  for (const [n, want] of [[0, 0], [1, 0], [2, 1], [10, 45], [100, 4950]]) {
    eq(run(bytes, 'sum', n), want, `sum(${n})`);
  }
});

t('round-trip: && / || short-circuit semantics preserved', () => {
  const bytes = roundTrip(`
    i32 and1(){return 5 && 7;}
    i32 and2(){return 0 && 7;}
    i32 or1(){return 0 || 7;}
    i32 or2(){return 0 || 0;}
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.and1(), 1);
  eq(m.exports.and2(), 0);
  eq(m.exports.or1(), 1);
  eq(m.exports.or2(), 0);
});
t('round-trip: ?: through TAC', () => {
  const bytes = roundTrip(`
    i32 pick(i32 c) { return c ? 42 : 99; }
    f64 pickf(i32 c) { return c ? 1.5 : 2.5; }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.pick(1), 42);
  eq(m.exports.pick(0), 99);
  eq(m.exports.pickf(1), 1.5);
  eq(m.exports.pickf(0), 2.5);
});

// ─── type coverage through lift ───

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

// ─── idempotency ───

t('5× repeated round-trips on goto source still pass', () => {
  let prog = PARSER.parse(SUM_GOTO);
  for (let k = 0; k < 5; k++) {
    prog = liftToAST(lowerToCFG(prog));
    eq(run(emitWasm(prog), 'sum', 10), 45, `after ${k + 1}× round-trip`);
  }
});
t('5× repeated round-trips on && / || source still pass', () => {
  let prog = PARSER.parse(`
    i32 f(i32 a, i32 b) { return a && b || a; }
  `);
  for (let k = 0; k < 5; k++) {
    prog = liftToAST(lowerToCFG(prog));
    const m = new WebAssembly.Instance(new WebAssembly.Module(emitWasm(prog)));
    eq(m.exports.f(3, 5), 1, `after ${k + 1}× round-trip: f(3,5)`);
    eq(m.exports.f(0, 0), 0, `after ${k + 1}× round-trip: f(0,0)`);
    eq(m.exports.f(0, 7), 0, `after ${k + 1}× round-trip: f(0,7)`);
  }
});

// ─── function calls ───

t('parser: self-recursive call resolves (prototype registered before body)', () => {
  const prog = PARSER.parse(`
    i32 fact(i32 n) {
      if (n <= 1) { return 1; }
      return n * fact(n - 1);
    }
  `);
  eq(prog.functions[0].name, 'fact');
});
t('parser: forward decl enables mutual recursion', () => {
  PARSER.parse(`
    i32 even(i32 n);
    i32 odd(i32 n) { if (n == 0) { return 0; } return even(n - 1); }
    i32 even(i32 n) { if (n == 0) { return 1; } return odd(n - 1); }
  `);
});
t('parser: undeclared call → error', () => {
  throws(() => PARSER.parse(`i32 g(){return f(1);}`), /undeclared function 'f'/);
});
t('parser: arg count mismatch → error', () => {
  throws(() => PARSER.parse(`
    i32 f(i32 a, i32 b) { return a + b; }
    i32 g() { return f(1); }
  `), /expected 2 arg/);
});
t('parser: arg type mismatch → error', () => {
  throws(() => PARSER.parse(`
    i32 f(i32 x) { return x; }
    i32 g() { return f(1.5); }
  `), /expected i32, got f64/);
});
t('parser: conflicting prototype → error', () => {
  throws(() => PARSER.parse(`
    i32 f(i32);
    f64 f(i32 x) { return 0.0; }
  `), /Conflicting declarations/);
});
t('parser: forward decl without definition → error', () => {
  throws(() => PARSER.parse(`
    i32 f(i32);
    i32 g(i32 x) { return x; }
  `), /forward declaration without a definition/);
});
t('parser: AST.Call.callee is the AST.Function (not a name)', () => {
  const prog = PARSER.parse(`
    i32 g(i32 x) { return x + 1; }
    i32 h(i32 y) { return g(y); }
  `);
  const g = prog.functions.find((f) => f.name === 'g');
  const h = prog.functions.find((f) => f.name === 'h');
  // h's body contains: return g(y);
  const ret = h.body.statements[0];
  eq(ret.constructor.name, 'Return');
  eq(ret.value instanceof AST.Call, true);
  eq(ret.value.callee === g, true);            // identity, not name
  // Drop of the redundant cached field — return type is reachable
  // through callee.
  eq('returnType' in ret.value, false);
  eq(TYPE.of(ret.value), 'i32');
});
t('parser: forward decl + definition share the same Function object', () => {
  // Inside `caller`, the call to `f` resolves against the forward-decl
  // Function. Once `f` is defined, that SAME object gains a body and
  // shows up in program.functions.
  const prog = PARSER.parse(`
    i32 f(i32);
    i32 caller(i32 x) { return f(x); }
    i32 f(i32 x) { return x + 1; }
  `);
  const f = prog.functions.find((fn) => fn.name === 'f');
  const caller = prog.functions.find((fn) => fn.name === 'caller');
  const callExpr = caller.body.statements[0].value;
  eq(callExpr.callee === f, true);             // call's callee IS the defined f
  eq(f.body !== null, true);
});

t('direct emit: factorial via self-recursion', () => {
  const bytes = direct(`
    i32 fact(i32 n) {
      if (n <= 1) { return 1; }
      return n * fact(n - 1);
    }
  `);
  eq(run(bytes, 'fact', 5), 120);
  eq(run(bytes, 'fact', 10), 3628800);
});
t('direct emit: mutual recursion via forward decl', () => {
  const bytes = direct(`
    i32 even(i32 n);
    i32 odd(i32 n) { if (n == 0) { return 0; } return even(n - 1); }
    i32 even(i32 n) { if (n == 0) { return 1; } return odd(n - 1); }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.even(10), 1);
  eq(m.exports.even(7), 0);
  eq(m.exports.odd(7), 1);
});
t('direct emit: expression statement discards return value', () => {
  // `inner(x);` runs but result is dropped; only the trailing return counts.
  const bytes = direct(`
    i32 inner(i32 x) { return x + 100; }
    i32 driver(i32 x) {
      inner(x);
      return inner(x);
    }
  `);
  eq(run(bytes, 'driver', 5), 105);
});

// ─── CFG.Call shape ───

t('CFG.Call.callee is a CFG.Function reference (not a name)', () => {
  const mod = lowerToCFG(PARSER.parse(`
    i32 inner(i32 x) { return x + 1; }
    i32 outer(i32 y) { return inner(y); }
  `));
  const inner = mod.functions.find((f) => f.name === 'inner');
  const outer = mod.functions.find((f) => f.name === 'outer');
  const calls = outer.entry.instructions.filter((i) => i instanceof CFG.Call);
  eq(calls.length, 1);
  eq(calls[0].callee === inner, true);              // identity, not name
  eq(calls[0].callee instanceof CFG.Function, true);
  eq(calls[0].args.length, 1);
  eq(calls[0].args[0] === outer.params[0], true);   // identity: passed the y param
  eq(calls[0].dest instanceof AST.Variable, true);
  eq(calls[0].dest.type, 'i32');
});

// ─── round-trip through TAC for calls ───

t('round-trip: factorial', () => {
  const bytes = roundTrip(`
    i32 fact(i32 n) {
      if (n <= 1) { return 1; }
      return n * fact(n - 1);
    }
  `);
  eq(run(bytes, 'fact', 5), 120);
  eq(run(bytes, 'fact', 10), 3628800);
});
t('round-trip: mutual recursion', () => {
  const bytes = roundTrip(`
    i32 even(i32 n);
    i32 odd(i32 n) { if (n == 0) { return 0; } return even(n - 1); }
    i32 even(i32 n) { if (n == 0) { return 1; } return odd(n - 1); }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.even(20), 1);
  eq(m.exports.odd(15), 1);
});
t('round-trip: expression statement preserves side effect', () => {
  const bytes = roundTrip(`
    i32 inner(i32 x) { return x + 100; }
    i32 driver(i32 x) {
      inner(x);
      return inner(x);
    }
  `);
  eq(run(bytes, 'driver', 5), 105);
});
t('5× repeated round-trips on a call-heavy program still pass', () => {
  let prog = PARSER.parse(`
    i32 add(i32 a, i32 b) { return a + b; }
    i32 sumto(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) { total = add(total, i); i = i + 1; }
      return total;
    }
  `);
  for (let k = 0; k < 5; k++) {
    prog = liftToAST(lowerToCFG(prog));
    const m = new WebAssembly.Instance(new WebAssembly.Module(emitWasm(prog)));
    eq(m.exports.sumto(10), 45, `after ${k + 1}× round-trip`);
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
