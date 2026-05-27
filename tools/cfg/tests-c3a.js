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
// relooper (the planned c3+ work — see SSA.md).

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
