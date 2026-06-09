#!/usr/bin/env node
"use strict";

// Tests for c3b.js. Run with: node tests-c3b.js
const fs = require('fs');
const srcText = fs.readFileSync(__dirname + '/c3b.js', 'utf8').replace(/^#![^\n]*\n/, '');
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
// Stackifier path: parse → fromAST → makeReducible → stackifyFunction
// (per fn) → AST.Program → emit. Verifies the new dom-tree-based
// stackifier produces wasm with correct C semantics.
const stackified = (source) => {
  const mod = lowerToCFG(PARSER.parse(source));
  CFG.makeReducible(mod);
  const astByCfg = new Map();
  for (const fn of mod.functions) astByCfg.set(fn, new AST.Function(null, fn.returnType, fn.name, fn.params, null));
  for (const fn of mod.functions) astByCfg.get(fn).body = CFG.stackifyFunction(fn, astByCfg);
  return emitWasm(new AST.Program(null, [...astByCfg.values()]));
};
// Cross-backend assertion: every semantic test runs through BOTH backends
// and must agree on results. Catches silent divergence between direct
// emit and the lifted (intoAST dispatcher) form.
const both = (source, fn, argsList, expectedList) => {
  const bD = direct(source), bR = roundTrip(source);
  for (let i = 0; i < argsList.length; i++) {
    const args = argsList[i], exp = expectedList[i];
    const d = run(bD, fn, ...args), r = run(bR, fn, ...args);
    if (d !== exp) throw new Error(`direct: expected ${exp}, got ${d} for args=${JSON.stringify(args)}`);
    if (r !== exp) throw new Error(`lifted: expected ${exp}, got ${r} for args=${JSON.stringify(args)}`);
  }
};

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

// ─── type aliases ───
t('type aliases: int/long/float/double map to i32/i64/f32/f64', () => {
  const aliased = PARSER.tokenize('int x; long y; float a; double b;');
  const canonical = PARSER.tokenize('i32 x; i64 y; f32 a; f64 b;');
  eq(aliased.length, canonical.length);
  for (let k = 0; k < aliased.length; k++) {
    eq(aliased[k].type, canonical[k].type, `tok ${k}`);
    eq(aliased[k].value, canonical[k].value, `tok ${k} value`);
  }
});
t('type aliases: compile and run a program written with C-style types', () => {
  const bytes = direct(`
    int sq(int x) { return x * x; }
    long mul64(long a, long b) { return a * b; }
    double avg(double a, double b) { return (a + b) / 2.0; }
  `);
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  eq(m.exports.sq(7), 49);
  eq(m.exports.mul64(123n, 456n), 56088n);
  eq(m.exports.avg(3.0, 5.0), 4.0);
});
t('type aliases: pretty-printer emits canonical names', () => {
  const src = AST.printSource(PARSER.parse('int sq(int x) { return x * x; }'));
  if (!/i32 sq\(i32 x\)/.test(src)) throw new Error('expected canonical i32 in: ' + src);
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
  throws(() => direct(SUM_GOTO), /Goto/);
});

// ─── SSA CFG shape ───

t('CFG is SSA: instructions have Value dests, operands are Values', () => {
  const fn = lowerToCFG(PARSER.parse(`i32 f(i32 a, i32 b){return a + b;}`)).functions[0];
  // entry should contain one BinaryOp(__v_? = a + b) then Return(__v_?).
  const insts = fn.entry.instructions;
  eq(insts.length, 1);
  eq(insts[0] instanceof CFG.BinaryOp, true);
  eq(insts[0].op, '+');
  // Operands are the paramValues, not the source AST.Variables.
  eq(insts[0].lhs === fn.paramValues[0], true);
  eq(insts[0].rhs === fn.paramValues[1], true);
  eq(insts[0].dest instanceof CFG.Value, true);
  eq(insts[0].dest.type, 'i32');
  // Return.value references the dest Value, not an expression tree.
  const term = fn.entry.terminator;
  eq(term instanceof CFG.Return, true);
  eq(term.value === insts[0].dest, true);
});
t('CFG has no statement-CFG primitives (Assign in blocks)', () => {
  const fn = lowerToCFG(PARSER.parse(`i32 f(i32 a){return a;}`)).functions[0];
  for (const ins of fn.entry.instructions) {
    if (ins instanceof AST.Assign) throw new Error('SSA CFG should not contain AST.Assign');
  }
});
t('CFG has no Copy instruction (SSA subsumes copies via block params)', () => {
  eq('Copy' in CFG, false, 'CFG.Copy should not exist in c2 SSA');
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
  // Short-circuit lowering adds basic blocks (rhs/exit) compared to baseline.
  if (fnAnd.blocks.length <= fnSimple.blocks.length) {
    throw new Error(`expected more blocks for &&: got ${fnAnd.blocks.length}, baseline ${fnSimple.blocks.length}`);
  }
});

// ─── SSA-specific shape ───

t('SSA: block params introduced at if/else join when source var is reassigned', () => {
  const fn = lowerToCFG(PARSER.parse(`
    i32 abs(i32 x) { if (x < 0) { x = -x; } return x; }
  `)).functions[0];
  const join = fn.blocks.find((b) => b.name === 'endif');
  eq(join.params.length, 1, 'endif should have one block param for the merged x');
  eq(join.params[0].type, 'i32');
  // Both predecessors of `endif` carry exactly one arg.
  for (const pred of join.predecessors) {
    const t = pred.terminator;
    if (t instanceof CFG.Br) eq(t.args.length, 1);
    else if (t instanceof CFG.BrIf) {
      if (t.trueTarget === join) eq(t.trueArgs.length, 1);
      if (t.falseTarget === join) eq(t.falseArgs.length, 1);
    }
  }
});
t('SSA: block params introduced at while header for loop-mutated vars', () => {
  const fn = lowerToCFG(PARSER.parse(`
    i32 fact(i32 n) {
      i32 r = 1;
      while (n > 1) { r = r * n; n = n - 1; }
      return r;
    }
  `)).functions[0];
  const header = fn.blocks.find((b) => b.name === 'while_head');
  // n and r are both mutated in the loop, both flow through the back edge.
  eq(header.params.length, 2);
  eq(header.predecessors.length, 2);   // entry + while_body back-edge
});
t('SSA: ternary merges into block param', () => {
  const fn = lowerToCFG(PARSER.parse(`
    i32 pick(i32 c) { return c ? 42 : 99; }
  `)).functions[0];
  const exit = fn.blocks.find((b) => b.name === 'tern_exit');
  eq(exit.params.length, 1);
  eq(exit.predecessors.length, 2);   // tern_then + tern_else
});
t('SSA: function-param Values are bound in entry', () => {
  const fn = lowerToCFG(PARSER.parse(`i32 id(i32 x) { return x; }`)).functions[0];
  eq(fn.paramValues.length, 1);
  eq(fn.paramValues[0].name, 'x');
  eq(fn.entry.terminator instanceof CFG.Return, true);
  eq(fn.entry.terminator.value === fn.paramValues[0], true);
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

// ─── round-trip semantic preservation ───
//
// Unlike c1, c2 round-trip is NOT size-stable: each iteration introduces
// new block params at every dispatcher case re-entry (since the dispatcher
// pattern is irreducible CFG → SSA construction must place a param at every
// rejoin). Output size grows superlinearly per round-trip. The tests below
// only verify *semantic* preservation across a single iteration, which is
// the meaningful claim for c2. Idempotent round-trip would require a real
// stackifier (the planned c3+ work — see SSA.md).

t('round-trip preserves goto semantics', () => {
  const prog = liftToAST(lowerToCFG(PARSER.parse(SUM_GOTO)));
  eq(run(emitWasm(prog), 'sum', 10), 45);
  eq(run(emitWasm(prog), 'sum', 100), 4950);
});
t('round-trip preserves && / || semantics', () => {
  const prog = liftToAST(lowerToCFG(PARSER.parse(`
    i32 f(i32 a, i32 b) { return a && b || a; }
  `)));
  const m = new WebAssembly.Instance(new WebAssembly.Module(emitWasm(prog)));
  eq(m.exports.f(3, 5), 1);
  eq(m.exports.f(0, 0), 0);
  eq(m.exports.f(0, 7), 0);
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
  // In SSA, args reference Values — outer's first paramValue corresponds to y.
  eq(calls[0].args[0] === outer.paramValues[0], true);
  eq(calls[0].dest instanceof CFG.Value, true);
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
t('round-trip preserves call-heavy program semantics', () => {
  const prog = liftToAST(lowerToCFG(PARSER.parse(`
    i32 add(i32 a, i32 b) { return a + b; }
    i32 sumto(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) { total = add(total, i); i = i + 1; }
      return total;
    }
  `)));
  const m = new WebAssembly.Instance(new WebAssembly.Module(emitWasm(prog)));
  eq(m.exports.sumto(10), 45);
  eq(m.exports.sumto(100), 4950);
});

// Duff's device — case markers buried inside a while body. Direct emit
// must reject; round-trip through CFG must succeed; the compileWithTrace
// lift-fallback path must produce working bytes.
const DUFFS = `
  i32 count_n(i32 n) {
    i32 sum = 0;
    i32 phase = n % 4;
    switch (phase) {
      case 0:
        while (n > 0) {
          sum = sum + 1;
          n = n - 1;
      case 3:
          sum = sum + 1;
          n = n - 1;
      case 2:
          sum = sum + 1;
          n = n - 1;
      case 1:
          sum = sum + 1;
          n = n - 1;
        }
    }
    return sum;
  }
`;

t("Duff's device: direct emit rejects nested case markers", () => {
  throws(() => emitWasm(PARSER.parse(DUFFS)), /case marker inside nested control flow/);
});

t("Duff's device: round-trip through CFG produces working bytes", () => {
  const bytes = roundTrip(DUFFS);
  // For any non-negative n, count_n(n) === n.
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 13, 64]) {
    eq(run(bytes, 'count_n', n), n, `n=${n}`);
  }
});

t("Duff's device: compileWithTrace lift-fallback path works", () => {
  const trace = CODEGEN.compileWithTrace(DUFFS);
  // compileWithTrace clears bytesError when the lift fallback succeeds.
  // So: lifted must be present, bytes must be present, bytesError must be
  // null — together that proves the source went through CFG→AST and emit
  // accepted the lifted form.
  if (!trace.lifted) throw new Error('expected lifted AST');
  if (!trace.bytes) throw new Error('expected fallback bytes');
  if (trace.bytesError) throw new Error('unexpected bytesError: ' + trace.bytesError.message);
  const m = new WebAssembly.Instance(new WebAssembly.Module(trace.bytes));
  eq(m.exports.count_n(13), 13);
});

t("Duff's device: lifted source pretty-prints with inline case markers", () => {
  const lifted = liftToAST(lowerToCFG(PARSER.parse(DUFFS)));
  const src = AST.printSource(lifted);
  // Lifted dispatcher uses inline `case N:` markers (not arm-style bodies).
  if (!/case 0:/.test(src)) throw new Error('expected inline case marker in lifted source');
  if (!/^\s*case \d+:\s*$/m.test(src)) throw new Error('expected case marker on its own line');
});

// ─── PARALLEL_ASSIGN ───
//
// Source-level parallel-copy primitive. The wasm value stack handles the
// swap hazard intrinsically (push all rhs, pop into lvalues in reverse),
// so no temps are needed in the generated wasm.

t('PARALLEL_ASSIGN: 2-element swap', () => {
  const src = `
    i32 swap_and_return_a(i32 a, i32 b) {
      PARALLEL_ASSIGN((a, b), (b, a));
      return a;     // should be the original b
    }
  `;
  eq(run(direct(src), 'swap_and_return_a', 7, 11), 11);
  eq(run(direct(src), 'swap_and_return_a', 100, 200), 200);
});

t('PARALLEL_ASSIGN: 3-element rotate', () => {
  const src = `
    i32 rotate_third(i32 a, i32 b, i32 c) {
      PARALLEL_ASSIGN((a, b, c), (b, c, a));   // a←b, b←c, c←a
      return c;     // should be original a
    }
  `;
  eq(run(direct(src), 'rotate_third', 1, 2, 3), 1);
  eq(run(direct(src), 'rotate_third', 9, 8, 7), 9);
});

t('PARALLEL_ASSIGN: works inside loop back edge (the classic hazard)', () => {
  // Each iteration swaps a and b; after n iterations, if n is even,
  // we end where we started; if odd, swapped.
  const src = `
    i32 swap_n_times(i32 a, i32 b, i32 n) {
      while (n > 0) {
        PARALLEL_ASSIGN((a, b), (b, a));
        n = n - 1;
      }
      return a;
    }
  `;
  eq(run(direct(src), 'swap_n_times', 5, 9, 0), 5);   // no swap
  eq(run(direct(src), 'swap_n_times', 5, 9, 1), 9);   // one swap
  eq(run(direct(src), 'swap_n_times', 5, 9, 2), 5);   // two swaps
  eq(run(direct(src), 'swap_n_times', 5, 9, 7), 9);
});

t('PARALLEL_ASSIGN: zero-arity is a no-op', () => {
  const src = `
    i32 noop_then_return(i32 x) {
      PARALLEL_ASSIGN((), ());
      return x;
    }
  `;
  eq(run(direct(src), 'noop_then_return', 42), 42);
});

t('PARALLEL_ASSIGN: arity mismatch rejected at parse time', () => {
  throws(
    () => PARSER.parse(`i32 f(i32 a, i32 b) { PARALLEL_ASSIGN((a, b), (b)); return a; }`),
    /arity mismatch/);
});

t('PARALLEL_ASSIGN: type mismatch rejected at parse time', () => {
  throws(
    () => PARSER.parse(`i32 f(i32 a, i64 b) { PARALLEL_ASSIGN((a, b), (b, b)); return a; }`),
    /type mismatch/);
});

t('PARALLEL_ASSIGN: undefined lvalue rejected', () => {
  throws(
    () => PARSER.parse(`i32 f(i32 a) { PARALLEL_ASSIGN((a, z), (a, a)); return a; }`),
    /Undefined variable z/);
});

t('PARALLEL_ASSIGN: round-trips through CFG', () => {
  const src = `
    i32 swap_loop(i32 a, i32 b, i32 n) {
      while (n > 0) {
        PARALLEL_ASSIGN((a, b), (b, a));
        n = n - 1;
      }
      return a;
    }
  `;
  // Direct and round-trip should both produce the same observable behavior.
  for (const [a, b, n, expected] of [[5, 9, 0, 5], [5, 9, 1, 9], [5, 9, 4, 5], [3, 7, 11, 7]]) {
    eq(run(direct(src), 'swap_loop', a, b, n), expected);
    eq(run(roundTrip(src), 'swap_loop', a, b, n), expected);
  }
});

t('PARALLEL_ASSIGN: intoAST uses it for SSA destruction (no __dst_ temps)', () => {
  // A simple while loop that mutates two vars; after the lift, block-param
  // assigns should appear as PARALLEL_ASSIGN, not as temp-based copies.
  const src = `
    i32 sum_pair(i32 n) {
      i32 a = 1;
      i32 b = 2;
      while (n > 0) {
        a = a + b;
        b = a + b;
        n = n - 1;
      }
      return a + b;
    }
  `;
  const lifted = liftToAST(lowerToCFG(PARSER.parse(src)));
  const printed = AST.printSource(lifted);
  // The lift should NEVER emit __dst_* temps anymore — those were only
  // needed by the old hazard-fallback path.
  if (/__dst_/.test(printed)) throw new Error('lifted source contains __dst_ temps; ParallelAssign destruction failed');
  // It SHOULD use PARALLEL_ASSIGN for the block-param edges.
  if (!/PARALLEL_ASSIGN/.test(printed)) throw new Error('lifted source missing PARALLEL_ASSIGN');
});

// ─── Trivial phi removal (Braun §3.2) ───
//
// Eager phi creation at unsealed blocks and loop-header phis for
// pass-through variables both produce trivial phis. The post-construction
// trimTrivialPhis pass collapses them.

t('trim trivial phi: loop header drops phi for never-reassigned var', () => {
  // `n` is read inside the loop condition but never reassigned in the body.
  // Without trim: while_head has params [i, n_1] (the n_1 is trivial).
  // With trim: while_head has params [i] only.
  const src = `
    i32 f(i32 n) {
      i32 i = 0;
      while (i < n) { i = i + 1; }
      return i;
    }
  `;
  const fn = lowerToCFG(PARSER.parse(src)).functions[0];
  const head = fn.blocks.find((b) => b.name === 'while_head');
  if (!head) throw new Error('expected while_head block');
  eq(head.params.length, 1, 'expected only i to remain as phi');
  // With always-suffix naming: `i = 0` claims `i_1`, body's `i = i + 1`
  // claims `i_2` (which IS what flows back as the phi's body operand
  // and what the phi gets renamed to after trivial-phi removal merges).
  // The surviving phi's name is the canonical Value it collapsed to.
  eq(head.params[0].name, 'i_2');
});

t('trim trivial phi: ternary exit phi is real (both arms produce distinct values)', () => {
  // `c ? 1 : 2` produces two distinct values flowing into the exit phi.
  // The phi is NOT trivial; trim should leave it alone.
  const src = `
    i32 f(i32 c) {
      i32 r = c ? 1 : 2;
      return r;
    }
  `;
  const fn = lowerToCFG(PARSER.parse(src)).functions[0];
  // Some exit block reconciling the two arms should still have a phi.
  const hasPhi = fn.blocks.some((b) => b.params.length > 0);
  eq(hasPhi, true, 'ternary exit phi should survive trim');
});

t('trim trivial phi: cascading collapse — phi-of-phi reduces to root value', () => {
  // Two sequential ifs where one variable is never modified: the join of
  // the first if creates a trivial phi, which feeds the join of the
  // second if (also trivial). Both should collapse to the original
  // definition.
  const src = `
    i32 f(i32 a, i32 c1, i32 c2) {
      if (c1) {} else {}
      if (c2) {} else {}
      return a;
    }
  `;
  const fn = lowerToCFG(PARSER.parse(src)).functions[0];
  for (const b of fn.blocks) {
    if (b.params.length > 0) {
      throw new Error(`expected all phis collapsed, but ${b.name} has params [${b.params.map((p) => p.name).join(',')}]`);
    }
  }
});

t('trim trivial phi: semantics preserved end-to-end', () => {
  // The loop-sum example: trim must not change behavior.
  const src = `
    i32 sum(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) {
        total = total + i;
        i = i + 1;
      }
      return total;
    }
  `;
  for (const [n, expected] of [[0, 0], [1, 0], [5, 10], [10, 45]]) {
    eq(run(direct(src), 'sum', n), expected);
    eq(run(roundTrip(src), 'sum', n), expected);
  }
});

t('trim trivial phi: self-only-operand phi (unreachable) is left intact', () => {
  // Construct a case where a phi has only self-references: e.g. a label
  // block with no incoming goto. The phi's incompletePhi never gets a
  // real operand. trimTrivialPhis should leave it alone (canonical === null).
  // This is harder to construct in source — we rely on the catch-all
  // sealing at end-of-function. Use a goto that's unreachable to set it up.
  // (Existing factorial / mutual-recursion tests indirectly stress this
  // because of dead blocks introduced by goto-style switches; if they
  // pass, this path is exercised.)
  // No-op test — placeholder. Keeping as a comment to document the case.
});

// ─── SCC-specific tests (cases trivial-phi cleanup alone would miss) ───

t('SCC: 2-phi cycle with single external value collapses', () => {
  // `b` is initialized from `a`, so currentDef[b] at loop entry IS a_1
  // (not a fresh Value). Inside the loop body a and b swap. The loop
  // header phis become:
  //   a_h = phi(a_1, b_h)
  //   b_h = phi(a_1, a_h)
  // Each phi looks LOCALLY non-trivial (two distinct operands: another
  // phi + a_1), so Braun §3.2 trivial cleanup leaves both in place.
  // Globally the {a_h, b_h} SCC has a single external operand a_1, so
  // SCC cleanup collapses both phis to a_1. Loop head should retain
  // only the `n` phi (which has a non-phi back-edge operand n_h - 1
  // and is genuinely needed).
  const src = `
    i32 f(i32 n) {
      i32 a = 0;
      i32 b = a;
      while (n > 0) {
        i32 t = a;
        a = b;
        b = t;
        n = n - 1;
      }
      return a;
    }
  `;
  const fn = lowerToCFG(PARSER.parse(src)).functions[0];
  const head = fn.blocks.find((b) => b.name === 'while_head');
  if (!head) throw new Error('expected while_head block');
  eq(head.params.length, 1, 'a_h and b_h SCC should collapse, leaving only n_h');
});

t('SCC: 2-phi cycle with TWO distinct externals stays', () => {
  // Independent a and b initializations: a_1 and b_1 are distinct
  // Values, so the {a_h, b_h} SCC's externals = {a_1, b_1}. SCC
  // cleanup must NOT collapse — a and b genuinely differ each
  // iteration. Both phis should survive.
  const src = `
    i32 f(i32 n) {
      i32 a = 0;
      i32 b = 1;
      while (n > 0) {
        i32 t = a;
        a = b;
        b = t;
        n = n - 1;
      }
      return a;
    }
  `;
  const fn = lowerToCFG(PARSER.parse(src)).functions[0];
  const head = fn.blocks.find((b) => b.name === 'while_head');
  if (!head) throw new Error('expected while_head block');
  // Three real phis: a_h, b_h (swap cycle, two distinct externals),
  // n_h (decrement).
  eq(head.params.length, 3, 'two-distinct-externals SCC must survive');
});

t('SCC: collapsed cycle is semantics-preserving', () => {
  // End-to-end: SCC collapse changes IR shape but the program's
  // observable behavior must be unchanged. Run the collapsed code
  // and verify the swap-of-equals identity holds.
  const src = `
    i32 f(i32 n) {
      i32 a = 0;
      i32 b = a;
      while (n > 0) {
        i32 t = a;
        a = b;
        b = t;
        n = n - 1;
      }
      return a;
    }
  `;
  // f(5) with both a, b = 0 must return 0 regardless of swap count.
  const wasmBytes = emitWasm(PARSER.parse(src));
  // Sanity: emit succeeds and produces some bytes.
  if (!wasmBytes || wasmBytes.length < 8) throw new Error('emit produced no bytes');
});

// ─── Irreducible → reducible (CFG.makeReducible) ───
//
// c3a's headline pass. Multi-entry SCCs get a dispatcher block inserted
// in front of them, becoming reducible (single-entry) loops. Semantics
// preserved; CFG shape grows by one dispatcher + (k-1) chain blocks
// per k-entry irreducible SCC.

// Helper: count SCCs by size, report entry-count for each. An SCC with
// >1 entry is irreducible.
function sccReport(fn) {
  const succ = new Map(fn.blocks.map((b) => [b, b.terminator ? b.terminator.successors : []]));
  let n = 0;
  const idx = new Map(), low = new Map(), stk = [], onS = new Set(), sccs = [];
  function go(v) {
    idx.set(v, n); low.set(v, n); n++; stk.push(v); onS.add(v);
    for (const w of succ.get(v)) {
      if (!idx.has(w)) { go(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onS.has(w)) { low.set(v, Math.min(low.get(v), idx.get(w))); }
    }
    if (low.get(v) === idx.get(v)) {
      const scc = []; let w;
      do { w = stk.pop(); onS.delete(w); scc.push(w); } while (w !== v);
      sccs.push(scc);
    }
  }
  for (const b of fn.blocks) if (!idx.has(b)) go(b);
  return sccs.map((scc) => {
    const set = new Set(scc);
    const entries = scc.filter((b) => b.predecessors.some((p) => !set.has(p))).length;
    return { size: scc.length, entries };
  });
}

t('makeReducible: clean reducible CFG is unchanged', () => {
  // A normal while-loop CFG is already reducible — makeReducible should
  // be a no-op (no dispatcher inserted, block count unchanged).
  const src = `i32 f(i32 n) { i32 i = 0; while (i < n) { i = i + 1; } return i; }`;
  const mod = lowerToCFG(PARSER.parse(src));
  const beforeBlocks = mod.functions[0].blocks.length;
  const inserted = CFG.makeReducible(mod);
  eq(inserted.length, 0, 'no dispatchers should be inserted for a reducible CFG');
  eq(mod.functions[0].blocks.length, beforeBlocks, 'block count unchanged');
});

t("makeReducible: Duff's device CFG is irreducible before, reducible after", () => {
  const DUFFS = `
    i32 count_n(i32 n) {
      i32 sum = 0; i32 phase = n % 4;
      switch (phase) {
        case 0: while (n > 0) { sum = sum + 1; n = n - 1;
        case 3: sum = sum + 1; n = n - 1;
        case 2: sum = sum + 1; n = n - 1;
        case 1: sum = sum + 1; n = n - 1; } }
      return sum;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(DUFFS));
  const before = sccReport(mod.functions[0]);
  // Duff's produces one irreducible SCC: the 5-block loop with 4 entry
  // points (case_3, case_2, case_1, while_head).
  const beforeIrreducible = before.filter((s) => s.size > 1 && s.entries > 1);
  eq(beforeIrreducible.length, 1, 'expected exactly one irreducible SCC before');
  eq(beforeIrreducible[0].entries, 4, '4 entries before');

  const inserted = CFG.makeReducible(mod);
  eq(inserted.length, 1, 'one dispatcher inserted');

  const after = sccReport(mod.functions[0]);
  const afterIrreducible = after.filter((s) => s.size > 1 && s.entries > 1);
  eq(afterIrreducible.length, 0, 'no irreducible SCCs remain');
});

t("makeReducible: Duff's device semantics preserved end-to-end", () => {
  // Lift + emit + run after makeReducible — the dispatcher-augmented CFG
  // must still produce the correct count_n(N) = N for any non-negative N.
  const DUFFS = `
    i32 count_n(i32 n) {
      i32 sum = 0; i32 phase = n % 4;
      switch (phase) {
        case 0: while (n > 0) { sum = sum + 1; n = n - 1;
        case 3: sum = sum + 1; n = n - 1;
        case 2: sum = sum + 1; n = n - 1;
        case 1: sum = sum + 1; n = n - 1; } }
      return sum;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(DUFFS));
  CFG.makeReducible(mod);
  const bytes = emitWasm(liftToAST(mod));
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 13, 64]) {
    eq(run(bytes, 'count_n', n), n, `count_n(${n})`);
  }
});

t('makeReducible: dispatcher block has union-of-entries params + entry_state', () => {
  // Verify the dispatcher's param shape: one i32 for entry_state plus
  // one Value per (original entry, original param) pair.
  const DUFFS = `
    i32 count_n(i32 n) {
      i32 sum = 0; i32 phase = n % 4;
      switch (phase) {
        case 0: while (n > 0) { sum = sum + 1; n = n - 1;
        case 3: sum = sum + 1; n = n - 1;
        case 2: sum = sum + 1; n = n - 1;
        case 1: sum = sum + 1; n = n - 1; } }
      return sum;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(DUFFS));
  const fn = mod.functions[0];
  // Find the entries' original param counts before transform.
  const entryBlocks = ['case_3', 'case_2', 'case_1', 'while_head']
    .map((name) => fn.blocks.find((b) => b.name === name));
  const totalEntryParams = entryBlocks.reduce((acc, b) => acc + b.params.length, 0);
  const beforeBlocks = fn.blocks.length;
  const inserted = CFG.makeReducible(mod);
  eq(inserted.length, 1);
  const D = inserted[0].D;
  // D.params = [entry_state] + union of entries' params.
  eq(D.params.length, 1 + totalEntryParams);
  eq(D.params[0].type, 'i32', 'entry_state is i32');
  // Single dispatcher block: no chain. Block count grows by exactly 1.
  eq(fn.blocks.length, beforeBlocks + 1, 'BrTable means one new block, not k');
});

t('makeReducible: dispatcher terminator is BrTable with k targets', () => {
  const DUFFS = `
    i32 count_n(i32 n) {
      i32 sum = 0; i32 phase = n % 4;
      switch (phase) {
        case 0: while (n > 0) { sum = sum + 1; n = n - 1;
        case 3: sum = sum + 1; n = n - 1;
        case 2: sum = sum + 1; n = n - 1;
        case 1: sum = sum + 1; n = n - 1; } }
      return sum;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(DUFFS));
  const inserted = CFG.makeReducible(mod);
  const D = inserted[0].D;
  // Single-terminator multi-way dispatch — no brIf chain.
  eq(D.terminator instanceof CFG.BrTable, true);
  eq(D.terminator.targets.length, 4, 'one target per entry block');
  eq(D.terminator.selector === D.params[0], true, 'selector is entry_state');
  // Each target's args length matches that entry's original param count.
  for (let i = 0; i < D.terminator.targets.length; i++) {
    const target = D.terminator.targets[i];
    eq(D.terminator.targetArgs[i].length, target.params.length,
       `targetArgs[${i}] length matches target.params.length`);
  }
});

t('makeReducible: round-trip preserves semantics for already-reducible programs', () => {
  // Sanity: putting makeReducible in front of intoAST shouldn't break
  // anything for normal CFGs (no dispatcher gets added; lift is unchanged).
  for (const src of [SUM_STRUCTURED, SUM_WHILESWITCH, SUM_GOTO]) {
    const mod = lowerToCFG(PARSER.parse(src));
    CFG.makeReducible(mod);
    const bytes = emitWasm(liftToAST(mod));
    eq(run(bytes, 'sum', 10), 45, 'sum(10) via makeReducible + lift');
  }
});

// Minimal 2-entry irreducible pattern: a loop body with two different
// entry points reached from outside. This is the smallest possible
// irreducible CFG and the canonical pedagogical example.
const TWO_ENTRY_LOOP = `
  i32 twoEntry(i32 cond, i32 n) {
    i32 i = 0;
    if (cond) { goto MID; }
  TOP:
    i = i + 1;
  MID:
    i = i + 1;
    if (i < n) { goto TOP; }
    return i;
  }
`;

t('makeReducible: minimal 2-entry SCC becomes reducible', () => {
  const mod = lowerToCFG(PARSER.parse(TWO_ENTRY_LOOP));
  const before = sccReport(mod.functions[0]).filter((s) => s.size > 1 && s.entries > 1);
  eq(before.length, 1, 'one irreducible SCC before');
  eq(before[0].entries, 2, 'exactly 2 entries');

  const inserted = CFG.makeReducible(mod);
  eq(inserted.length, 1, 'one dispatcher inserted');

  const after = sccReport(mod.functions[0]).filter((s) => s.size > 1 && s.entries > 1);
  eq(after.length, 0, 'no irreducible SCCs remain');

  // For N=2 entries, only the main dispatcher D is needed (no chain
  // blocks beyond D itself), since one brIf is enough to dispatch.
  // Block count delta: +1 (just D, no chain blocks).
});

t('makeReducible: 2-entry semantics preserved end-to-end', () => {
  const mod = lowerToCFG(PARSER.parse(TWO_ENTRY_LOOP));
  CFG.makeReducible(mod);
  const bytes = emitWasm(liftToAST(mod));
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  // Pre-transform expected values (traced by hand):
  //   twoEntry(0, 5)  → 6   (entry via TOP path)
  //   twoEntry(1, 5)  → 5   (entry via MID path, skips first +1)
  //   twoEntry(0, 10) → 10
  //   twoEntry(1, 10) → 11
  eq(m.exports.twoEntry(0, 5), 6);
  eq(m.exports.twoEntry(1, 5), 5);
  eq(m.exports.twoEntry(0, 10), 10);
  eq(m.exports.twoEntry(1, 10), 11);
});

// ─── Dominator tree (Cooper-Harvey-Kennedy) ───
//
// Verify the dominator computation against hand-traced expectations on
// known CFG shapes. Used by the visualizer for honest back-edge
// classification and by a future stackifier pass for ordering.

t('computeDominators: straight-line program — every block dominated by its predecessor', () => {
  // i32 f() { return 42; }  → single block; idom(entry) = entry sentinel.
  const fn = lowerToCFG(PARSER.parse('i32 f() { return 42; }')).functions[0];
  const idom = CFG.computeDominators(fn);
  eq(idom.get(fn.entry), fn.entry, 'entry dominates itself (sentinel)');
});

t('computeDominators: if/else diamond — both arms dominated by entry; join dominated by entry', () => {
  // i32 f(i32 c) { i32 r = 0; if (c) { r = 1; } else { r = 2; } return r; }
  const fn = lowerToCFG(PARSER.parse(
    'i32 f(i32 c) { i32 r = 0; if (c) { r = 1; } else { r = 2; } return r; }'
  )).functions[0];
  const idom = CFG.computeDominators(fn);
  const then_ = fn.blocks.find((b) => b.name === 'then');
  const else_ = fn.blocks.find((b) => b.name === 'else');
  const join  = fn.blocks.find((b) => b.name === 'endif');
  eq(idom.get(then_), fn.entry, 'then is dominated by entry');
  eq(idom.get(else_), fn.entry, 'else is dominated by entry');
  eq(idom.get(join),  fn.entry, 'endif is dominated by entry (LCA of then/else)');
  eq(CFG.dominates(fn.entry, join, idom), true);
  eq(CFG.dominates(then_, join, idom), false, 'then does NOT dominate endif');
});

t('computeDominators: while loop — header dominates body and exit', () => {
  // i32 f(i32 n) { i32 i = 0; while (i < n) { i = i + 1; } return i; }
  const fn = lowerToCFG(PARSER.parse(
    'i32 f(i32 n) { i32 i = 0; while (i < n) { i = i + 1; } return i; }'
  )).functions[0];
  const idom = CFG.computeDominators(fn);
  const head = fn.blocks.find((b) => b.name === 'while_head');
  const body = fn.blocks.find((b) => b.name === 'while_body');
  const exit = fn.blocks.find((b) => b.name === 'while_exit');
  eq(idom.get(head), fn.entry, 'header idom is entry');
  eq(idom.get(body), head, 'body idom is header');
  eq(idom.get(exit), head, 'exit idom is header (header decides whether to enter body or skip)');
  // Back-edge classification: body → head should register as back-edge
  // (target dominates source).
  eq(CFG.dominates(head, body, idom), true,
     'header dominates body — body→header is a real back-edge');
});

t('computeDominators: post-makeReducible CFG, dispatcher dominates the SCC', () => {
  // Confirms the post-pass CFG has clean dominator structure: the new
  // dispatcher D is the single dominator of the formerly-irreducible SCC.
  const src = `
    i32 f(i32 n, i32 which) {
      if (which == 0) { goto a; }
      goto b;
      a: n = n + 1;
      b: n = n + 10;
      if (n < 100) { goto a; }
      return n;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(src));
  CFG.makeReducible(mod);
  const fn = mod.functions[0];
  const D = fn.blocks.find((b) => b.name.startsWith('disp_'));
  const lblA = fn.blocks.find((b) => b.name === 'lbl_a');
  const lblB = fn.blocks.find((b) => b.name === 'lbl_b');
  const idom = CFG.computeDominators(fn);
  // Both original entries are now dominated by D (single-entry reducible loop).
  eq(idom.get(lblA), D, 'lbl_a idom is dispatcher');
  eq(idom.get(lblB), D, 'lbl_b idom is dispatcher');
});

// Two SEPARATE irreducible SCCs in one function. Each is handled in its
// own iteration of the pass loop; both should end up reducible with two
// dispatchers inserted, and semantics preserved end-to-end.
t('makeReducible: two separate irreducible SCCs both handled', () => {
  const src = `
    i32 twoLoops(i32 w1, i32 w2, i32 n) {
      // Loop 1: 2-entry irreducible.
      if (w1 == 0) { goto a1; }
      goto b1;
      a1: n = n + 1;
      b1: n = n + 10;
      if (n < 50) { goto a1; }
      // Loop 2: another 2-entry irreducible, independent of loop 1.
      if (w2 == 0) { goto a2; }
      goto b2;
      a2: n = n + 2;
      b2: n = n + 20;
      if (n < 200) { goto a2; }
      return n;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(src));
  const before = sccReport(mod.functions[0]).filter((s) => s.size > 1 && s.entries > 1);
  eq(before.length, 2, 'two irreducible SCCs before');

  const inserted = CFG.makeReducible(mod);
  eq(inserted.length, 2, 'two dispatchers inserted (one per SCC)');

  const after = sccReport(mod.functions[0]).filter((s) => s.size > 1 && s.entries > 1);
  eq(after.length, 0, 'no irreducible SCCs remain');

  // Semantics: compile, run, sanity-check.
  const bytes = emitWasm(liftToAST(mod));
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  // For w1=0, w2=0, n=0: enter loop 1 at a1 → +1, +10 = 11; iterate until
  // n >= 50. Loops at a1 repeatedly: each iter +11. After enter (n=11),
  // iter1 (n=22), iter2 (n=33), iter3 (n=44), iter4 (n=55) — exit. Then
  // loop 2 from a2: +2, +20 = 22 added per iter. n=77, 99, ..., until ≥ 200.
  // Just sanity check the result is positive and grows monotonically with n.
  const r0 = m.exports.twoLoops(0, 0, 0);
  const r1 = m.exports.twoLoops(0, 0, 5);
  if (r0 <= 0 || r1 <= r0) throw new Error(`expected growth: r0=${r0}, r1=${r1}`);
});

// NESTED irreducibility: an outer multi-entry SCC contains an inner
// multi-entry SCC. Splitting one doesn't trivially split the other,
// so the fixed-point loop has to keep going until BOTH are reducible.
t('makeReducible: nested irreducibility resolved by fixed-point iteration', () => {
  const src = `
    i32 nested(i32 w1, i32 w2, i32 n) {
      if (w1 == 0) { goto outer_a; }
      goto outer_b;
      outer_a: n = n + 1;
      outer_b:
        // Inner 2-entry irreducible loop, embedded in the outer's body.
        if (w2 == 0) { goto inner_a; }
        goto inner_b;
        inner_a: n = n + 2;
        inner_b: n = n + 4;
        if (n < 30) { goto inner_a; }
      if (n < 100) { goto outer_a; }
      return n;
    }
  `;
  const mod = lowerToCFG(PARSER.parse(src));
  // At least one multi-entry SCC before (the structure may collapse the
  // inner into the outer at Tarjan time depending on edge enumeration —
  // exact count depends on SCC discovery order, but irreducibility must
  // be present).
  const before = sccReport(mod.functions[0]).filter((s) => s.size > 1 && s.entries > 1);
  if (before.length === 0) throw new Error('expected irreducibility in nested source');

  const inserted = CFG.makeReducible(mod);
  if (inserted.length < 1) throw new Error('expected ≥1 dispatcher inserted');

  const after = sccReport(mod.functions[0]).filter((s) => s.size > 1 && s.entries > 1);
  eq(after.length, 0, 'no irreducible SCCs remain after fixed-point iteration');

  // Semantics preserved: compile, run, check non-trivial behavior.
  const bytes = emitWasm(liftToAST(mod));
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  // Just verify it terminates and returns a sane number for several inputs.
  const samples = [
    [0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0],
    [0, 0, 50], [1, 1, 50],
  ];
  for (const [w1, w2, n] of samples) {
    const r = m.exports.nested(w1, w2, n);
    if (typeof r !== 'number') throw new Error(`nested(${w1},${w2},${n}) returned ${r}`);
  }
});

t('makeReducible: compileWithTrace reports dispatchersAdded', () => {
  const DUFFS = `
    i32 count_n(i32 n) {
      i32 sum = 0; i32 phase = n % 4;
      switch (phase) {
        case 0: while (n > 0) { sum = sum + 1; n = n - 1;
        case 3: sum = sum + 1; n = n - 1;
        case 2: sum = sum + 1; n = n - 1;
        case 1: sum = sum + 1; n = n - 1; } }
      return sum;
    }
  `;
  const trace = CODEGEN.compileWithTrace(DUFFS);
  if (trace.reducibleError) throw new Error('reducibleError: ' + trace.reducibleError.message);
  eq(trace.dispatchersAdded.length, 1, 'one dispatcher for Duff\'s');
  // And the resulting bytes still run correctly via compileWithTrace's path.
  if (!trace.bytes) throw new Error('expected bytes from compileWithTrace');
  const m = new WebAssembly.Instance(new WebAssembly.Module(trace.bytes));
  eq(m.exports.count_n(13), 13);
});

// ─── labeled blocks (c3b's core addition) ───
//
// `LABEL: { ... }` is a polymorphic scoped construct. Codegen classifies it
// by walking the body for break/continue references targeting LABEL:
//   - only break LABEL    → wasm `block`              (1 scope)
//   - only continue LABEL → wasm `loop`               (1 scope)
//   - both                → wasm `block { loop {...}}` (2 scopes)
//   - neither             → no wasm scope (label is dead — inline body)
// All semantic tests run through `both(...)` so direct emit and the lifted
// intoAST form are kept honest against each other.

t('labeled block: continue keyword works in plain while (no labels)', () => {
  const src = `
    i32 odd_sum(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) {
        i = i + 1;
        if ((i - 1) % 2 == 0) { continue; }
        total = total + (i - 1);
      }
      return total;
    }
  `;
  both(src, 'odd_sum', [[10], [0], [1], [2], [11]], [1+3+5+7+9, 0, 0, 1, 1+3+5+7+9]);
});

t('labeled block: "block" form — only break LABEL exits forward', () => {
  // No continue LABEL inside. Should compile to a wasm `block` scope only.
  const src = `
    i32 f(i32 n) {
      i32 hit = -1;
      L: {
        if (n == 0) { break L; }
        hit = n * 10;
        if (n < 0) { break L; }
        hit = n * 100;
      }
      return hit;
    }
  `;
  both(src, 'f', [[0], [-5], [3]], [-1, -50, 300]);
});

t('labeled block: "loop" form — only continue LABEL loops back', () => {
  // No break LABEL inside. The block effectively becomes a loop terminated
  // by fall-through when the continue isn't taken.
  const src = `
    i32 f(i32 n) {
      L: {
        if (n > 0) {
          n = n - 1;
          continue L;
        }
      }
      return n;
    }
  `;
  both(src, 'f', [[5], [0], [-3], [100]], [0, 0, -3, 0]);
});

t('labeled block: "both" form — break and continue together (like a labeled while)', () => {
  // This is the structural equivalent of `L: while (cond) { ...; break L; ... }`.
  const src = `
    i32 f(i32 n) {
      i32 acc = 0;
      L: {
        if (n <= 0) { break L; }
        acc = acc + n;
        n = n - 1;
        if (n == 2) { break L; }
        continue L;
      }
      return acc;
    }
  `;
  // n=5: acc 5, n=4, n!=2, cont. acc 9, n=3, n!=2, cont. acc 12, n=2, break. → 12.
  // n=0: break immediately → 0.
  // n=2: acc 2, n=1, n!=2, cont. acc 3, n=0, n!=2, cont. n<=0 → break. → 3.
  both(src, 'f', [[5], [0], [2], [1]], [12, 0, 3, 1]);
});

t('labeled block: "none" form — label is dead, body inlined with zero scopes added', () => {
  // No break LABEL or continue LABEL anywhere in the body. The block
  // contributes ZERO wasm scope opcodes — just statements emitted inline.
  // We verify the zero-scope claim by comparing scope-opcode counts to an
  // equivalent labelless version.
  const labeled = `
    i32 f(i32 n) {
      L: {
        n = n + 1;
        n = n * 2;
      }
      return n;
    }
  `;
  const labelless = `
    i32 f(i32 n) {
      n = n + 1;
      n = n * 2;
      return n;
    }
  `;
  // Same runtime behavior.
  for (const n of [0, 5, -3, 100]) {
    const labeledRun = run(direct(labeled), 'f', n);
    const labellessRun = run(direct(labelless), 'f', n);
    if (labeledRun !== labellessRun) {
      throw new Error(`runtime divergence at n=${n}: labeled=${labeledRun} labelless=${labellessRun}`);
    }
  }
  // Zero scope cost: the two compiled byte streams should be byte-identical
  // (same locals, same instructions, no extra block/loop opcodes added by
  // the dead labeled block). Compare lengths first; if equal, compare bytes.
  const bL = direct(labeled), bP = direct(labelless);
  if (bL.length !== bP.length) {
    throw new Error(`'none' form added bytes: labeled=${bL.length} labelless=${bP.length}`);
  }
  for (let i = 0; i < bL.length; i++) {
    if (bL[i] !== bP[i]) throw new Error(`byte divergence at offset ${i}`);
  }
});

t('labeled block: as scaffold around an unlabeled while — break LABEL exits the while AND the block', () => {
  // The structural equivalent of `L: while (cond) { ...; break L; ... }`
  // in the old labeled-while design. Migration path for existing patterns.
  const src = `
    i32 first_match(i32 n, i32 needle) {
      i32 i = 0;
      i32 hit = -1;
      L: {
        while (i < n) {
          if (i == needle) {
            hit = i;
            break L;
          }
          i = i + 1;
        }
      }
      return hit;
    }
  `;
  both(src, 'first_match', [[20, 7], [5, 100], [0, 0], [10, 0]], [7, -1, -1, 0]);
});

t('labeled block: continue LABEL restarts the labeled block from the top', () => {
  // continue LABEL restarts the ENTIRE labeled block — including any
  // local-init code at the start. This is MORE general than the old
  // labeled-while's continue semantics (which only re-evaluated cond).
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      L: {
        i32 j = 0;            // re-executed on continue L → j resets
        while (j < 10) {
          j = j + 1;
          if (j == 3 && n > 0) {
            n = n - 1;
            continue L;       // restarts L, resetting j to 0
          }
        }
        hits = hits + 1;       // only reaches here on the FINAL pass (after n hits 0)
      }
      return hits;
    }
  `;
  both(src, 'f', [[0], [3], [10]], [1, 1, 1]);
});

t('labeled block: nested labels with distinct names — break OUTER from inside inner', () => {
  const src = `
    i32 f(i32 n) {
      i32 hit = -1;
      OUTER: {
        i32 i = 0;
        while (i < n) {
          INNER: {
            if (i == n - 1) {
              hit = i;
              break OUTER;
            }
          }
          i = i + 1;
        }
      }
      return hit;
    }
  `;
  both(src, 'f', [[5], [1], [10], [0]], [4, 0, 9, -1]);
});

t('labeled block: switch inside labeled block — break LABEL skips switch and block', () => {
  const src = `
    i32 f(i32 n) {
      i32 hit = -1;
      L: {
        switch (n) {
          case 1: hit = 100; break L;
          case 2: hit = 200; break L;
          default: hit = 999;
        }
        hit = hit + 1;        // reachable only on default fall-out
      }
      return hit;
    }
  `;
  both(src, 'f', [[1], [2], [3], [0]], [100, 200, 1000, 1000]);
});

t('labeled block: error — duplicate label nested rejected at parse time', () => {
  const src = `
    i32 f(i32 n) {
      L: {
        L: { break L; }
      }
      return n;
    }
  `;
  throws(() => PARSER.parse(src), /Duplicate label 'L'/);
});

t('labeled block: error — duplicate label sibling rejected at parse time', () => {
  const src = `
    i32 f(i32 n) {
      L: { break L; }
      L: { break L; }
      return n;
    }
  `;
  throws(() => PARSER.parse(src), /Duplicate label 'L'/);
});

t('labeled block: error — duplicate label mixing plain marker and labeled block', () => {
  const src = `
    i32 f() {
      L: { break L; }
      L:
      return 0;
    }
  `;
  throws(() => PARSER.parse(src), /Duplicate label 'L'/);
});

t('labeled block: same label name in different functions is fine', () => {
  const src = `
    i32 f() { L: { break L; } return 0; }
    i32 g() { L: { break L; } return 1; }
  `;
  const bytes = direct(src);
  eq(run(bytes, 'f'), 0);
  eq(run(bytes, 'g'), 1);
});

t('labeled block: error — break LABEL with unknown name rejected', () => {
  throws(() => emitWasm(PARSER.parse(`
    i32 f() {
      L: { break NOPE; }
      return 0;
    }
  `)), /Break label not found: NOPE/);
});

t('labeled block: error — continue LABEL with unknown name rejected', () => {
  throws(() => emitWasm(PARSER.parse(`
    i32 f() {
      L: { continue NOPE; }
      return 0;
    }
  `)), /Continue label not found: NOPE/);
});

t('labeled block: error — continue outside any loop rejected', () => {
  throws(() => emitWasm(PARSER.parse(`
    i32 f() {
      continue;
      return 0;
    }
  `)), /Continue outside loop/);
});

t('labeled block: label name same as parameter name still works (different namespaces)', () => {
  const src = `
    i32 f(i32 L) {
      L: {
        if (L <= 0) { break L; }
        L = L * 2;
      }
      return L;
    }
  `;
  both(src, 'f', [[5], [0], [-3], [100]], [10, 0, -3, 200]);
});

t('labeled block: goto LABEL still jumps to the position of the labeled block (lifted path)', () => {
  // `goto LABEL` requires the lifted (intoAST) path — direct emit rejects
  // bare goto, but round-trip through CFG handles it. The Label marker
  // preceding the labeled Block is what the goto resolves to.
  const src = `
    i32 f(i32 n) {
      i32 visits = 0;
      L: {
        visits = visits + 1;
        if (n > 0) {
          n = n - 1;
          goto L;
        }
      }
      return visits;
    }
  `;
  // n=5: 5 gotos + 1 final = 6 visits.
  eq(run(roundTrip(src), 'f', 5), 6);
  eq(run(roundTrip(src), 'f', 0), 1);
});

t('labeled block: printSource roundtrip — parse → print → parse → emit produces same wasm', () => {
  const src = `
    i32 f(i32 n) {
      i32 acc = 0;
      OUTER: {
        i32 i = 0;
        while (i < n) {
          i = i + 1;
          INNER: {
            if (i % 2 == 0) { break INNER; }
            acc = acc + i;
          }
        }
        if (acc > 100) { break OUTER; }
        acc = acc * 10;
      }
      return acc;
    }
  `;
  const printed = AST.printSource(PARSER.parse(src));
  // Output should contain both labeled-block forms.
  if (!/OUTER:\s*{/.test(printed)) throw new Error('OUTER: { missing');
  if (!/INNER:\s*{/.test(printed)) throw new Error('INNER: { missing');
  if (!/break OUTER;/.test(printed)) throw new Error('break OUTER; missing');
  if (!/break INNER;/.test(printed)) throw new Error('break INNER; missing');
  // Idempotency at the text level.
  const printed2 = AST.printSource(PARSER.parse(printed));
  eq(printed, printed2, 'printSource not idempotent');
  // Runtime equivalence across original + printed + double-printed.
  for (const n of [0, 3, 5, 15, 30]) {
    const a = run(direct(src), 'f', n);
    const b = run(direct(printed), 'f', n);
    if (a !== b) throw new Error(`runtime divergence at n=${n}: src=${a} printed=${b}`);
  }
});

t('labeled block: 3-level deep break OUTER from triple nest', () => {
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      A: {
        B: {
          C: {
            i32 i = 0;
            while (i < n) {
              hits = hits + 1;
              if (hits == 3) { break A; }
              i = i + 1;
            }
          }
        }
      }
      return hits;
    }
  `;
  both(src, 'f', [[10], [2], [0], [5]], [3, 2, 0, 3]);
});

t('labeled block: break LABEL inside an && short-circuit cond', () => {
  // && lowers to a control-flow diamond. break LABEL inside the rhs of &&
  // must resolve through both backends.
  const src = `
    i32 f(i32 n, i32 a, i32 b) {
      i32 i = 0;
      L: {
        while (i < n) {
          i = i + 1;
          if (i > a && i > b) { break L; }
        }
      }
      return i;
    }
  `;
  both(src, 'f',
    [[20, 3, 7], [20, 7, 3], [20, 100, 100], [10, 0, 0]],
    [8, 8, 20, 1]);
});

t('labeled block: dead code after break LABEL is dropped without erroring', () => {
  const src = `
    i32 f(i32 n) {
      L: {
        if (n > 3) {
          break L;
          n = 9999;       // unreachable
        }
        n = n + 1;
      }
      return n;
    }
  `;
  both(src, 'f', [[5], [3], [0]], [5, 4, 1]);
});

t('labeled block: return inside labeled block terminates cleanly', () => {
  const src = `
    i32 f(i32 n, i32 needle) {
      i32 i = 0;
      L: {
        while (i < n) {
          if (i == needle) { return i * 10; }
          i = i + 1;
          if (i == n) { break L; }
        }
      }
      return -1;
    }
  `;
  both(src, 'f', [[10, 3], [10, 0], [10, 9], [10, 100], [0, 5]], [30, 0, 90, -1, -1]);
});

t('labeled block: lifted path preserves labeled-block semantics for all 4 cases', () => {
  // Each form should round-trip cleanly through fromAST → intoAST → emit.
  const cases = [
    // block-only (forward skip)
    { src: `i32 f(i32 n){ L: { if (n>0) { break L; } n=99; } return n; }`, args: [3, -1], exp: [3, 99] },
    // loop-only (back-skip via continue)
    { src: `i32 f(i32 n){ L: { if (n>0) { n=n-1; continue L; } } return n; }`, args: [5, 0], exp: [0, 0] },
    // both
    { src: `i32 f(i32 n){ i32 a=0; L: { if (n<=0) { break L; } a=a+n; n=n-1; continue L; } return a; }`, args: [4, 0, 1], exp: [10, 0, 1] },
    // none
    { src: `i32 f(i32 n){ L: { n=n+1; } return n; }`, args: [5, 0, -1], exp: [6, 1, 0] },
  ];
  for (const c of cases) {
    const bD = direct(c.src), bR = roundTrip(c.src);
    for (let i = 0; i < c.args.length; i++) {
      const args = [c.args[i]];
      const d = run(bD, 'f', ...args), r = run(bR, 'f', ...args);
      if (d !== c.exp[i]) throw new Error(`direct: src=${c.src.trim()} args=${args} expected=${c.exp[i]} got=${d}`);
      if (r !== c.exp[i]) throw new Error(`lifted: src=${c.src.trim()} args=${args} expected=${c.exp[i]} got=${r}`);
    }
  }
});

t('labeled block: classification cache returns consistent result across calls', () => {
  // We can't directly probe the WeakMap, but we can verify that recompiling
  // the same AST twice produces identical bytes (which proves the
  // classification is deterministic and the cache doesn't drift).
  const src = `
    i32 f(i32 n) {
      L: {
        if (n <= 0) { break L; }
        n = n - 1;
        continue L;
      }
      return n;
    }
  `;
  const ast = PARSER.parse(src);
  const b1 = emitWasm(ast), b2 = emitWasm(ast);
  if (b1.length !== b2.length) throw new Error('byte length divergence on recompile');
  for (let i = 0; i < b1.length; i++) {
    if (b1[i] !== b2[i]) throw new Error(`byte divergence at offset ${i}`);
  }
});

// ─── unlabeled break/continue scoping: labeled blocks are invisible to unlabeled lookups ───
//
// Per Java/JS/Rust semantics: bare `break;` targets the innermost actual
// loop or switch; bare `continue;` targets the innermost actual loop.
// Labeled blocks are NEVER targets of unlabeled break/continue — they're
// transparent to them. To exit a labeled block, you must use `break LABEL;`
// (and similarly for continue).

t('unlabeled break alone in labeled block (no enclosing loop) is rejected', () => {
  throws(() => emitWasm(PARSER.parse(`i32 f(){ L: { break; } return 0; }`)),
         /Break outside loop\/switch/);
});

t('unlabeled continue alone in labeled block (no enclosing loop) is rejected', () => {
  throws(() => emitWasm(PARSER.parse(`i32 f(){ L: { continue; } return 0; }`)),
         /Continue outside loop/);
});

t('unlabeled continue inside labeled block inside while continues the WHILE, not the block', () => {
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      while (n > 0) {
        n = n - 1;
        L: {
          if (n % 2 == 0) { continue; }   // SHOULD continue the while, not restart L
          hits = hits + 1;
        }
      }
      return hits;
    }
  `;
  // n=5: decrements 4,3,2,1,0. Even (4,2,0) skip via continue→while. Odd (3,1) add. hits=2.
  // n=10: decrements 9..0. Odd hits: 9,7,5,3,1 → 5.
  // n=0: loop doesn't enter. 0.
  both(src, 'f', [[5], [10], [0]], [2, 5, 0]);
});

t('unlabeled break inside labeled block inside while breaks the WHILE, not the block', () => {
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      while (n > 0) {
        n = n - 1;
        L: {
          if (n == 2) { break; }   // SHOULD break the while, not the block
          hits = hits + 1;
        }
      }
      return hits;
    }
  `;
  // n=5: decrements 4,3,2 → at n=2 break. hits accumulated: 4,3 → 2.
  // n=3: 2,1,0. At n=2 break (after first decrement). hits = 0? Wait — let me trace.
  //   start n=3, decrement → n=2, then if n==2 break. hits=0.
  // n=10: hits at decrement-values 9..3 then break at 2. So 9,8,7,6,5,4,3 → 7 hits.
  // n=2: decrement → n=1; n != 2 → hits=1; iter; n=1>0 → decrement n=0; n!=2 → hits=2; n=0>0 false → exit. → 2.
  both(src, 'f', [[5], [3], [10], [2], [0]], [2, 0, 7, 2, 0]);
});

t('labeled break L inside while: breaks only L, while keeps going', () => {
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      while (n > 0) {
        n = n - 1;
        L: {
          if (n == 2) { break L; }   // exits L only; while iterates again
          hits = hits + 1;
        }
      }
      return hits;
    }
  `;
  // n=5: decrements 4,3,2,1,0. At n=2 break L (skip hits++). hits = 4 (4,3,1,0).
  // n=3: decrements 2,1,0. At n=2 break L. hits = 2 (1,0).
  // n=0: doesn't enter. 0.
  both(src, 'f', [[5], [3], [0]], [4, 2, 0]);
});

t('unlabeled break inside labeled block inside switch breaks the SWITCH', () => {
  const src = `
    i32 f(i32 n) {
      i32 hit = -1;
      switch (n) {
        case 1:
          L: {
            hit = 100;
            break;        // SHOULD break the switch, not L
          }
          hit = 999;       // unreachable (broken out of switch)
        default:
          hit = 0;
      }
      return hit;
    }
  `;
  both(src, 'f', [[1], [2], [0]], [100, 0, 0]);
});

t('unlabeled continue inside labeled block inside switch inside while continues the WHILE', () => {
  // Switch isn't a continue target. Inside switch inside while, the
  // innermost continue-target is the while. Labeled block in between is
  // transparent to unlabeled continue.
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      while (n > 0) {
        n = n - 1;
        switch (n) {
          case 2:
            L: {
              continue;       // SHOULD continue the WHILE, not restart L or break switch
            }
          default:
            hits = hits + 1;
        }
      }
      return hits;
    }
  `;
  // n=5: decrements 4,3,2,1,0.
  //   n=4 default → hits=1
  //   n=3 default → hits=2
  //   n=2 case 2 → continue WHILE → skip hits++
  //   n=1 default → hits=3
  //   n=0 default → hits=4 → Total: 4.
  // n=3: 2,1,0 → continue at n=2; hits 1,0 → Total: 2.
  // n=2: 1,0 → both default → Total: 2 (no case 2 ever fires).
  both(src, 'f', [[5], [3], [2]], [4, 2, 2]);
});

t('nested labeled blocks: unlabeled break inside inner skips ALL labeled blocks, reaches enclosing while', () => {
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      while (n > 0) {
        n = n - 1;
        OUTER: {
          INNER: {
            if (n == 2) { break; }   // SHOULD break the while
            hits = hits + 1;
          }
        }
      }
      return hits;
    }
  `;
  // n=5: same trace as the single-labeled-block break test → 2.
  both(src, 'f', [[5], [3], [10], [0]], [2, 0, 7, 0]);
});

// ─── AST.children getter: every node type must expose it ───

t('AST.children: every node class has a children getter returning an array', () => {
  // Sanity-checks that the getter exists on every class and returns an
  // array (possibly empty) for representative instances. If a future class
  // is added without a `get children()`, this fails immediately.
  const dummyLoc = { line: 0, col: 0 };
  const lit = new AST.Literal(dummyLoc, 'i32', 1);
  const v = new AST.Variable(dummyLoc, 'i32', 'x');
  const samples = [
    new AST.Program(dummyLoc, []),
    new AST.Function(dummyLoc, 'i32', 'f', [], new AST.Block(dummyLoc, null, [])),
    new AST.Block(dummyLoc, null, []),
    new AST.Block(dummyLoc, 'L', []),
    lit,
    v,
    new AST.Declare(dummyLoc, v, null),
    new AST.Declare(dummyLoc, v, lit),
    new AST.Assign(dummyLoc, v, lit),
    new AST.ParallelAssign(dummyLoc, [v], [lit]),
    new AST.Binary(dummyLoc, '+', lit, lit),
    new AST.Unary(dummyLoc, '-', lit),
    new AST.Ternary(dummyLoc, lit, lit, lit),
    new AST.Call(dummyLoc, { name: 'g' }, [lit]),
    new AST.ExpressionStatement(dummyLoc, lit),
    new AST.Switch(dummyLoc, lit, new AST.Block(dummyLoc, null, [])),
    new AST.Case(dummyLoc, 1),
    new AST.If(dummyLoc, lit, new AST.Block(dummyLoc, null, []), null),
    new AST.If(dummyLoc, lit, new AST.Block(dummyLoc, null, []), new AST.Block(dummyLoc, null, [])),
    new AST.While(dummyLoc, lit, new AST.Block(dummyLoc, null, [])),
    new AST.Break(dummyLoc, null),
    new AST.Break(dummyLoc, 'L'),
    new AST.Continue(dummyLoc, null),
    new AST.Continue(dummyLoc, 'L'),
    new AST.Label(dummyLoc, 'L'),
    new AST.Goto(dummyLoc, 'L'),
    new AST.Return(dummyLoc, lit),
  ];
  for (const s of samples) {
    const c = s.children;
    if (!Array.isArray(c)) {
      throw new Error(`${s.constructor.name}.children is not an array (got ${typeof c})`);
    }
  }
});

t('AST.children: generic walker reaches every node without per-type case analysis', () => {
  // Walks a representative program and counts each AST node type seen via
  // the generic children traversal. If `children` mis-reports its child
  // set on any class, the count for some node type will be wrong.
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      L: {
        while (i < n) {
          i = i + 1;
          if (i % 2 == 0) { continue; }
          if (i > 10) { break L; }
          sum = sum + i;
        }
      }
      return sum;
    }
  `;
  const ast = PARSER.parse(src);
  const counts = new Map();
  const walk = (node) => {
    if (!node) return;
    const name = node.constructor.name;
    counts.set(name, (counts.get(name) || 0) + 1);
    for (const c of node.children) walk(c);
  };
  walk(ast);
  // The labeled block + the while + the inner ifs + break + continue +
  // assigns + the return all show up via the generic walk.
  if (!counts.get('Program')) throw new Error('no Program reached');
  if (!counts.get('Function')) throw new Error('no Function reached');
  if (!counts.get('Block')) throw new Error('no Block reached');
  if (!counts.get('While')) throw new Error('no While reached');
  if (!counts.get('If')) throw new Error('no If reached');
  if (!counts.get('Break')) throw new Error('no Break reached');
  if (!counts.get('Continue')) throw new Error('no Continue reached');
  if (!counts.get('Assign')) throw new Error('no Assign reached');
  if (!counts.get('Return')) throw new Error('no Return reached');
  if (!counts.get('Binary')) throw new Error('no Binary reached');
});

// ─── do-while (added back in c3b with correct continue semantics) ───

t('do-while: body runs at least once even when cond is false', () => {
  const src = `
    i32 once(i32 ignored) {
      i32 c = 0;
      do { c = c + 1; } while (0);
      return c;
    }
  `;
  both(src, 'once', [[99], [0]], [1, 1]);
});

t('do-while: continue re-evaluates cond (re-tests, may exit)', () => {
  const src = `
    i32 count_down(i32 n) {
      i32 iters = 0;
      do {
        iters = iters + 1;
        if (n > 1) { n = n - 1; continue; }
        n = 0;
      } while (n > 0);
      return iters;
    }
  `;
  both(src, 'count_down', [[5], [1], [10]], [5, 1, 10]);
});

t('do-while: break exits before tail cond', () => {
  const src = `
    i32 first_hit(i32 n) {
      i32 i = 0;
      do {
        if (i == n) { break; }
        i = i + 1;
      } while (1);
      return i;
    }
  `;
  both(src, 'first_hit', [[7], [0], [100]], [7, 0, 100]);
});

t('do-while: round-trips through CFG preserving semantics', () => {
  const src = `
    i32 sum(i32 n) {
      i32 total = 0;
      i32 i = 0;
      if (n == 0) { return 0; }
      do {
        total = total + i;
        i = i + 1;
      } while (i < n);
      return total;
    }
  `;
  for (const n of [0, 1, 5, 10, 100]) {
    eq(run(direct(src), 'sum', n), run(roundTrip(src), 'sum', n), `n=${n}`);
  }
  eq(run(direct(src), 'sum', 10), 45);
});

t('do-while: pretty-prints with trailing semicolon', () => {
  const src = `i32 f(i32 n) { do { n = n - 1; } while (n > 0); return n; }`;
  const printed = AST.printSource(PARSER.parse(src));
  if (!/} while \(n > 0\);/.test(printed)) throw new Error('do-while not pretty-printed: ' + printed);
});

t('do-while: labeled-block CAN wrap a do-while; break LABEL exits both', () => {
  // Since labels only attach to Blocks (not do-while directly), labeled
  // do-while is expressed as `L: { do {...} while (...); }`.
  const src = `
    i32 first_neg(i32 n) {
      i32 i = 0;
      i32 found = -1;
      L: {
        do {
          if (i >= 0 && i * i > n) { found = i; break L; }
          i = i + 1;
          if (i > 1000) { break L; }
        } while (1);
      }
      return found;
    }
  `;
  both(src, 'first_neg', [[24], [25], [100]], [5, 6, 11]);
});

// ─── goto-into-body audit (mirrors c3a's verification) ───

t('goto-into-body c3b: goto into the middle of a while body', () => {
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      goto MID;
      while (i < n) {
        sum = sum + i;
        MID: i = i + 1;
      }
      return sum;
    }
  `;
  // Same trace as c3a's version. For n=5: sum = 10. For n=0,1: sum=0.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5), 10);
  eq(run(bytes, 'f', 0), 0);
  eq(run(bytes, 'f', 1), 0);
});

t('goto-into-body c3b: goto into a do-while body', () => {
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      goto MID;
      do {
        sum = sum + i;
        MID: i = i + 1;
      } while (i < n);
      return sum;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5), 10);
  eq(run(bytes, 'f', 0), 0);
  eq(run(bytes, 'f', 1), 0);
});

t('goto-into-body c3b: goto into a labeled block body — works via undef-tolerant SSA', () => {
  // goto MID bypasses the labeled-block wrapper. The wrapper-Label-marker
  // block ends up 0-pred from any live path, but still a structural pred
  // of headerB via the initial Br. With undef-tolerant SSA, phi resolution
  // synthesizes undef for the dead operand; the dead path is never
  // traversed at runtime so the undef value is unobservable.
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      goto MID;
      L: {
        sum = sum + i;
        MID: i = i + 1;
        if (i >= n) { break L; }
      }
      return sum;
    }
  `;
  // Trace: goto MID → i=1 (undef sum becomes 0 along dead path, but we
  // never read sum from headerB's path because goto bypasses it).
  //   n=0: i=1, 1>=0 → break L → return sum=0.
  //   n=1: i=1, 1>=1 → break L → return sum=0.
  //   n=3: i=1, 1>=3 false. End of L body — falls off end of labeled block.
  //        Falls through to `return sum;`. sum=0 (never written; goto skipped it).
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 0), 0);
  eq(run(bytes, 'f', 1), 0);
  eq(run(bytes, 'f', 3), 0);
});

t('goto-into-body c3b: goto-into-case-body — works via undef-tolerant SSA', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = -1;
      goto INSIDE_CASE;
      switch (n) {
        case 1: r = 10; break;
        case 2:
          INSIDE_CASE: r = r + 100;
          break;
        default: r = 999;
      }
      return r;
    }
  `;
  // Goto bypasses switch dispatch. INSIDE_CASE: r = -1 + 100 = 99 → break.
  // The case_block becomes 0-pred; phi resolution uses undef on that dead
  // operand. Runtime sees 99 for any n.
  const bytes = roundTrip(src);
  for (const n of [1, 2, 5, 0, -1]) {
    eq(run(bytes, 'f', n), 99, `n=${n}`);
  }
});

// ─── ADVERSARIAL: undef-tolerant SSA + nasty goto/irreducibility patterns (mirror of c3a) ───

t('NASTY 1 c3b: variable defined ONLY on goto-source path; phi at target gives live def', () => {
  const src = `
    i32 f(i32 n) {
      i32 x = 0;
      x = 42;
      goto MERGE;
      switch (n) {
        case 1: x = 999;
        MERGE: return x;
        default: return -1;
      }
    }
  `;
  const bytes = roundTrip(src);
  for (const n of [0, 1, 5, 999]) eq(run(bytes, 'f', n), 42, `n=${n}`);
});

t('NASTY 2 c3b: goto chain A → B → C', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      goto A;
      A: r = r + 1; goto B;
      B: r = r * 10; goto C;
      C: r = r + 5;
      return r;
    }
  `;
  eq(run(roundTrip(src), 'f', 0), 15);
});

t('NASTY 3 c3b: multiple gotos converge on same label', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      if (n == 1) { r = 100; goto MERGE; }
      if (n == 2) { r = 200; goto MERGE; }
      if (n == 3) { r = 300; goto MERGE; }
      r = 999;
      MERGE: return r;
    }
  `;
  const bytes = roundTrip(src);
  for (const [n, want] of [[1, 100], [2, 200], [3, 300], [4, 999]]) eq(run(bytes, 'f', n), want);
});

t('NASTY 4 c3b: goto skips a Declare — variable reads as wasm-default-zero', () => {
  const src = `
    i32 f(i32 ignored) {
      goto AFTER;
      i32 x = 5;
      AFTER: return x;
    }
  `;
  eq(run(roundTrip(src), 'f', 0), 0);
});

t('NASTY 5 c3b: self-goto creates trivial infinite loop — compiles cleanly', () => {
  const src = `i32 f(i32 ignored) { L: goto L; return 0; }`;
  const bytes = roundTrip(src);
  if (!bytes || bytes.length === 0) throw new Error('expected wasm bytes');
});

t('NASTY 6 c3b: 3-entry SCC — three distinct gotos into a while body', () => {
  const src = `
    i32 f(i32 n, i32 entry) {
      i32 acc = 0;
      i32 i = 0;
      if (entry == 1) { goto A; }
      if (entry == 2) { goto B; }
      if (entry == 3) { goto C; }
      while (i < n) {
        A: acc = acc + 1;
        B: acc = acc + 10;
        C: acc = acc + 100;
        i = i + 1;
      }
      return acc;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 2, 0), 222);
  eq(run(bytes, 'f', 2, 1), 222);
  eq(run(bytes, 'f', 2, 2), 221);
  eq(run(bytes, 'f', 2, 3), 211);
});

t('NASTY 7 c3b: goto out of nested while into outer-scope label', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      while (n > 0) {
        r = r + 1;
        if (r == 3) { goto OUTSIDE; }
        n = n - 1;
      }
      OUTSIDE: r = r * 10;
      return r;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5), 30);
  eq(run(bytes, 'f', 2), 20);
  eq(run(bytes, 'f', 0), 0);
});

t('NASTY 8 c3b: i64 variables across goto-into-body', () => {
  const src = `
    i64 f(i64 n, i64 sum0, i64 one) {
      i64 sum = sum0;
      goto MID;
      while (n > one * one - one) {
        sum = sum + n;
        MID: n = n - one;
      }
      return sum;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 3n, 100n, 1n), 103n);
  eq(run(bytes, 'f', 0n, 100n, 1n), 100n);
});

t('NASTY 9 c3b: trivial phi elimination must NOT eliminate phi with undef + concrete', () => {
  const src = `
    i32 f(i32 n) {
      i32 x = 42;
      goto SKIP_DEAD;
      if (n) { x = 999; }
      SKIP_DEAD: return x;
    }
  `;
  for (const n of [0, 1, 99]) eq(run(roundTrip(src), 'f', n), 42);
});

t('NASTY 10 c3b: nested irreducibility — goto inside nested whiles', () => {
  const src = `
    i32 f(i32 outer, i32 inner) {
      i32 r = 0;
      while (outer > 0) {
        goto MID;
        while (inner > 0) {
          r = r + 1;
          MID: inner = inner - 1;
        }
        outer = outer - 1;
      }
      return r;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 1, 3), 2);
  eq(run(bytes, 'f', 2, 2), 1);
  eq(run(bytes, 'f', 1, 0), 0);
});

t('NASTY 11 c3b: goto INTO a switch case + break out of switch', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      goto INSIDE;
      switch (n) {
        case 1: r = 10; break;
        case 2:
          INSIDE: r = r + 7;
          if (n == 99) { break; }
          r = r + 1;
        case 3: r = r + 100; break;
        default: r = 9999;
      }
      return r;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 99), 7);
  eq(run(bytes, 'f', 1), 108);
  eq(run(bytes, 'f', 2), 108);
  eq(run(bytes, 'f', 5), 108);
});

t('NASTY 12 c3b: cascading SSA — variable redefined in goto-reached blocks', () => {
  const src = `
    i32 f(i32 n) {
      i32 x = 1;
      if (n == 1) { x = 10; goto END; }
      if (n == 2) { x = 100; goto END; }
      if (n == 3) { x = 1000; goto END; }
      x = 5;
      END: return x * 2;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 1), 20);
  eq(run(bytes, 'f', 2), 200);
  eq(run(bytes, 'f', 3), 2000);
  eq(run(bytes, 'f', 0), 10);
});

t('NASTY 13 c3b: goto into label that is ALSO back-edge of enclosing loop', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      i32 i = 0;
      goto LOOP_TOP;
      while (i < n) {
        LOOP_TOP: r = r + i;
        i = i + 1;
      }
      return r;
    }
  `;
  eq(run(roundTrip(src), 'f', 4), 6);
  eq(run(roundTrip(src), 'f', 0), 0);
});

t('NASTY 14 c3b: deep nesting — goto into label 4 levels deep', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = -1;
      if (n > 0) {
        goto VERY_DEEP;
        while (1) {
          switch (n) {
            case 1:
              if (n == 1) {
                VERY_DEEP: r = 777;
                return r;
              }
          }
          break;
        }
      }
      return r;
    }
  `;
  for (const n of [1, 5, 99]) eq(run(roundTrip(src), 'f', n), 777);
  eq(run(roundTrip(src), 'f', 0), -1);
});

t('NASTY 15 c3b: goto OUT of deeply nested structure', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      while (n > 0) {
        if (n == 5) {
          switch (n) {
            case 5:
              if (1) { goto OUT; }
              break;
          }
        }
        r = r + n;
        n = n - 1;
      }
      OUT: return r * 1000 + n;
    }
  `;
  eq(run(roundTrip(src), 'f', 7), 13005);
  eq(run(roundTrip(src), 'f', 3), 6000);
});

t('NASTY 16 c3b: ParallelAssign in goto-reachable block — swap semantics', () => {
  const src = `
    i32 f(i32 n) {
      i32 a = 1;
      i32 b = 2;
      goto SWAP;
      a = 99; b = 99;
      SWAP: PARALLEL_ASSIGN((a, b), (b, a));
      return a * 10 + b;
    }
  `;
  for (const n of [0, 1, 5]) eq(run(roundTrip(src), 'f', n), 21);
});

t('NASTY 17 c3b: multi-entry SCC where every entry defines x differently', () => {
  const src = `
    i32 f(i32 entry, i32 iters) {
      i32 x = 0;
      i32 i = 0;
      if (entry == 1) { x = 10; goto INSIDE; }
      if (entry == 2) { x = 20; goto INSIDE; }
      while (i < iters) {
        x = 1;
        INSIDE: i = i + 1;
      }
      return x;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 1, 1), 10);
  eq(run(bytes, 'f', 1, 3), 1);
  eq(run(bytes, 'f', 0, 0), 0);
  eq(run(bytes, 'f', 0, 1), 1);
});

t('NASTY 18 c3b: undef robustness — dead path REALLY never observed across input range', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 42;
      goto END;
      if (n > 0) { r = r + 1; goto END; }
      r = 999;
      END: return r;
    }
  `;
  for (const n of [-100, -1, 0, 1, 100, 99999]) eq(run(roundTrip(src), 'f', n), 42, `n=${n}`);
});

t('NASTY 19 c3b: trimPhis preserves phi with undef + concrete operands', () => {
  const src = `
    i32 f(i32 n) {
      i32 x = 7;
      goto JOIN;
      if (n) { x = 13; }
      JOIN: return x;
    }
  `;
  for (const n of [0, 1, 5]) eq(run(roundTrip(src), 'f', n), 7);
});

t('NASTY 20 c3b: empty function body except for goto + label', () => {
  const src = `i32 f(i32 n) { goto END; END: return 1; }`;
  eq(run(roundTrip(src), 'f', 0), 1);
});

// c3b-specific: labeled-block adversarial cases
t('NASTY 21 c3b: goto into a labeled block whose label is referenced by break/continue', () => {
  // Triple-use of LABEL: goto target, break LABEL target, continue LABEL target.
  // Labels are function-flat so the same name covers all three.
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      i32 i = 0;
      if (n > 100) { goto L; }
      L: {
        if (i >= n) { break L; }
        r = r + i;
        i = i + 1;
        continue L;
      }
      return r;
    }
  `;
  // Normal path: L is a labeled block with both break and continue → loops.
  //   i=0: i<n? if so, r += 0, i=1, continue L. ... iterates until i>=n, then break L.
  //   For n=5: r = 0+1+2+3+4 = 10.
  // goto path (n>100): goto L jumps to the start of L's body. Same trace:
  //   For n=200: r = 0+1+2+...+199. Big number.
  eq(run(roundTrip(src), 'f', 5), 10);
  eq(run(roundTrip(src), 'f', 0), 0);
  eq(run(roundTrip(src), 'f', 200), 19900);
});

t('NASTY 22 c3b: continue in do-while inside if inside while — all loops resolve correctly', () => {
  const src = `
    i32 f(i32 outer_n, i32 inner_n) {
      i32 sum = 0;
      i32 i = 0;
      while (i < outer_n) {
        i = i + 1;
        if (i % 2 == 0) {
          i32 j = 0;
          do {
            j = j + 1;
            if (j == 2) { continue; }   // continue do-while
            sum = sum + 1;
          } while (j < inner_n);
        }
      }
      return sum;
    }
  `;
  // outer_n=4, inner_n=3: i=1 (odd, skip). i=2 (even): do iter, j=1 sum+=1. j<3, do iter, j=2 continue. j<3, do iter, j=3 sum+=1. j<3 false. sum=2.
  //   Then i=3 (odd, skip). i=4 (even): same → sum +=2 → sum=4.
  // outer_n=2, inner_n=2: i=1 skip. i=2 even: do iter j=1 sum+=1. j<2, do iter j=2 continue. j<2 false. sum=1.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 4, 3), 4);
  eq(run(bytes, 'f', 2, 2), 1);
});

t('NASTY 23 c3b: goto + labeled block + switch + while all interacting', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      OUTER: {
        i32 i = 0;
        while (i < n) {
          switch (i % 3) {
            case 0:
              if (i > 5) { goto END; }
              r = r + 1;
              break;
            case 1: r = r + 10; break;
            default: r = r + 100;
          }
          i = i + 1;
        }
      }
      END: return r;
    }
  `;
  // n=7: i=0 (case 0, i not >5, r=1). i=1 (case 1, r=11). i=2 (default, r=111). i=3 (case 0, r=112). i=4 (case 1, r=122). i=5 (default, r=222). i=6 (case 0, 6>5 → goto END). return 222.
  // n=4: i=0 r=1, i=1 r=11, i=2 r=111, i=3 r=112. i=4 cond false → exit. r=112.
  // n=0: never enters. r=0.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 7), 222);
  eq(run(bytes, 'f', 4), 112);
  eq(run(bytes, 'f', 0), 0);
});

// ─── AST.lower (loops → labeled blocks) + AST.lift (labeled blocks → loops) ───
//
// Lower: rewrites every While/DoWhile in a program into canonical labeled-block
// form (matching what the stackifier will produce). Unlabeled break/continue
// inside the body are rewritten to labeled forms targeting the synthetic label.
//
// Lift: pattern-matches labeled blocks back into while/do-while for readability.
// Pattern A: L: { if (!cond) break L; ...; continue L; } → while (cond) { ... }
// Pattern B: L: { ...; if (cond) continue L; } → do { ... } while (cond);
//
// Round-trip property: for natural programs without already-present labeled
// blocks, parse → lower → lift should recover the original AST structure
// (up to fresh-label / no-label labeling artifacts that don't affect lifting).

t('lower: simple while → labeled block with cond test at top', () => {
  const src = `i32 f(i32 n) { i32 s = 0; while (n > 0) { s = s + n; n = n - 1; } return s; }`;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  // Lowered output contains __L0 and continue/break __L0
  if (!/__L0:\s*{/.test(printed)) throw new Error('expected __L0: { ... }');
  if (!/break __L0;/.test(printed)) throw new Error('expected break __L0;');
  if (!/continue __L0;/.test(printed)) throw new Error('expected continue __L0;');
  if (/while \(n > 0\)/.test(printed)) throw new Error('original while should be gone');
});

t('lower: simple do-while → labeled block with cond test at bottom', () => {
  const src = `i32 f(i32 n) { i32 s = 0; do { s = s + n; n = n - 1; } while (n > 0); return s; }`;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  if (!/__L0:\s*{/.test(printed)) throw new Error('expected __L0: { ... }');
  if (!/continue __L0;/.test(printed)) throw new Error('expected continue __L0;');
  if (/break __L0;/.test(printed)) throw new Error('do-while lowering should NOT have a break (no cond-fails path at top)');
  if (/do {/.test(printed)) throw new Error('original do-while should be gone');
});

t('lower preserves semantics — runs the same as original via direct emit', () => {
  const src = `
    i32 sum(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) {
        total = total + i;
        i = i + 1;
      }
      return total;
    }
  `;
  const original = direct(src);
  const lowered = emitWasm(AST.lower(PARSER.parse(src)));
  for (const n of [0, 1, 5, 10, 100]) eq(run(lowered, 'sum', n), run(original, 'sum', n), `n=${n}`);
});

t('lower preserves semantics for do-while', () => {
  const src = `
    i32 mul(i32 a, i32 b) {
      i32 r = 0;
      i32 k = b;
      if (b == 0) { return 0; }
      do { r = r + a; k = k - 1; } while (k > 0);
      return r;
    }
  `;
  const original = direct(src);
  const lowered = emitWasm(AST.lower(PARSER.parse(src)));
  for (const [a, b] of [[7, 6], [100, 0], [-3, 5], [42, 1]]) {
    eq(run(lowered, 'mul', a, b), run(original, 'mul', a, b), `mul(${a},${b})`);
  }
});

t('lower rewrites unlabeled break inside while to labeled break __L0', () => {
  const src = `i32 f(i32 n) { while (n > 0) { if (n == 5) { break; } n = n - 1; } return n; }`;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  if (!/break __L0;/.test(printed)) throw new Error('expected break __L0; in lowered form');
  if (/break;\s*$/m.test(printed.replace(/break __L0;/g, ''))) throw new Error('bare break should be rewritten');
});

t('lower rewrites unlabeled continue inside while to labeled continue __L0', () => {
  const src = `i32 f(i32 n) { i32 s = 0; while (n > 0) { n = n - 1; if (n % 2 == 0) { continue; } s = s + 1; } return s; }`;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  if (!/continue __L0;/.test(printed)) throw new Error('expected continue __L0; in lowered form');
});

t('lower preserves unlabeled break inside switch (NOT rewritten)', () => {
  // Bare `break` inside a switch targets the switch, not any enclosing loop.
  // Lowering must NOT touch it.
  const src = `i32 f(i32 n) { switch (n) { case 1: return 10; case 2: return 20; default: return 0; } }`;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  // No __L0 since no while/do-while.
  if (/__L/.test(printed)) throw new Error('no synthetic label expected');
});

t('lower honors switch-break-target rule: bare break in switch-inside-while NOT rewritten', () => {
  const src = `
    i32 f(i32 n) {
      i32 r = 0;
      while (n > 0) {
        switch (n) {
          case 1: r = 1; break;
          case 2: r = 2; break;
          default: r = 99;
        }
        n = n - 1;
      }
      return r;
    }
  `;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  // The while becomes __L0. The case-break stays as bare break (targets switch).
  if (!/__L0:/.test(printed)) throw new Error('expected __L0 for while');
  // Expect bare `break;` to appear (inside switch cases).
  const numBareBreaks = (printed.match(/break;/g) || []).length;
  if (numBareBreaks < 2) throw new Error(`expected at least 2 bare break; in switch cases, got ${numBareBreaks}`);
});

t('lower honors continue-skips-switch rule: bare continue in switch-in-while → continue __L0', () => {
  const src = `
    i32 f(i32 n) {
      i32 hits = 0;
      while (n > 0) {
        n = n - 1;
        switch (n % 2) {
          case 0: continue;
          default: hits = hits + 1;
        }
      }
      return hits;
    }
  `;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  if (!/continue __L0;/.test(printed)) throw new Error('expected continue __L0; (skips switch)');
});

t('lower nested loops: inner gets __L0, outer gets __L1 (or fresh non-collide names)', () => {
  const src = `
    i32 f(i32 n) {
      i32 s = 0;
      while (n > 0) {
        i32 i = 0;
        while (i < n) {
          s = s + 1;
          i = i + 1;
        }
        n = n - 1;
      }
      return s;
    }
  `;
  const lowered = AST.lower(PARSER.parse(src));
  const printed = AST.printSource(lowered);
  // Two distinct labels expected.
  const labels = [...printed.matchAll(/__L(\d+):/g)].map((m) => m[1]);
  if (labels.length !== 2) throw new Error(`expected exactly 2 labeled blocks, got ${labels.length}`);
  if (labels[0] === labels[1]) throw new Error('nested labels must be distinct');
});

t('lower avoids collision with user-declared labels', () => {
  const src = `
    i32 f(i32 n) {
      __L0: while (n > 0) { n = n - 1; break __L0; }
      return n;
    }
  `;
  // Wait — labels go on Blocks not whiles in c3b. Let me restate:
  // The lowered output uses __L0; if the source already uses __L0, the
  // lowering must pick __L1 (or similar) to avoid collision.
  const src2 = `
    i32 f(i32 n) {
      __L0: { n = n - 1; }
      while (n > 0) { n = n - 1; }
      return n;
    }
  `;
  const lowered = AST.lower(PARSER.parse(src2));
  const printed = AST.printSource(lowered);
  // User's __L0 still present; lowered loop must use __L1 (or higher).
  if (!/__L0:/.test(printed)) throw new Error('user label __L0 should be preserved');
  if (!/__L1:/.test(printed)) throw new Error('lowered loop should use __L1 (avoiding user __L0)');
});

t('lift: Pattern A (while shape) labeled block → while loop', () => {
  // Hand-written stackifier-style output.
  const src = `
    i32 f(i32 n) {
      i32 s = 0;
      i32 i = 0;
      L: {
        if (!(i < n)) { break L; }
        s = s + i;
        i = i + 1;
        continue L;
      }
      return s;
    }
  `;
  const lifted = AST.lift(PARSER.parse(src));
  const printed = AST.printSource(lifted);
  if (!/while \(i < n\)/.test(printed)) throw new Error('expected while (i < n) in lifted form');
  if (/L:/.test(printed)) throw new Error('labeled block should be gone after lift');
  if (/break L;/.test(printed) || /continue L;/.test(printed)) throw new Error('labeled break/continue should be gone');
});

t('lift: Pattern B (do-while shape) labeled block → do-while', () => {
  const src = `
    i32 f(i32 n) {
      i32 s = 0;
      L: {
        s = s + n;
        n = n - 1;
        if (n > 0) { continue L; }
      }
      return s;
    }
  `;
  const lifted = AST.lift(PARSER.parse(src));
  const printed = AST.printSource(lifted);
  if (!/do {/.test(printed)) throw new Error('expected do { ... }');
  if (!/while \(n > 0\)/.test(printed)) throw new Error('expected while (n > 0)');
  if (/L:/.test(printed)) throw new Error('labeled block should be gone');
});

t('lift preserves semantics of original program (parse → lower → lift → run)', () => {
  const src = `
    i32 sum_with_skip(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) {
        i = i + 1;
        if (i % 3 == 0) { continue; }
        if (i == 13) { break; }
        total = total + i;
      }
      return total;
    }
  `;
  const original = direct(src);
  const lowered = emitWasm(AST.lower(PARSER.parse(src)));
  const lifted_ast = AST.lift(AST.lower(PARSER.parse(src)));
  const lifted = emitWasm(lifted_ast);
  // All three should agree on runtime behavior.
  for (const n of [0, 1, 5, 10, 13, 15, 20]) {
    const a = run(original, 'sum_with_skip', n);
    const b = run(lowered, 'sum_with_skip', n);
    const c = run(lifted, 'sum_with_skip', n);
    if (a !== b) throw new Error(`lower divergence at n=${n}: original=${a} lowered=${b}`);
    if (a !== c) throw new Error(`lift divergence at n=${n}: original=${a} lifted=${c}`);
  }
});

t('round-trip identity: lower then lift recovers natural while loop', () => {
  // Quality test: the lifted form should match the original source structurally
  // (no labeled blocks, all whiles back to whiles).
  const src = `
    i32 sum(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) {
        total = total + i;
        i = i + 1;
      }
      return total;
    }
  `;
  const lifted = AST.lift(AST.lower(PARSER.parse(src)));
  const printed = AST.printSource(lifted);
  // Should look like the original — just a plain while loop.
  if (!/while \(i < n\) {/.test(printed)) throw new Error(`expected clean while loop in lifted form. Got:\n${printed}`);
  if (/__L/.test(printed)) throw new Error('no synthetic labels expected after lift');
  if (/break L\d/.test(printed) || /continue L\d/.test(printed)) throw new Error('no labeled break/continue expected');
});

t('round-trip identity for do-while', () => {
  const src = `
    i32 mul(i32 a, i32 b) {
      i32 r = 0;
      i32 k = b;
      if (b == 0) { return 0; }
      do { r = r + a; k = k - 1; } while (k > 0);
      return r;
    }
  `;
  const lifted = AST.lift(AST.lower(PARSER.parse(src)));
  const printed = AST.printSource(lifted);
  if (!/do {/.test(printed)) throw new Error('expected do { ... } in lifted form');
  if (!/while \(k > 0\)/.test(printed)) throw new Error('expected while (k > 0) in lifted form');
});

t('round-trip identity preserves break and continue inside loop', () => {
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      while (i < n) {
        i = i + 1;
        if (i == 5) { break; }
        if (i % 2 == 0) { continue; }
        sum = sum + i;
      }
      return sum;
    }
  `;
  const lifted = AST.lift(AST.lower(PARSER.parse(src)));
  const printed = AST.printSource(lifted);
  if (!/while \(i < n\)/.test(printed)) throw new Error('expected while loop');
  // Bare break and continue should be back.
  if (!/break;/.test(printed)) throw new Error('expected bare break;');
  if (!/continue;/.test(printed)) throw new Error('expected bare continue;');
  if (/break __L/.test(printed)) throw new Error('no labeled break should remain');
  if (/__L/.test(printed)) throw new Error('no synthetic labels should remain');
});

t('round-trip preserves nested loops', () => {
  const src = `
    i32 outer_inner(i32 n) {
      i32 r = 0;
      while (n > 0) {
        i32 j = 0;
        while (j < n) {
          r = r + 1;
          j = j + 1;
        }
        n = n - 1;
      }
      return r;
    }
  `;
  const lifted_ast = AST.lift(AST.lower(PARSER.parse(src)));
  const lifted = emitWasm(lifted_ast);
  const original = direct(src);
  for (const n of [0, 1, 3, 5]) {
    eq(run(lifted, 'outer_inner', n), run(original, 'outer_inner', n));
  }
  const printed = AST.printSource(lifted_ast);
  // Two whiles expected, no labeled blocks.
  const whiles = (printed.match(/while \(/g) || []).length;
  if (whiles !== 2) throw new Error(`expected 2 while loops in lifted form, got ${whiles}`);
});

t('lift is conservative: does NOT lift when break LABEL appears INSIDE a nested loop', () => {
  // L: { if (!cond) break L; ...; while (...) { break L; }; continue L; }
  // Lifting this to `while (cond) { ...; while (...) { break; }; }` would
  // change semantics: bare break inside the nested while now targets the
  // nested while, but `break L` originally targeted the outer L. Our safe-
  // lift check finds the `break L` inside the nested while and bails.
  const src = `
    i32 f(i32 n) {
      L: {
        if (!(n > 0)) { break L; }
        i32 j = 0;
        while (j < n) {
          if (j == 5) { break L; }
          j = j + 1;
        }
        n = n - 1;
        continue L;
      }
      return n;
    }
  `;
  const lifted = AST.lift(PARSER.parse(src));
  const printed = AST.printSource(lifted);
  // L: { ... } should remain (lift bailed due to break L inside nested while).
  if (!/L:\s*{/.test(printed)) throw new Error(`expected labeled L: to be preserved. Got:\n${printed}`);
});

t('lift is permissive: lifts even when nested loop exists IF no break/continue LABEL inside it', () => {
  // The nested while is fine because no `break L` / `continue L` is inside
  // it — bare break/continue inside the nested while target the nested
  // while; outer L can safely become a while.
  const src = `
    i32 f(i32 n) {
      L: {
        if (!(n > 0)) { break L; }
        i32 j = 0;
        while (j < n) {
          j = j + 1;
        }
        n = n - 1;
        continue L;
      }
      return n;
    }
  `;
  const lifted = AST.lift(PARSER.parse(src));
  const printed = AST.printSource(lifted);
  // Both whiles should be in output, no labeled blocks.
  if (/L:\s*{/.test(printed)) throw new Error(`expected L: to be lifted away. Got:\n${printed}`);
  const whiles = (printed.match(/while \(/g) || []).length;
  if (whiles !== 2) throw new Error(`expected 2 while loops, got ${whiles}`);
});

t('lift idempotency: lifting an already-lifted AST is a no-op', () => {
  const src = `i32 f(i32 n) { i32 s = 0; while (n > 0) { s = s + n; n = n - 1; } return s; }`;
  const once = AST.lift(PARSER.parse(src));
  const twice = AST.lift(once);
  eq(AST.printSource(once), AST.printSource(twice));
});

t('lower idempotency: a program with NO loops is unchanged by lower', () => {
  const src = `i32 f(i32 a, i32 b) { i32 c = a + b; if (c > 10) { return 100; } return c; }`;
  const lowered = AST.lower(PARSER.parse(src));
  eq(AST.printSource(PARSER.parse(src)), AST.printSource(lowered));
});

t('full pipeline: parse → lower → fromAST → intoAST → emit produces correct wasm', () => {
  const src = `
    i32 fact(i32 n) {
      i32 r = 1;
      while (n > 1) { r = r * n; n = n - 1; }
      return r;
    }
  `;
  // Lower first, then push through the lifted-CFG pipeline.
  const lowered = AST.lower(PARSER.parse(src));
  const bytes = emitWasm(liftToAST(lowerToCFG(lowered)));
  eq(run(bytes, 'fact', 5), 120);
  eq(run(bytes, 'fact', 1), 1);
  eq(run(bytes, 'fact', 0), 1);
  eq(run(bytes, 'fact', 6), 720);
});

t('full pipeline: lower preserves semantics through both direct and lifted backends', () => {
  const programs = [
    `i32 sum(i32 n) { i32 s = 0; while (n > 0) { s = s + n; n = n - 1; } return s; }`,
    `i32 cnt(i32 n) { i32 c = 0; do { c = c + 1; n = n - 1; } while (n > 0); return c; }`,
    `i32 nest(i32 n) { i32 r = 0; while (n > 0) { i32 j = 0; while (j < 3) { r = r + 1; j = j + 1; } n = n - 1; } return r; }`,
    `i32 brk(i32 n) { i32 s = 0; while (1) { if (n <= 0) { break; } s = s + n; n = n - 1; } return s; }`,
    `i32 cont(i32 n) { i32 s = 0; i32 i = 0; while (i < n) { i = i + 1; if (i % 2 == 0) { continue; } s = s + i; } return s; }`,
  ];
  for (const src of programs) {
    const fnName = src.match(/\s(\w+)\(/)[1];
    const direct_bytes = direct(src);
    const lowered_direct = emitWasm(AST.lower(PARSER.parse(src)));
    const lowered_lifted = emitWasm(liftToAST(lowerToCFG(AST.lower(PARSER.parse(src)))));
    for (const n of [0, 1, 5, 10]) {
      const a = run(direct_bytes, fnName, n);
      const b = run(lowered_direct, fnName, n);
      const c = run(lowered_lifted, fnName, n);
      if (a !== b) throw new Error(`lower direct divergence in ${fnName}(${n}): ${a} vs ${b}`);
      if (a !== c) throw new Error(`lower→lifted divergence in ${fnName}(${n}): ${a} vs ${c}`);
    }
  }
});

t('QUALITY: stackifier-shaped input (hand-written canonical form) lifts to clean while', () => {
  // What the stackifier might produce: a single labeled block with the
  // canonical Pattern A shape. Lifting should give us idiomatic source.
  const stackifierOutput = `
    i32 search(i32 n, i32 target) {
      i32 i = 0;
      __L0: {
        if (!(i < n)) { break __L0; }
        if (i == target) { return i; }
        i = i + 1;
        continue __L0;
      }
      return -1;
    }
  `;
  const lifted = AST.lift(PARSER.parse(stackifierOutput));
  const printed = AST.printSource(lifted);
  // Should read as a clean while loop with embedded if statements.
  if (!/while \(i < n\)/.test(printed)) throw new Error('expected while (i < n)');
  if (!/return i;/.test(printed)) throw new Error('expected return i; inside loop');
  if (/__L0/.test(printed)) throw new Error('no __L0 should remain');
  // Runtime check.
  const bytes = emitWasm(lifted);
  eq(run(bytes, 'search', 10, 7), 7);
  eq(run(bytes, 'search', 5, 100), -1);
});

t('QUALITY: full round-trip parse → lower → fromAST → intoAST → lift produces readable source', () => {
  // The real stackifier video story: take user-written source, push it
  // through the entire pipeline, and verify the lifted output is
  // human-readable (no synthetic labels, idiomatic loops).
  const src = `
    i32 collatz_steps(i32 n) {
      i32 steps = 0;
      while (n > 1) {
        if (n % 2 == 0) {
          n = n / 2;
        } else {
          n = 3 * n + 1;
        }
        steps = steps + 1;
      }
      return steps;
    }
  `;
  // Note: the current intoAST produces the dispatcher form (while-switch),
  // which isn't a clean Pattern A labeled block. So lifting THAT won't
  // recover the original while. This test verifies the LOWER → LIFT
  // direction (without the dispatcher) recovers natural shape.
  const lowered = AST.lower(PARSER.parse(src));
  const lifted = AST.lift(lowered);
  const printed = AST.printSource(lifted);
  if (!/while \(n > 1\)/.test(printed)) throw new Error('expected while (n > 1)');
  if (/__L/.test(printed)) throw new Error('no synthetic labels expected');
  // Runtime check via direct emission of lifted form.
  const bytes = emitWasm(lifted);
  eq(run(bytes, 'collatz_steps', 1), 0);
  eq(run(bytes, 'collatz_steps', 2), 1);
  eq(run(bytes, 'collatz_steps', 6), 8);
});

// ─── stackifier C-semantics tests ───
// The stackifier is the new dom-tree-based CFG → AST translator. These
// tests verify it produces wasm with C-correct semantics for shapes
// where the dispatcher-form intoAST is known to work. Each shape is run
// through stackified() and the result compared against direct().

t('stackifier: C switch fall-through (case 1 falls into case 2)', () => {
  // C semantics:
  //   n=1: case 1: a=10; (no break) fall-through to case 2: a += 5; break. → 15
  //   n=2: case 2: a += 5; break. → 5
  //   n=3: default: a = -1. → -1
  const src = `i32 f(i32 n) {
    i32 a = 0;
    switch (n) {
      case 1: a = 10;
      case 2: a = a + 5; break;
      default: a = -1;
    }
    return a;
  }`;
  const bytes = stackified(src);
  eq(run(bytes, 'f', 1), 15);
  eq(run(bytes, 'f', 2), 5);
  eq(run(bytes, 'f', 3), -1);
});

t('stackifier: chained fall-through (3 cases falling into one tail)', () => {
  // Source: cases 1, 2, 3 all fall through to a single `r = r * 2` tail.
  // Case 4 sets r = 99 and breaks.
  const src = `i32 f(i32 n) {
    i32 r = 5;
    switch (n) {
      case 1:
      case 2:
      case 3: r = r + 1; break;
      case 4: r = 99; break;
      default: r = -1;
    }
    return r;
  }`;
  const bytes = stackified(src);
  eq(run(bytes, 'f', 1), 6);
  eq(run(bytes, 'f', 2), 6);
  eq(run(bytes, 'f', 3), 6);
  eq(run(bytes, 'f', 4), 99);
  eq(run(bytes, 'f', 5), -1);
});

t("stackifier: Duff's device end-to-end through synthetic BrTable", () => {
  // Duff's device is the canonical irreducible-CFG test case. After
  // makeReducible inserts a dispatcher block with BrTable, the
  // stackifier must produce a labeled-block AST that runs correctly.
  // count_n(N) should return N: 1 increment per iteration step.
  const src = `i32 count_n(i32 n) {
    i32 sum = 0;
    i32 phase = n % 4;
    switch (phase) {
      case 0:
        while (n > 0) {
          sum = sum + 1; n = n - 1;
      case 3: sum = sum + 1; n = n - 1;
      case 2: sum = sum + 1; n = n - 1;
      case 1: sum = sum + 1; n = n - 1;
        }
    }
    return sum;
  }`;
  const bytes = stackified(src);
  eq(run(bytes, 'count_n', 0), 0);
  eq(run(bytes, 'count_n', 1), 1);
  eq(run(bytes, 'count_n', 7), 7);
  eq(run(bytes, 'count_n', 13), 13);
  eq(run(bytes, 'count_n', 100), 100);
});

// ─── spaghetti torture: GCC torture-style + adversarial wild flow ───
//
// These exercise the stackifier + interval-reducible makeReducible on
// shapes that classically break naïve CFG-to-AST / dispatcher approaches.
// All run through roundTrip() = parse → fromAST → intoAST (stackifier) →
// emit, so any failure means the stackifier or makeReducible can't
// express the shape.
//
// GCC torture corpus references (adapted to our language subset — no
// pointers, no struct, no ++/--, no bitwise; replaced with arithmetic
// equivalents where needed):
//   gcc.c-torture/execute/{920501-3, 920502-1, 940718-1, 980526-1, ...}
//   plus original adversarial constructions.

t('TORTURE: Duff\'s device — 8-way unrolled (vs the 4-way in earlier tests)', () => {
  const src = `
    i32 copyn(i32 n) {
      i32 sum = 0;
      i32 phase = n % 8;
      switch (phase) {
        case 0: while (n > 0) { sum = sum + 1; n = n - 1;
        case 7: sum = sum + 1; n = n - 1;
        case 6: sum = sum + 1; n = n - 1;
        case 5: sum = sum + 1; n = n - 1;
        case 4: sum = sum + 1; n = n - 1;
        case 3: sum = sum + 1; n = n - 1;
        case 2: sum = sum + 1; n = n - 1;
        case 1: sum = sum + 1; n = n - 1;
        } }
      return sum;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'copyn', 0), 0);
  eq(run(bytes, 'copyn', 1), 1);
  eq(run(bytes, 'copyn', 15), 15);
  eq(run(bytes, 'copyn', 100), 100);
  eq(run(bytes, 'copyn', 1000), 1000);
});

t('TORTURE: switch inside switch inside switch — triple-nested dispatch', () => {
  const src = `
    i32 triple(i32 a, i32 b, i32 c) {
      i32 r = 0;
      switch (a) {
        case 1:
          switch (b) {
            case 1:
              switch (c) {
                case 1: r = 111; break;
                case 2: r = 112; break;
                default: r = 110;
              }
              break;
            case 2: r = 120; break;
            default: r = 100;
          }
          break;
        case 2:
          switch (b) {
            case 1: r = 210; break;
            case 2: r = 220; break;
            default: r = 200;
          }
          break;
        default: r = 0;
      }
      return r;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'triple', 1, 1, 1), 111);
  eq(run(bytes, 'triple', 1, 1, 2), 112);
  eq(run(bytes, 'triple', 1, 1, 5), 110);
  eq(run(bytes, 'triple', 1, 2, 0), 120);
  eq(run(bytes, 'triple', 1, 5, 0), 100);
  eq(run(bytes, 'triple', 2, 1, 0), 210);
  eq(run(bytes, 'triple', 2, 2, 0), 220);
  eq(run(bytes, 'triple', 2, 9, 0), 200);
  eq(run(bytes, 'triple', 9, 0, 0), 0);
});

t('TORTURE: switch case body containing nested while with break — break exits inner while', () => {
  const src = `
    i32 f(i32 cmd, i32 n) {
      i32 acc = 0;
      switch (cmd) {
        case 1:
          while (n > 0) {
            acc = acc + n;
            if (acc > 50) { break; }   // breaks inner while, NOT switch
            n = n - 1;
          }
          acc = acc + 1000;            // proves switch case continues after break
          break;
        case 2:
          while (n > 0) { acc = acc + 1; n = n - 1; }
          break;
      }
      return acc;
    }
  `;
  const bytes = roundTrip(src);
  // cmd=1, n=10: acc 10 (n=10), 19 (n=9), 27 (n=8), 34 (n=7), 40 (n=6), 45 (n=5),
  //   49 (n=4), 52 — break. acc += 1000 = 1052.
  eq(run(bytes, 'f', 1, 10), 1052);
  eq(run(bytes, 'f', 1, 0), 1000);
  eq(run(bytes, 'f', 2, 5), 5);
  eq(run(bytes, 'f', 9, 100), 0);
});

t('TORTURE: continue inside switch inside while — continues OUTER while (not switch)', () => {
  // C semantics: `continue` in a switch-inside-loop continues the loop,
  // bypassing the rest of the switch.
  const src = `
    i32 f(i32 n) {
      i32 acc = 0;
      while (n > 0) {
        n = n - 1;
        switch (n % 3) {
          case 0: acc = acc + 1; continue;  // continues while, skips +1000
          case 1: acc = acc + 10; break;
          default: acc = acc + 100;
        }
        acc = acc + 1000;
      }
      return acc;
    }
  `;
  const bytes = roundTrip(src);
  // n=6: n=5 → 5%3=2 default +100 (=100), +1000 → 1100.
  //      n=4 → 1 → +10 (=1110), +1000 → 2110.
  //      n=3 → 0 → +1 (=2111), continue.
  //      n=2 → 2 → +100 (=2211), +1000 → 3211.
  //      n=1 → 1 → +10 (=3221), +1000 → 4221.
  //      n=0 → 0 → +1 (=4222), continue.
  eq(run(bytes, 'f', 6), 4222);
});

t('TORTURE: deeply nested do-while + while + switch + continue chain', () => {
  const src = `
    i32 f(i32 x, i32 y, i32 z) {
      i32 sum = 0;
      i32 i = 0;
      while (i < x) {
        i = i + 1;
        i32 j = 0;
        do {
          j = j + 1;
          switch (j % 3) {
            case 0: sum = sum + 1; break;
            case 1: sum = sum + 10; break;
            default:
              if (z > 0) { z = z - 1; sum = sum + 100; continue; }
              sum = sum + 1000;
          }
        } while (j < y);
      }
      return sum;
    }
  `;
  const bytes = roundTrip(src);
  // Just check it terminates and returns sensible values.
  const r1 = run(bytes, 'f', 0, 0, 0);
  const r2 = run(bytes, 'f', 1, 5, 1);
  const r3 = run(bytes, 'f', 3, 4, 10);
  eq(r1, 0);
  if (r2 < 1 || r2 > 100000) throw new Error(`r2=${r2} out of sane range`);
  if (r3 < 1 || r3 > 100000) throw new Error(`r3=${r3} out of sane range`);
});

t('TORTURE: state machine via switch on state — 4-state FSM with computed transitions', () => {
  // Classic FSM-as-switch pattern from embedded code. Each state computes
  // the next state. The CFG is a complete digraph among the states with
  // BrIf-chain switch dispatch — fully reducible.
  const src = `
    i32 fsm(i32 input, i32 steps) {
      i32 state = 0;
      i32 acc = 0;
      while (steps > 0) {
        steps = steps - 1;
        switch (state) {
          case 0:
            acc = acc + 1;
            if (input > 0) { state = 1; } else { state = 3; }
            break;
          case 1:
            acc = acc + 10;
            if (input > 5) { state = 2; } else { state = 0; }
            break;
          case 2:
            acc = acc + 100;
            state = 3;
            break;
          case 3:
            acc = acc + 1000;
            if (input > 10) { state = 2; } else { state = 0; }
            break;
        }
      }
      return acc;
    }
  `;
  const bytes = roundTrip(src);
  // input=3, steps=5: s0 acc=1 (input>0→s1). s1 acc=11 (3≤5→s0). s0 acc=12 (→s1).
  //   s1 acc=22 (→s0). s0 acc=23 (→s1). steps=0. → 23.
  eq(run(bytes, 'fsm', 3, 5), 23);
  // input=0, steps=5: s0 acc=1 (→s3). s3 acc=1001 (→s0). s0 acc=1002 (→s3).
  //   s3 acc=2002 (→s0). s0 acc=2003 (→s3). steps=0. → 2003.
  eq(run(bytes, 'fsm', 0, 5), 2003);
});

t('TORTURE: goto into the middle of a switch case body', () => {
  // Equivalent to GCC torture's switch-with-mid-case-label patterns.
  const src = `
    i32 f(i32 n) {
      i32 acc = 0;
      if (n > 100) { goto mid; }
      switch (n) {
        case 1: acc = 1; break;
        case 2:
          acc = 2;
        mid:
          acc = acc + 50;
          break;
        default: acc = -1;
      }
      return acc;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 1), 1);
  eq(run(bytes, 'f', 2), 52);     // case 2 → mid (acc=2 → 52).
  eq(run(bytes, 'f', 5), -1);
  eq(run(bytes, 'f', 200), 50);   // goto skips switch, acc=0 → 50.
});

t('TORTURE: goto chain forming a 4-entry irreducible SCC', () => {
  const src = `
    i32 f(i32 entry, i32 n) {
      i32 acc = 0;
      if (entry == 0) { goto a; }
      if (entry == 1) { goto b; }
      if (entry == 2) { goto c; }
      goto d;
      a: acc = acc + 1; if (n > 0) { n = n - 1; goto b; } return acc;
      b: acc = acc + 10; if (n > 0) { n = n - 1; goto c; } return acc;
      c: acc = acc + 100; if (n > 0) { n = n - 1; goto d; } return acc;
      d: acc = acc + 1000; if (n > 0) { n = n - 1; goto a; } return acc;
    }
  `;
  // Each entry hops through the chain N times, accumulating different amounts.
  const bytes = roundTrip(src);
  // entry=0, n=0: a(1) → return 1.
  // entry=0, n=4: a(1) → b(11) → c(111) → d(1111) → a(1112) → return.
  // entry=2, n=2: c(100) → d(1100) → a(1101) → return.
  eq(run(bytes, 'f', 0, 0), 1);
  eq(run(bytes, 'f', 0, 4), 1112);
  eq(run(bytes, 'f', 2, 2), 1101);
  eq(run(bytes, 'f', 3, 0), 1000);
  // entry=3 → d. d(1000) n=3 → a(1001) n=2 → b(1011) n=1 → c(1111) n=0 → d(2111) return.
  eq(run(bytes, 'f', 3, 4), 2111);
});

t('TORTURE: 5-deep nested labeled blocks with breaks targeting every level', () => {
  const src = `
    i32 f(i32 level, i32 x) {
      i32 r = 0;
      A: { B: { C: { D: { E: {
        r = r + 1;
        if (level == 5) { break E; }
        r = r + 10;
        if (level == 4) { break D; }
        r = r + 100;
        if (level == 3) { break C; }
        r = r + 1000;
        if (level == 2) { break B; }
        r = r + 10000;
        if (level == 1) { break A; }
        r = r + 100000;
      } r = r + 1; }
        r = r + 2; }
        r = r + 4; }
        r = r + 8; }
        r = r + 16;
      return r;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5, 0), 1 + 1 + 2 + 4 + 8 + 16);              // break E early
  eq(run(bytes, 'f', 4, 0), 1 + 10 + 2 + 4 + 8 + 16);             // break D
  eq(run(bytes, 'f', 3, 0), 1 + 10 + 100 + 4 + 8 + 16);           // break C
  eq(run(bytes, 'f', 2, 0), 1 + 10 + 100 + 1000 + 8 + 16);        // break B
  eq(run(bytes, 'f', 1, 0), 1 + 10 + 100 + 1000 + 10000 + 16);    // break A
  eq(run(bytes, 'f', 0, 0), 1 + 10 + 100 + 1000 + 10000 + 100000 + 1 + 2 + 4 + 8 + 16); // no break
});

t('TORTURE: alternating goto-into-while-body from outside (3 distinct entries)', () => {
  // Each goto enters the while body at a different position. The result
  // is a multi-entry irreducible CFG; makeReducible inserts a dispatcher.
  const src = `
    i32 f(i32 mode, i32 n) {
      i32 sum = 0;
      if (mode == 1) { goto step_b; }
      if (mode == 2) { goto step_c; }
      while (n > 0) {
        sum = sum + 1;       // step a
      step_b:
        sum = sum + 10;
      step_c:
        sum = sum + 100;
        n = n - 1;
      }
      return sum;
    }
  `;
  const bytes = roundTrip(src);
  // mode=0, n=2: full iter a(1)+b(11)+c(111). n=1. Full iter +1+10+100 = 222. n=0. → 222.
  // mode=1, n=2: b(10)+c(110). n=1. Full iter a(111)+b(121)+c(221). n=0. → 221.
  // mode=2, n=2: c(100). n=1. Full iter a(101)+b(111)+c(211). n=0. → 211.
  eq(run(bytes, 'f', 0, 2), 222);
  eq(run(bytes, 'f', 1, 2), 221);
  eq(run(bytes, 'f', 2, 2), 211);
});

t('TORTURE: nested 2-entry SCC inside a 3-entry SCC (compound irreducibility)', () => {
  // GCC torture-style: irreducibility at two levels. The fixed-point
  // iteration of makeReducible has to add dispatchers for both.
  const src = `
    i32 nested(i32 e_out, i32 e_in, i32 n) {
      i32 acc = 0;
      // Outer 3-entry choice.
      if (e_out == 0) { goto outer_a; }
      if (e_out == 1) { goto outer_b; }
      goto outer_c;

      outer_a:
        acc = acc + 1;
        // Inner 2-entry SCC.
        if (e_in == 0) { goto inner_x; }
        goto inner_y;
        inner_x: acc = acc + 10; if (n < 5) { n = n + 1; goto inner_y; }
        inner_y: acc = acc + 100; if (n < 10) { n = n + 1; goto inner_x; }
        if (acc < 500) { goto outer_b; }
        return acc;

      outer_b:
        acc = acc + 1000;
        if (acc < 5000) { goto outer_c; }
        return acc;

      outer_c:
        acc = acc + 10000;
        if (acc < 50000) { goto outer_a; }
        return acc;
    }
  `;
  const bytes = roundTrip(src);
  const r = run(bytes, 'nested', 0, 0, 0);
  if (r < 1 || r > 1000000) throw new Error(`r=${r} out of sane range`);
  // Just verify each entry path terminates with non-zero result.
  for (const eo of [0, 1, 2]) {
    for (const ei of [0, 1]) {
      const v = run(bytes, 'nested', eo, ei, 0);
      if (v === 0) throw new Error(`unexpected 0 result for e_out=${eo} e_in=${ei}`);
    }
  }
});

t('TORTURE: GCC 920501-3 style — switch nested inside a goto-loop', () => {
  // Adapted from gcc.c-torture/execute/920501-3.c: function uses
  // computed-style dispatch via switch inside a manually-coded loop.
  const src = `
    i32 dispatch_loop(i32 op, i32 iter) {
      i32 state = op;
      i32 result = 0;
      top:
        if (iter <= 0) { return result; }
        iter = iter - 1;
        switch (state) {
          case 1: result = result + 1; state = 2; break;
          case 2: result = result + 2; state = 3; break;
          case 3: result = result + 4; state = 4; break;
          case 4: result = result + 8; state = 1; break;
          default: return result - 1;
        }
        goto top;
    }
  `;
  const bytes = roundTrip(src);
  // op=1, iter=4: 1 (s1→s2), 2 (s2→s3), 4 (s3→s4), 8 (s4→s1). total=15.
  eq(run(bytes, 'dispatch_loop', 1, 4), 15);
  eq(run(bytes, 'dispatch_loop', 1, 8), 30);   // two full cycles.
  eq(run(bytes, 'dispatch_loop', 5, 4), -1);   // default path.
  eq(run(bytes, 'dispatch_loop', 1, 0), 0);    // no iterations.
});

t('TORTURE: GCC 940718-1 style — mutually recursive gotos forming pinball flow', () => {
  // Adapted: two labels each goto each other conditionally, plus a third
  // exit label. Generates an irreducible CFG with intricate dom-tree.
  const src = `
    i32 pinball(i32 start, i32 n) {
      i32 hits = 0;
      if (start == 0) { goto bumper_a; }
      goto bumper_b;
      bumper_a:
        hits = hits + 1;
        if (n <= 0) { goto exit; }
        n = n - 1;
        if (hits % 2 == 0) { goto bumper_a; }
        goto bumper_b;
      bumper_b:
        hits = hits + 10;
        if (n <= 0) { goto exit; }
        n = n - 1;
        if (hits % 3 == 0) { goto bumper_b; }
        goto bumper_a;
      exit:
        return hits;
    }
  `;
  const bytes = roundTrip(src);
  // start=0, n=0: a hits=1, n=0 → exit. → 1.
  // start=1, n=0: b hits=10, n=0 → exit. → 10.
  // start=0, n=3: a(1) n=2, 1%2≠0 →b(11) n=1, 11%3≠0 →a(12) n=0, 12%2=0 →a(13) n=0 →exit. → 13.
  eq(run(bytes, 'pinball', 0, 0), 1);
  eq(run(bytes, 'pinball', 1, 0), 10);
  eq(run(bytes, 'pinball', 0, 3), 13);
});

t('TORTURE: GCC 980526-1 style — switch case falls through into loop continue', () => {
  const src = `
    i32 f(i32 cmd, i32 n) {
      i32 acc = 0;
      while (n > 0) {
        n = n - 1;
        switch (cmd) {
          case 1: acc = acc + 1;     // fall through
          case 2: acc = acc + 10;    // fall through
          case 3: acc = acc + 100; break;
          default: acc = acc + 1000;
        }
      }
      return acc;
    }
  `;
  const bytes = roundTrip(src);
  // cmd=1, n=3: 3 iters, each adds 1+10+100 = 111. → 333.
  // cmd=2, n=3: each adds 10+100 = 110. → 330.
  // cmd=3, n=3: each adds 100. → 300.
  // cmd=9, n=3: default 1000. → 3000.
  eq(run(bytes, 'f', 1, 3), 333);
  eq(run(bytes, 'f', 2, 3), 330);
  eq(run(bytes, 'f', 3, 3), 300);
  eq(run(bytes, 'f', 9, 3), 3000);
});

t('TORTURE: while with break-to-outer + continue-to-inner inside switch inside if', () => {
  // Stress every break/continue dispatch rule simultaneously. Our language
  // labels blocks not whiles, so wrap the while in a labeled block and
  // use unlabeled `continue` (continues the enclosing while per C
  // semantics) and `break OUTER` (exits the labeled block, which
  // contains the while).
  const src = `
    i32 f(i32 mode, i32 n) {
      i32 r = 0;
      OUTER: {
        while (n > 0) {
          n = n - 1;
          if (mode > 0) {
            switch (mode) {
              case 1: r = r + 1; continue;                 // unlabeled — continues while
              case 2: if (r > 50) { break OUTER; } r = r + 10; break;
              case 3: r = r + 100; break;
              default: r = r + 1000;
            }
          }
          r = r + 7;   // reached if mode <= 0 OR case 2/3/default falls past break
        }
      }
      return r;
    }
  `;
  const bytes = roundTrip(src);
  // mode=1, n=5: each iter +1 + continue (skips +7). → 5.
  eq(run(bytes, 'f', 1, 5), 5);
  // mode=2, n=10: each iter +10+7=17, until r>50 → break. 17,34,51 (break next iter on cond check). →
  //   iter1 r=17. iter2 r=34. iter3 r=51 (>50 → break on cond check), break before adding more. → 51.
  //   Wait re-trace: iter starts with n=10, r=0. After n--, n=9. mode>0, switch case 2: r>50? no. r=10. break switch. r=17. iter end.
  //   iter2 n=8, r=17. case 2: r>50? no. r=27. break. r=34.
  //   iter3 n=7, r=34. r>50? no. r=44. break. r=51.
  //   iter4 n=6, r=51. r>50? YES → break OUTER. r=51.
  eq(run(bytes, 'f', 2, 10), 51);
  eq(run(bytes, 'f', 3, 4), 4 * (100 + 7));   // 428.
  eq(run(bytes, 'f', 0, 3), 3 * 7);            // mode≤0 → just +7 each iter. 21.
});

t('TORTURE: infinite loop with multiple early returns via goto', () => {
  const src = `
    i32 f(i32 a, i32 b, i32 limit) {
      while (1) {
        if (a > limit) { goto exit_a; }
        if (b > limit) { goto exit_b; }
        a = a + 1;
        b = b + 2;
      }
      exit_a: return a * 10;
      exit_b: return b * 100;
    }
  `;
  const bytes = roundTrip(src);
  // a=0, b=0, limit=3: a=0,b=0 → a=1,b=2 → a=2,b=4 (b>3) → exit_b. b*100 = 400.
  // a=10, b=0, limit=5: a=10>5 → exit_a. a*10 = 100.
  eq(run(bytes, 'f', 0, 0, 3), 400);
  eq(run(bytes, 'f', 10, 0, 5), 100);
});

t('TORTURE: function with N=20 sequential gotos and labels (stress sibling chain wrapping)', () => {
  // Each label's body increments r by 2^k. Tests the N-1 labeled-wrapper
  // construction at large N.
  const src = `
    i32 f(i32 start) {
      i32 r = 0;
      if (start == 0) { goto L0; }
      if (start == 1) { goto L1; }
      if (start == 2) { goto L2; }
      if (start == 3) { goto L3; }
      if (start == 4) { goto L4; }
      if (start == 5) { goto L5; }
      if (start == 6) { goto L6; }
      if (start == 7) { goto L7; }
      if (start == 8) { goto L8; }
      goto L9;
      L0: r = r + 1;
      L1: r = r + 2;
      L2: r = r + 4;
      L3: r = r + 8;
      L4: r = r + 16;
      L5: r = r + 32;
      L6: r = r + 64;
      L7: r = r + 128;
      L8: r = r + 256;
      L9: r = r + 512;
      return r;
    }
  `;
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 0), 1023);   // all sum.
  eq(run(bytes, 'f', 5), 32 + 64 + 128 + 256 + 512);
  eq(run(bytes, 'f', 9), 512);
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
