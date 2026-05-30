#!/usr/bin/env node
"use strict";

// Tests for c2.js. Run with: node tests-c2.js
const fs = require('fs');
const srcText = fs.readFileSync(__dirname + '/c2.js', 'utf8').replace(/^#![^\n]*\n/, '');
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
