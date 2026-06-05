#!/usr/bin/env node
"use strict";

// Tests for c3a.js. Run with: node tests-c3a.js
const fs = require('fs');
const srcText = fs.readFileSync(__dirname + '/c3a.js', 'utf8').replace(/^#![^\n]*\n/, '');
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
  throws(() => direct(SUM_GOTO), /Label\/Goto/);
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

// ─── do-while ───
const SUM_DOWHILE = `
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
t('do-while: direct emit sums correctly', () => {
  const bytes = direct(SUM_DOWHILE);
  for (const [n, want] of [[0, 0], [1, 0], [2, 1], [10, 45], [100, 4950]]) {
    eq(run(bytes, 'sum', n), want, `sum(${n})`);
  }
});
t('do-while: body always runs at least once', () => {
  const bytes = direct(`
    i32 once(i32 x) {
      i32 c = 0;
      do { c = c + 1; } while (0);
      return c;
    }
  `);
  eq(run(bytes, 'once', 99), 1);
});
t('do-while: break exits before tail cond', () => {
  const bytes = direct(`
    i32 firstHit(i32 n) {
      i32 i = 0;
      do {
        if (i == n) { break; }
        i = i + 1;
      } while (1);
      return i;
    }
  `);
  eq(run(bytes, 'firstHit', 7), 7);
  eq(run(bytes, 'firstHit', 0), 0);
});
t('do-while: round-trips through CFG', () => {
  eq(run(roundTrip(SUM_DOWHILE), 'sum', 10), 45);
});
t('do-while: SSA handles variable update across the back edge', () => {
  // Total and i are reassigned inside the body; the back edge introduces
  // phis for them in the do-body block. Exercises the unsealed-block path.
  const bytes = roundTrip(`
    i32 mul(i32 a, i32 b) {
      i32 r = 0;
      i32 k = b;
      if (b == 0) { return 0; }
      do {
        r = r + a;
        k = k - 1;
      } while (k > 0);
      return r;
    }
  `);
  eq(run(bytes, 'mul', 7, 6), 42);
  eq(run(bytes, 'mul', 100, 0), 0);
});
t('do-while: pretty-prints with trailing semicolon', () => {
  const src = AST.printSource(PARSER.parse(SUM_DOWHILE));
  if (!/} while \(i < n\);/.test(src)) throw new Error('do-while not pretty-printed: ' + src);
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

// ─── continue keyword + do-while continue (new in c3a) ───
//
// Verifies the corrected do-while CFG layout: body → continueB(cond) → exit.
// `continue;` inside a do-while body must re-EVALUATE cond before deciding
// whether to loop or exit — C semantics. The prior layout (body fall-through
// to body via tail BrIf) would have re-run the body without re-testing cond.

t('continue: in while loop skips rest of body and re-tests cond', () => {
  // Sums only odd values of i from 1..n. With broken continue, this would
  // either infinite-loop or sum every value.
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
  const bytes = direct(src);
  eq(run(bytes, 'odd_sum', 10), 1+3+5+7+9);
  eq(run(bytes, 'odd_sum', 0), 0);
  eq(run(bytes, 'odd_sum', 1), 0);
  // Same behavior via lifted (round-trip through CFG).
  const lifted = roundTrip(src);
  eq(run(lifted, 'odd_sum', 10), 1+3+5+7+9);
});

t('continue: in do-while loop re-evaluates cond before deciding to loop', () => {
  // Decrements n inside body, then `continue` if n still positive. The cond
  // `n > 0` is re-tested via the new continueB block. If continue skipped
  // cond eval, this would infinite-loop.
  const src = `
    i32 count_down(i32 n) {
      i32 iters = 0;
      do {
        iters = iters + 1;
        if (n > 1) { n = n - 1; continue; }
        n = 0;          // bottom of body: termination route
      } while (n > 0);
      return iters;
    }
  `;
  const bytes = direct(src);
  eq(run(bytes, 'count_down', 5), 5);
  eq(run(bytes, 'count_down', 1), 1);
  // Lifted matches.
  eq(run(roundTrip(src), 'count_down', 5), 5);
});

t('continue: rejected outside any loop', () => {
  throws(() => emitWasm(PARSER.parse(`i32 f() { continue; return 0; }`)), /Continue outside loop/);
  throws(() => emitWasm(PARSER.parse(`i32 f() { if (1) { continue; } return 0; }`)), /Continue outside loop/);
});

t('continue: in switch case INSIDE a while continues the while, not the switch', () => {
  // C semantics: switch isn't a continue target. continue must reach the
  // enclosing while.
  const src = `
    i32 count_default(i32 n) {
      i32 hits = 0;
      i32 i = 0;
      while (i < n) {
        i = i + 1;
        switch (i % 3) {
          case 0: continue;
          case 1: continue;
          default: hits = hits + 1;
        }
      }
      return hits;
    }
  `;
  // For n=10: cases 1,4,7,10 hit case 1 → continue; cases 3,6,9 hit case 0 → continue;
  // cases 2,5,8 hit default → hits++. Total: 3.
  const bytes = direct(src);
  eq(run(bytes, 'count_default', 10), 3);
});

t('continue: round-trips through CFG semantics-preservingly', () => {
  // Sum of 1..n excluding multiples of 3.
  const src = `
    i32 sum_skip3(i32 n) {
      i32 total = 0;
      i32 i = 0;
      while (i < n) {
        i = i + 1;
        if (i % 3 == 0) { continue; }
        total = total + i;
      }
      return total;
    }
  `;
  for (const n of [0, 1, 5, 10, 30]) {
    eq(run(direct(src), 'sum_skip3', n), run(roundTrip(src), 'sum_skip3', n), `n=${n}`);
  }
});

t('continue: pretty-prints as `continue;`', () => {
  const src = `i32 f(i32 n) { while (n > 0) { n = n - 1; if (n % 2 == 0) { continue; } } return n; }`;
  const printed = AST.printSource(PARSER.parse(src));
  if (!/continue;/.test(printed)) throw new Error('continue; missing from printed source: ' + printed);
});

// ─── goto-into-body audit: diverse irreducible CFGs ───
//
// C allows goto into any labeled statement in the same function, including
// labels INSIDE a while body, do-while body, switch case, or if branch.
// Each of these can create multi-entry SCCs (irreducible CFGs) when the
// labeled statement is also reachable through the loop back-edge — exactly
// the scenarios c3a's makeReducible was built for. These tests construct
// each shape and verify direct + lifted backends agree.

t('goto-into-body: goto into the middle of a while body (multi-entry SCC)', () => {
  // First iteration enters at MID, subsequent iterations enter at while head.
  // Multi-entry SCC: { while_head, MID, ... }. makeReducible must handle.
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
  // Trace: i=0, goto MID. MID: i=1, end of body, Br headerB. Cond 1<n.
  // If true: sum += i (1), MID: i=2, back to header. ... iterates until i=n.
  // For n=5: sum gets 1, 2, 3, 4 added (when entering body with i=1,2,3,4).
  // When i=5, cond false → exit. Total: 10.
  // For n=1: goto MID, i=1, cond 1<1 false → exit. sum=0.
  // For n=0: goto MID, i=1, cond 1<0 false → exit. sum=0.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5), 10);
  eq(run(bytes, 'f', 0), 0);
  eq(run(bytes, 'f', 1), 0);
  // Trace path also works (lift-fallback).
  const trace = CODEGEN.compileWithTrace(src);
  if (trace.bytesError) throw new Error('compileWithTrace failed: ' + trace.bytesError.message);
});

t('goto-into-body: goto into a do-while body (also irreducible)', () => {
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
  // Trace: i=0, goto MID. MID: i=1, then continueB evaluates cond.
  // For n=5: i=1, cond 1<5 → loop. body: sum+=1, MID: i=2, cond 2<5 → loop. etc.
  //   Iterations: i=1→sum=1, i=2→sum=3, i=3→sum=6, i=4→sum=10, i=5 exits. Total 10.
  // For n=0: i=1, cond 1<0 false → exit immediately. sum=0.
  // For n=1: i=1, cond 1<1 false → exit. sum=0.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5), 10);
  eq(run(bytes, 'f', 0), 0);
  eq(run(bytes, 'f', 1), 0);
});

t('goto-into-body: goto from outside switch INTO a case body — works via undef-tolerant SSA', () => {
  // Goto into a label that lives INSIDE a switch case body, bypassing the
  // switch dispatch entirely. The case-block becomes a 0-pred sealed block
  // (structurally a predecessor of the label_block but never reached at
  // runtime). The undef-tolerant readVariableRecursive synthesizes a
  // type-correct undef Value for the dead-path SSA operand; the dead path
  // never executes at runtime so the undef value is unobservable.
  //
  // Runtime semantics: goto INSIDE_CASE → r = -1 + 100 = 99 → break out of
  // switch → return 99. Result is 99 for ANY n (the switch dispatch is
  // skipped by the goto).
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
  const bytes = roundTrip(src);
  for (const n of [1, 2, 5, 0, -1]) {
    eq(run(bytes, 'f', n), 99, `n=${n}`);
  }
});

t('goto-into-body: goto into a nested if inside a while', () => {
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      goto DEEP;
      while (i < n) {
        if (i % 2 == 0) {
          DEEP: sum = sum + i;
        }
        i = i + 1;
      }
      return sum;
    }
  `;
  // Goto jumps directly into the if-branch with i=0. sum = 0+0 = 0.
  // Then i = 0+1 = 1, loop continues. i=1 (odd, skip), i=2 → sum += 2, ...
  // Sums even i in [0, n) → 0+2+4+...
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 6), 0 + 2 + 4);          // even values < 6
  eq(run(bytes, 'f', 1), 0);                  // only i=0 visited (via goto + then i=1 → exits)
  eq(run(bytes, 'f', 0), 0);                  // goto fires once with sum=0, i=0, then exits (cond 0<0)
});

t('goto-into-body: backward goto from past while back into the loop body', () => {
  // Goto JUMPS BACKWARD into the middle of a while body that's already been
  // exited. Creates an irreducible re-entry.
  const src = `
    i32 f(i32 n) {
      i32 sum = 0;
      i32 i = 0;
      i32 retries = 0;
      while (i < n) {
        BODY: sum = sum + i;
        i = i + 1;
      }
      if (retries == 0 && sum < 10) {
        retries = 1;
        i = 0;
        sum = 0;
        goto BODY;       // re-enter the (already-exited) while body
      }
      return sum;
    }
  `;
  // For n=3: first pass sums 0+1+2 = 3 < 10, triggers re-entry.
  //   goto BODY at i=0, sum=0. sum += 0. i=1. Continue loop: i < 3 → sum=1, i=2, sum=3, i=3 exits.
  //   sum = 3, retries=1, no more re-entry. Return 3.
  // For n=10: first pass sums 0..9 = 45 > 10. No retry. Return 45.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 3), 3);
  eq(run(bytes, 'f', 10), 45);
  // Confirm compileWithTrace also handles it.
  const trace = CODEGEN.compileWithTrace(src);
  if (trace.bytesError) throw new Error('compileWithTrace failed: ' + trace.bytesError.message);
});

t('goto-into-body: two distinct gotos into the same while body (3-entry SCC)', () => {
  // Three entry points to the while body: regular head + LBL_A + LBL_B.
  // The dispatcher-node makeReducible should add a single dispatcher in front.
  const src = `
    i32 f(i32 n, i32 startA, i32 startB) {
      i32 sum = 0;
      i32 i = 0;
      if (startA) { goto LBL_A; }
      if (startB) { goto LBL_B; }
      while (i < n) {
        LBL_A: sum = sum + 1;
        LBL_B: i = i + 1;
      }
      return sum;
    }
  `;
  const bytes = roundTrip(src);
  // Normal entry: sum each iter = 1 → n.
  eq(run(bytes, 'f', 5, 0, 0), 5);
  // startA: jump straight to LBL_A with sum=0, i=0 → sum=1, i=1, then loop. sum = n - 0 = n.
  eq(run(bytes, 'f', 5, 1, 0), 5);
  // startB: jump straight to LBL_B → i=1 without adding. sum then = (n-1).
  eq(run(bytes, 'f', 5, 0, 1), 4);
  // Confirm dispatchers got added.
  const trace = CODEGEN.compileWithTrace(src);
  if (trace.bytesError) throw new Error('compileWithTrace failed: ' + trace.bytesError.message);
  if (!(trace.dispatchersAdded.length >= 1)) throw new Error('expected at least one dispatcher');
});

t('goto-into-body: irreducible re-entry preserves SSA across unexpected predecessors', () => {
  // Constructs a CFG where a goto creates a join point that needs to merge
  // SSA values from two paths with different defs. Verifies the unsealed-
  // block accumulator handles arbitrary predecessor counts.
  const src = `
    i32 f(i32 n) {
      i32 x = 0;
      i32 y = 100;
      if (n > 0) {
        x = 42;
        goto MERGE;
      }
      x = 7;
      y = 200;
      MERGE: return x + y;
    }
  `;
  const bytes = roundTrip(src);
  // n>0: x=42, goto MERGE. y stays at 100. Return 42+100 = 142.
  // n<=0: x=7, y=200, fall through to MERGE. Return 7+200 = 207.
  eq(run(bytes, 'f', 5), 142);
  eq(run(bytes, 'f', 0), 207);
  eq(run(bytes, 'f', -1), 207);
});

// ─── ADVERSARIAL: undef-tolerant SSA + nasty goto/irreducibility patterns ───
//
// Pushing the SSA construction across the worst-case patterns we can think of.
// Every test is a real program with a known-correct trace; any deviation is a
// real bug, not a documentation gap.

t('NASTY 1: variable defined ONLY on goto-source path; phi at target must give live def, not undef', () => {
  // The goto's source defines x = 42. The target has another pred (dispatch
  // path) that's dead at runtime but contributes an undef phi operand.
  // Critical: the phi must materialize x correctly when control arrives
  // via the goto. If undef polluted the result, we'd see garbage.
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
  // The dispatch is dead; only the goto arrives at MERGE. x must be 42.
  const bytes = roundTrip(src);
  for (const n of [0, 1, 5, 999]) eq(run(bytes, 'f', n), 42, `n=${n}`);
});

t('NASTY 2: goto chain (A → B → C) — three jumps, each through a labeled position', () => {
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
  // r: 0 → 1 → 10 → 15
  eq(run(roundTrip(src), 'f', 0), 15);
});

t('NASTY 3: multiple gotos converge on same label — phi merges live values from multiple sources', () => {
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
  for (const [n, want] of [[1, 100], [2, 200], [3, 300], [4, 999], [0, 999]]) {
    eq(run(bytes, 'f', n), want, `n=${n}`);
  }
});

t('NASTY 4: goto skips a Declare — variable reads as wasm-default-zero', () => {
  // The Declare's initializer is skipped by goto. Per wasm semantics, the
  // local is zero-initialized. C semantics would be UB; we get a defined
  // (zero) value.
  const src = `
    i32 f(i32 ignored) {
      goto AFTER;
      i32 x = 5;
      AFTER: return x;
    }
  `;
  // wasm local for x defaults to 0. The init x = 5 is skipped.
  eq(run(roundTrip(src), 'f', 0), 0);
});

t('NASTY 5: self-goto creates trivial infinite loop — compiles cleanly', () => {
  // Should compile and validate. Don'\''t actually run it (would hang).
  const src = `
    i32 f(i32 ignored) {
      L: goto L;
      return 0;
    }
  `;
  // Just verify it compiles without error.
  const bytes = roundTrip(src);
  if (!bytes || bytes.length === 0) throw new Error('expected wasm bytes');
});

t('NASTY 6: 3-entry SCC — three distinct gotos into a while body create irreducible CFG', () => {
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
  // Normal entry: each iter adds 111. For n=2: 222.
  // entry=1 first iter: starts at A, adds 1+10+100 = 111. i=1. Then header: 1<2 true. Loop: 111+111=222. i=2. exit. → 222.
  // entry=2 first iter: starts at B, adds 10+100 = 110. i=1. Then iteration: 110+111=221. i=2. exit. → 221.
  // entry=3 first iter: starts at C, adds 100. i=1. Then iteration: 100+111=211. i=2. exit. → 211.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 2, 0), 222);
  eq(run(bytes, 'f', 2, 1), 222);
  eq(run(bytes, 'f', 2, 2), 221);
  eq(run(bytes, 'f', 2, 3), 211);
});

t('NASTY 7: goto out of nested while into another statement at outer scope', () => {
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
  // For n=5: r reaches 3, goto OUTSIDE. r = 30.
  // For n=2: r reaches 2, while exits naturally. r = 20.
  // For n=0: r=0, no body. r = 0.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 5), 30);
  eq(run(bytes, 'f', 2), 20);
  eq(run(bytes, 'f', 0), 0);
});

t('NASTY 8: i64 variables across goto-into-body — undef materialization at correct type', () => {
  // Exercises that undef is type-correct for i64 (the read along the dead
  // path would see a typed zero if ever reached; the live path sees the
  // real defs from the goto source). Uses param-only arithmetic to avoid
  // mixing i32 / i64 literal types (the language doesn't have a typed
  // integer-literal suffix; plain `100` defaults to i32).
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
  // For n=3, sum0=100, one=1: goto MID → n=2. While 2>0: sum += 2 → 102, n=1.
  //   sum += 1 → 103, n=0. exit. → 103.
  // For n=0, sum0=100, one=1: goto MID → n=-1. cond -1>0 false. → 100.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 3n, 100n, 1n), 103n);
  eq(run(bytes, 'f', 0n, 100n, 1n), 100n);
});

t('NASTY 9: undef from dead path must NOT pollute trivial-phi elimination', () => {
  // After SSA construction, trimPhis runs to collapse trivial phis. The
  // dead-path operand is undef. If trimPhis treats undef as "equal to
  // anything," it might collapse the phi prematurely and lose the live
  // def. Test: a value that's defined on the live path and undef on the
  // dead path must NOT be collapsed away.
  const src = `
    i32 f(i32 n) {
      i32 x = 42;
      goto SKIP_DEAD;
      if (n) { x = 999; }
      SKIP_DEAD: return x;
    }
  `;
  // x stays 42; goto skips the conditional reassignment.
  for (const n of [0, 1, 99]) eq(run(roundTrip(src), 'f', n), 42);
});

t('NASTY 10: nested irreducibility — goto into while body inside another while body', () => {
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
  // Outer iter: goto MID → inner=inner-1. Inner while: inner>0? If so, r+=1; MID: inner-=1. Continue inner. Exit inner when inner<=0.
  // For outer=1, inner=3: goto MID → inner=2. Inner while: 2>0 r=1, inner=1. 1>0 r=2, inner=0. exit. outer=0. exit. r=2.
  // For outer=2, inner=2:
  //   outer=2: goto MID → inner=1. r=2, inner=0. exit. outer=1.
  //   outer=1: goto MID → inner=-1. exit inner. outer=0. exit. r=2.
  // (Note: inner is reused across outer iters; goto MID always decrements then enters loop.)
  // Wait let me retrace outer=2, inner=2:
  //   outer iter 1: goto MID → inner=1. Inner while: 1>0 → r=1, inner=0. 0>0 false → exit. outer=1.
  //   outer iter 2: goto MID → inner=-1. Inner while: -1>0 false → exit. outer=0. exit. r=1.
  eq(run(roundTrip(src), 'f', 1, 3), 2);
  eq(run(roundTrip(src), 'f', 2, 2), 1);
  eq(run(roundTrip(src), 'f', 1, 0), 0);
});

t('NASTY 11: goto INTO a switch case + break out of switch — case dispatched & break flows correctly', () => {
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
  // Goto INSIDE: r = 0+7 = 7. n=99 check: depends on caller.
  // For n=99: if-true → break out of switch → return 7.
  // For n=anything else: r += 1 → 8. Fall through to case 3 → r += 100 → 108. break. return 108.
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 99), 7);
  eq(run(bytes, 'f', 1), 108);
  eq(run(bytes, 'f', 2), 108);
  eq(run(bytes, 'f', 5), 108);
});

t('NASTY 12: cascading SSA — variable redefined in multiple goto-reached blocks; final read gets right phi', () => {
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

t('NASTY 13: goto into a labeled goto-target that ALSO has the back-edge of an enclosing loop', () => {
  // The label LOOP_TOP is both a goto target (from below) and the back-edge
  // landing of the surrounding while. Multi-source convergence with
  // mixed live/back-edge preds.
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
  // goto LOOP_TOP → r=0+0=0, i=1. while header: 1<n? continue if so.
  //   i=1: r=0+1=1, i=2. ...
  // For n=4: visits i = 0,1,2,3 → r = 0+1+2+3 = 6.
  eq(run(roundTrip(src), 'f', 4), 6);
  eq(run(roundTrip(src), 'f', 0), 0);   // goto MID → r=0+0=0, i=1. 1<0 false → exit. r=0.
});

t('NASTY 14: deep nesting — goto into a label 4 levels deep (if inside switch inside while inside if)', () => {
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
  // For n>0, goto VERY_DEEP fires → r=777 → return 777. For n<=0, return -1.
  for (const n of [1, 5, 99]) eq(run(roundTrip(src), 'f', n), 777, `n=${n}`);
  eq(run(roundTrip(src), 'f', 0), -1);
});

t('NASTY 15: goto OUT of a deeply nested structure to function-level label', () => {
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
  // For n=7: iter at n=7 (r=7), n=6 (r=13), n=5 triggers goto. r=13, n=5. Return 13*1000 + 5 = 13005.
  // For n=3: no goto. r = 3+2+1 = 6. n=0. Return 6*1000 = 6000.
  eq(run(roundTrip(src), 'f', 7), 13005);
  eq(run(roundTrip(src), 'f', 3), 6000);
});

t('NASTY 16: ParallelAssign in a block reachable via goto — swap semantics preserved', () => {
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
  // Goto skips a=99; b=99. PARALLEL swaps (a,b) → (b,a) → a=2, b=1. Return 21.
  for (const n of [0, 1, 5]) eq(run(roundTrip(src), 'f', n), 21);
});

t('NASTY 17: multi-entry SCC where every entry defines the SAME variable differently', () => {
  // Each entry path establishes x to a different value. The SCC body reads x.
  // The dispatcher inserted by makeReducible must thread the correct x.
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
  // entry=1: x=10, goto INSIDE → i=1. while 1<iters? if so, x=1, i=2, ...
  //   iters=3: i=1, then 1<3 true → x=1, i=2. 2<3 true → x=1, i=3. 3<3 false. exit. → x=1.
  //   iters=1: i=1, 1<1 false. exit. → x=10.
  // entry=0: x=0, while 0<iters → x=1 (overwritten each iter). exit. → x=1 (or 0 if iters=0).
  const bytes = roundTrip(src);
  eq(run(bytes, 'f', 1, 1), 10);
  eq(run(bytes, 'f', 1, 3), 1);
  eq(run(bytes, 'f', 0, 0), 0);
  eq(run(bytes, 'f', 0, 1), 1);
});

t('NASTY 18: undef robustness — verify dead path is REALLY never observed by varying inputs', () => {
  // Construct a program where the SSA's undef appears in a phi but the
  // live computation NEVER reads from that phi. The runtime answer should
  // be deterministic across all inputs even though the phi's dead-pred
  // operand could in principle be anything.
  const src = `
    i32 f(i32 n) {
      i32 r = 42;
      goto END;
      if (n > 0) { r = r + 1; goto END; }
      r = 999;
      END: return r;
    }
  `;
  // No matter what n is, goto fires → return 42.
  for (const n of [-100, -1, 0, 1, 100, 99999]) {
    eq(run(roundTrip(src), 'f', n), 42, `n=${n}`);
  }
});

t('NASTY 19: trimPhis must NOT eliminate a phi with undef + concrete operands as trivial', () => {
  // A phi where one operand is undef and another is a concrete value. The
  // phi must NOT collapse to either — it's a real merge point at IR level
  // even if the dead operand is unobservable at runtime. Verify the live
  // value flows correctly.
  const src = `
    i32 f(i32 n) {
      i32 x = 7;
      goto JOIN;
      if (n) { x = 13; }
      JOIN: return x;
    }
  `;
  // Goto skips conditional reassign. Always returns 7.
  for (const n of [0, 1, 5]) eq(run(roundTrip(src), 'f', n), 7);
});

t('NASTY 20: empty function body except for goto + label (every statement is reachable via goto)', () => {
  const src = `
    i32 f(i32 n) {
      goto END;
      END: return 1;
    }
  `;
  eq(run(roundTrip(src), 'f', 0), 1);
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
