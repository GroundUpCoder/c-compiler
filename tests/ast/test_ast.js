'use strict';

// JS-level unit tests for AST node invariants and the AST→AST optimizer.
//
// Covers what the .c-test suite can't hit directly:
//   - constructor validation (throws on bad input)
//   - Object.freeze enforcement on most Expr/Stmt
//   - linearity tagging (every subclass + bubble-up)
//   - walkExpr / _withChildren correctness
//   - TreeBag construction, iteration, has(), structural sharing
//   - referencedFunctions bubble-up (Expr + Stmt)
//   - TDIVERGENT type behavior in conversions
//   - make-helper recovery paths (placeholder DVars on missing names)
//   - INLINER constant folding + cascaded inlining + recursion bail
//   - diag pool: withDiag scoping, reportError, fatalError
//
// Each test runs in isolation, prints PASS/FAIL, exits non-zero on any
// failure.

const C = require('../../compiler.js');
const AST = C.AST;
const Types = C.Types;
const { withDiag, reportError, reportWarning, fatalError, FatalDiag } = C;
const INLINER = C.INLINER;
const Loc = C.LexResult ? null : null;  // Loc is reachable via Lexer
const LexLoc = (() => { return require('../../compiler.js').lex ? null : null; })();
// Pull Loc from the Lexer module.
const Lexer = (() => {
  // The Lexer.Loc class isn't directly exposed; build via fromTok-equivalent.
  return null;
})();

// Build a synthetic Loc for tests. We don't have direct access to the
// Loc class, so use Lexer.Loc.fromTok with a fake token shape — that's
// what the parser does for synthesized nodes.
function L(filename = 'test', line = 1, col = 1) {
  return { filename, line, column: col, start: { line, column: col }, end: { line, column: col }, get line() { return line; } };
}
// Actually use the real Loc — create one through a parse so it's well-formed.
function realLoc() {
  const r = C.parseSource('test.c', 'int x;');
  return r.translationUnit.definedVariables[0].loc;
}
const LOC = realLoc();

// --- tiny test framework ---
let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try {
    // Each test runs inside its own diag sink so reportError calls work.
    const sink = { errors: [], warnings: [] };
    withDiag(sink, fn);
    pass++;
  } catch (e) {
    fail++;
    failures.push({ name, message: e.message, stack: e.stack });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'assertEq'}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
function assertThrows(fn, msgRegex) {
  let threw = false;
  let caught = null;
  try { fn(); } catch (e) { threw = true; caught = e; }
  if (!threw) throw new Error(`expected throw${msgRegex ? ' matching ' + msgRegex : ''}, got none`);
  if (msgRegex && !msgRegex.test(caught.message)) {
    throw new Error(`thrown message ${JSON.stringify(caught.message)} did not match ${msgRegex}`);
  }
}

// --- helpers for building nodes ---
function int(v) { return new AST.EInt(LOC, Types.TINT, BigInt(v)); }
function dvar(name, type = Types.TINT) {
  return new AST.DVar(LOC, name, type, Types.StorageClass.NONE, null);
}
function dfunc(name, retType = Types.TINT, params = []) {
  const ftype = (() => {
    // functionType is on Types — but it's not directly exposed. Use a
    // parsed function to grab one of the right shape and return a custom
    // FunctionType via Types.TypeInfo — for tests we cheat by parsing.
    const src = `${retType === Types.TVOID ? 'void' : 'int'} ${name}(${params.map((_,i)=>'int p' + i).join(',')||'void'}) { }`;
    const r = C.parseSource('test.c', src);
    return r.translationUnit.definedFunctions.find(f => f.name === name).type;
  })();
  return new AST.DFunc(LOC, name, ftype, params, Types.StorageClass.NONE, false, null);
}

// =============================================================================
// Constructor validation
// =============================================================================

test('EInt rejects non-integer type', () => {
  assertThrows(() => new AST.EInt(LOC, Types.TFLOAT, 0n), /must be integral/);
});
test('EInt rejects non-BigInt value', () => {
  assertThrows(() => new AST.EInt(LOC, Types.TINT, 5), /must be a BigInt/);
});
test('EFloat rejects non-float type', () => {
  assertThrows(() => new AST.EFloat(LOC, Types.TINT, 0.0), /must be floating-point/);
});
test('EFloat rejects non-number value', () => {
  assertThrows(() => new AST.EFloat(LOC, Types.TFLOAT, 'oops'), /must be a number/);
});
test('EString rejects non-array type', () => {
  assertThrows(() => new AST.EString(LOC, Types.TINT, []), /must be an array/);
});
test('EIdent requires non-null decl', () => {
  assertThrows(() => new AST.EIdent(LOC, Types.TINT, null), /decl is required/);
});
test('EMember requires non-null memberDecl', () => {
  assertThrows(() => new AST.EMember(LOC, Types.TINT, int(0), null), /memberDecl is required/);
});
test('EArrow requires non-null memberDecl', () => {
  assertThrows(() => new AST.EArrow(LOC, Types.TINT, int(0), null), /memberDecl is required/);
});
test('Expr rejects null loc', () => {
  assertThrows(() => new AST.EInt(null, Types.TINT, 0n), /loc is required/);
});
test('Stmt rejects null loc', () => {
  assertThrows(() => new AST.SBreak(null), /loc is required/);
});

// =============================================================================
// Object.freeze enforcement (strict mode)
// =============================================================================

test('EInt is frozen', () => {
  const n = int(5);
  assert(Object.isFrozen(n), 'EInt should be frozen');
  assertThrows(() => { n.value = 99n; }, /read only|Cannot assign/);
});
test('EBinary is frozen', () => {
  const n = new AST.EBinary(LOC, Types.TINT, 'ADD', int(1), int(2));
  assert(Object.isFrozen(n), 'EBinary should be frozen');
  assertThrows(() => { n.left = int(99); }, /read only|Cannot assign/);
});
test('EUnary is frozen', () => {
  const n = new AST.EUnary(LOC, Types.TINT, 'OP_NEG', int(1));
  assert(Object.isFrozen(n), 'EUnary should be frozen');
});
test('SReturn is frozen', () => {
  const n = new AST.SReturn(LOC, int(0));
  assert(Object.isFrozen(n), 'SReturn should be frozen');
});
test('SCompound is frozen', () => {
  const n = new AST.SCompound(LOC, []);
  assert(Object.isFrozen(n), 'SCompound should be frozen');
});
test('EInitList is seal-only (not frozen) — designator path', () => {
  const n = new AST.EInitList(LOC, Types.TINT, [], [], -1);
  assert(!Object.isFrozen(n), 'EInitList should be seal-only');
});
test('SLabel is seal-only (target backfilled)', () => {
  const n = new AST.SLabel(LOC, 'foo', null);
  assert(!Object.isFrozen(n), 'SLabel should be seal-only');
});
test('SGoto is seal-only (target backfilled)', () => {
  const n = new AST.SGoto(LOC, 'foo');
  assert(!Object.isFrozen(n), 'SGoto should be seal-only');
});

// =============================================================================
// Linearity tagging
// =============================================================================

test('EInt is UNRESTRICTED', () => {
  assertEq(int(5).linearity, AST.Linearity.UNRESTRICTED, 'EInt.linearity');
});
test('EFloat is UNRESTRICTED', () => {
  const n = new AST.EFloat(LOC, Types.TFLOAT, 3.14);
  assertEq(n.linearity, AST.Linearity.UNRESTRICTED);
});
test('EString is UNRESTRICTED', () => {
  const t = Types.TypeInfo ? null : null; // skip if can't build array type easily
  // Use Types.arrayOf indirectly via parse.
  const r = C.parseSource('test.c', 'char *p = "hi";');
  // Walk to find an EString in the parsed AST.
  const init = r.translationUnit.definedVariables[0].initExpr;
  // Init may be wrapped in EImplicitCast / EDecay; walk down.
  function unwrap(e) {
    while (e && (e instanceof AST.EImplicitCast || e instanceof AST.EDecay)) e = e.expr || e.operand;
    return e;
  }
  const s = unwrap(init);
  assert(s instanceof AST.EString, 'expected to find EString');
  assertEq(s.linearity, AST.Linearity.UNRESTRICTED);
});
test('EIdent of DVar is UNRESTRICTED', () => {
  const v = dvar('x');
  const id = new AST.EIdent(LOC, Types.TINT, v);
  assertEq(id.linearity, AST.Linearity.UNRESTRICTED);
});
test('EBinary ASSIGN is LINEAR', () => {
  const v = dvar('x');
  const id = new AST.EIdent(LOC, Types.TINT, v);
  const n = new AST.EBinary(LOC, Types.TINT, 'ASSIGN', id, int(5));
  assertEq(n.linearity, AST.Linearity.LINEAR, 'ASSIGN should be LINEAR');
});
test('EBinary ADD with UNRESTRICTED operands is UNRESTRICTED', () => {
  const n = new AST.EBinary(LOC, Types.TINT, 'ADD', int(1), int(2));
  assertEq(n.linearity, AST.Linearity.UNRESTRICTED);
});
test('EUnary OP_PRE_INC is LINEAR (side effect)', () => {
  const v = dvar('x');
  const id = new AST.EIdent(LOC, Types.TINT, v);
  const n = new AST.EUnary(LOC, Types.TINT, 'OP_PRE_INC', id);
  assertEq(n.linearity, AST.Linearity.LINEAR);
});
test('EUnary OP_ADDR is AFFINE (identity)', () => {
  const v = dvar('x');
  const id = new AST.EIdent(LOC, Types.TINT, v);
  const n = new AST.EUnary(LOC, Types.TINT.pointer(), 'OP_ADDR', id);
  assertEq(n.linearity, AST.Linearity.AFFINE);
});
test('EUnary OP_NEG bubbles UNRESTRICTED from child', () => {
  const n = new AST.EUnary(LOC, Types.TINT, 'OP_NEG', int(5));
  assertEq(n.linearity, AST.Linearity.UNRESTRICTED);
});
test('EBinary with one LINEAR child is LINEAR (bubble-up)', () => {
  const v = dvar('x');
  const id = new AST.EIdent(LOC, Types.TINT, v);
  const inc = new AST.EUnary(LOC, Types.TINT, 'OP_PRE_INC', id);  // LINEAR
  const n = new AST.EBinary(LOC, Types.TINT, 'ADD', inc, int(1));
  assertEq(n.linearity, AST.Linearity.LINEAR);
});

// =============================================================================
// children array + _withChildren
// =============================================================================

test('EBinary.children is [left, right]', () => {
  const a = int(1), b = int(2);
  const n = new AST.EBinary(LOC, Types.TINT, 'ADD', a, b);
  assertEq(n.children.length, 2);
  assertEq(n.children[0], a);
  assertEq(n.children[1], b);
  // Named field aliases.
  assertEq(n.left, a);
  assertEq(n.right, b);
});
test('EBinary._withChildren rebuilds with replacements', () => {
  const a = int(1), b = int(2), c = int(99);
  const n = new AST.EBinary(LOC, Types.TINT, 'ADD', a, b);
  const m = n._withChildren([c, b]);
  assert(m !== n, 'should be a new instance');
  assertEq(m.left, c);
  assertEq(m.right, b);
  assertEq(m.op, 'ADD');
});
test('Leaf _withChildren returns self for empty children', () => {
  const n = int(5);
  const m = n._withChildren([]);
  assertEq(m, n, 'leaf should return self');
});

// =============================================================================
// walkExpr + substituteParams
// =============================================================================

test('walkExpr visits in pre-order', () => {
  const tree = new AST.EBinary(LOC, Types.TINT, 'ADD',
    new AST.EBinary(LOC, Types.TINT, 'MUL', int(1), int(2)), int(3));
  const visited = [];
  AST.walkExpr(tree, n => {
    if (n instanceof AST.EBinary) visited.push(n.op);
    return undefined;  // continue
  });
  // ADD visited before MUL (pre-order).
  assertEq(visited[0], 'ADD');
  assertEq(visited[1], 'MUL');
});
test('walkExpr returns same instance when nothing changed', () => {
  const tree = new AST.EBinary(LOC, Types.TINT, 'ADD', int(1), int(2));
  const out = AST.walkExpr(tree, () => undefined);
  assertEq(out, tree, 'identity-preserving');
});
test('walkExpr replaces subtree when visitor returns a node', () => {
  const tree = new AST.EBinary(LOC, Types.TINT, 'ADD', int(1), int(2));
  const out = AST.walkExpr(tree, n => {
    if (n instanceof AST.EInt && n.value === 1n) return int(99);
    return undefined;
  });
  assert(out !== tree, 'should rebuild');
  assertEq(Number(out.left.value), 99);
  assertEq(Number(out.right.value), 2);
});
test('substituteParams replaces EIdent of mapped DVar', () => {
  const param = dvar('n');
  const arg = int(7);
  const body = new AST.EBinary(LOC, Types.TINT, 'MUL',
    new AST.EIdent(LOC, Types.TINT, param),
    new AST.EIdent(LOC, Types.TINT, param));
  const map = new Map([[param, arg]]);
  const out = AST.substituteParams(body, map);
  assert(out !== body, 'should rebuild');
  assertEq(out.left, arg);
  assertEq(out.right, arg);
});
test('substituteParams leaves unmapped EIdents alone', () => {
  const param = dvar('n');
  const other = dvar('m');
  const body = new AST.EBinary(LOC, Types.TINT, 'ADD',
    new AST.EIdent(LOC, Types.TINT, param),
    new AST.EIdent(LOC, Types.TINT, other));
  const map = new Map([[param, int(5)]]);
  const out = AST.substituteParams(body, map);
  assertEq(Number(out.left.value), 5);
  assert(out.right instanceof AST.EIdent);
  assertEq(out.right.decl, other);
});

// =============================================================================
// TreeBag
// =============================================================================

test('TreeBag empty has size 0', () => {
  const b = new AST.TreeBag(null);
  assertEq(b.size, 0);
  assertEq([...b].length, 0);
});
test('TreeBag with own array', () => {
  const a = {}, b = {}, c = {};
  const bag = new AST.TreeBag([a, b, c]);
  assertEq(bag.size, 3);
  assert(bag.has(a));
  assert(bag.has(b));
  assert(!bag.has({}));
});
test('TreeBag union from children (no copy)', () => {
  const a = {}, b = {};
  const left = new AST.TreeBag([a]);
  const right = new AST.TreeBag([b]);
  const parent = new AST.TreeBag(null, left, right);
  assertEq(parent.size, 2);
  assert(parent.has(a));
  assert(parent.has(b));
});
test('TreeBag iteration walks tree on demand', () => {
  const a = {}, b = {}, c = {};
  const inner = new AST.TreeBag([a, b]);
  const outer = new AST.TreeBag([c], inner);
  const seen = [...outer];
  // Order: own first, then children.
  assertEq(seen.length, 3);
  assertEq(seen[0], c);  // own
});
test('TreeBag is array-based (preserves duplicate items)', () => {
  const a = {};
  const bag = new AST.TreeBag([a, a, a]);
  assertEq(bag.size, 3, 'array bag does not dedup like a Set');
});

// =============================================================================
// referencedFunctions bubble-up
// =============================================================================

test('EIdent of DFunc adds itself to referencedFunctions', () => {
  const f = dfunc('foo');
  const id = new AST.EIdent(LOC, f.type, f);
  assert(id.referencedFunctions.has(f));
});
test('EIdent of DVar does not contribute', () => {
  const v = dvar('x');
  const id = new AST.EIdent(LOC, Types.TINT, v);
  assertEq(id.referencedFunctions.size, 0);
});
test('EBinary bubbles referencedFunctions from children', () => {
  const f = dfunc('foo');
  const idF = new AST.EIdent(LOC, f.type, f);
  const n = new AST.EBinary(LOC, Types.TINT, 'ADD', idF, int(1));
  assert(n.referencedFunctions.has(f));
});
test('SCompound bubbles referencedFunctions from statements (parser-mutated children)', () => {
  // This is the case that bit me: SCompound is constructed with empty
  // statements and then the parser pushes into it. Verify the bag still
  // sees the pushed contents (because referencedFunctions is a getter).
  const comp = new AST.SCompound(LOC, []);
  const f = dfunc('foo');
  const idF = new AST.EIdent(LOC, f.type, f);
  const ret = new AST.SReturn(LOC, idF);
  comp.statements.push(ret);
  comp.children.push(ret);  // children aliases statements via super(loc, statements)
  // Wait — they're the same array reference, so just one push needed.
  // Verify the bag picks up the push:
  assert(comp.referencedFunctions.has(f),
    'SCompound bag must reflect children pushed after construction');
});

// End-to-end: parse a real program and verify bag bubble-up.
test('referencedFunctions bubbles up through real parsed function body', () => {
  const r = C.parseSource('test.c',
    'int helper(int *p) { return *p + 1; } int main(int *q) { return helper(q); }');
  const fns = r.translationUnit.definedFunctions.concat(r.translationUnit.staticFunctions);
  const main = fns.find(f => f.name === 'main');
  const helper = fns.find(f => f.name === 'helper');
  assertEq(main.body.referencedFunctions.size, 1);
  assert(main.body.referencedFunctions.has(helper));
});

// =============================================================================
// TDIVERGENT
// =============================================================================

test('TDIVERGENT is divergent', () => {
  assert(Types.TDIVERGENT.isDivergent());
});
test('usualArithmeticConversions: divergent absorbs', () => {
  const r = Types.usualArithmeticConversions(Types.TDIVERGENT, Types.TINT);
  assertEq(r, Types.TDIVERGENT);
});
test('usualArithmeticConversions: int+int unaffected', () => {
  const r = Types.usualArithmeticConversions(Types.TINT, Types.TINT);
  assertEq(r, Types.TINT);
});

// =============================================================================
// make-helper recovery (placeholder DVars on missing names)
// =============================================================================

test('makeIdent on missing name reports error and returns EIdent with placeholder DVar', () => {
  const sink = { errors: [], warnings: [] };
  let result;
  withDiag(sink, () => {
    const scope = { get: () => null };
    result = AST.makeIdent(LOC, 'unknown', scope);
  });
  assertEq(sink.errors.length, 1);
  assert(/Undeclared identifier/.test(sink.errors[0].message));
  assert(result instanceof AST.EIdent);
  assert(result.decl, 'placeholder DVar should be set');
  assertEq(result.decl.type, Types.TDIVERGENT, 'placeholder should be divergent-typed');
});
test('makeMember on missing field reports + placeholder', () => {
  const r = C.parseSource('test.c', 'struct Foo { int a; }; struct Foo f;');
  const f = r.translationUnit.definedVariables[0];
  const idF = new AST.EIdent(LOC, f.type, f);
  const sink = { errors: [], warnings: [] };
  let result;
  withDiag(sink, () => { result = AST.makeMember(LOC, idF, 'nonexistent'); });
  assertEq(sink.errors.length, 1);
  assert(/has no member named 'nonexistent'/.test(sink.errors[0].message));
  assert(result instanceof AST.EMember);
  assert(result.memberDecl, 'placeholder memberDecl set');
  assertEq(result.memberDecl.type, Types.TDIVERGENT);
});

// =============================================================================
// diag pool
// =============================================================================

// This test deliberately runs OUTSIDE the test framework's wrapping
// withDiag — call it directly here so reportError sees a null sink.
(() => {
  let threw = false;
  try { reportError(LOC, 'test'); } catch (e) { threw = /outside withDiag/.test(e.message); }
  if (!threw) {
    fail++;
    failures.push({ name: 'reportError outside withDiag throws', message: 'expected throw with "outside withDiag", got none' });
  } else {
    pass++;
  }
})();
test('reportError inside withDiag accumulates', () => {
  const sink = { errors: [], warnings: [] };
  withDiag(sink, () => {
    reportError(LOC, 'first');
    reportError(LOC, 'second');
  });
  assertEq(sink.errors.length, 2);
  assertEq(sink.errors[0].message, 'first');
  assertEq(sink.errors[1].message, 'second');
});
test('fatalError throws FatalDiag', () => {
  const sink = { errors: [], warnings: [] };
  let caught = null;
  try {
    withDiag(sink, () => { fatalError(LOC, 'fatal'); });
  } catch (e) { caught = e; }
  assert(caught instanceof FatalDiag, 'should throw FatalDiag');
  assertEq(sink.errors.length, 1);
  assertEq(sink.errors[0].message, 'fatal');
});

// =============================================================================
// INLINER: constant folding + inlining
// =============================================================================

function compileAndOptimize(src) {
  // parseSource doesn't run INLINER — call it directly after parse.
  const r = C.parseSource('test.c', src);
  if (r.errors.length > 0) throw new Error('parse errors: ' + r.errors.map(e => e.message).join('; '));
  INLINER.optimize(r.translationUnit);
  return r.translationUnit;
}

test('INLINER folds 1 + 2 to EInt(3)', () => {
  const u = compileAndOptimize('int f() { return 1 + 2; }');
  const f = u.definedFunctions[0];
  const ret = f.body.statements[0];
  assert(ret.expr instanceof AST.EInt, 'return expr should be EInt after fold');
  assertEq(Number(ret.expr.value), 3);
});
test('INLINER folds 2 * 3 + 4 to EInt(10)', () => {
  const u = compileAndOptimize('int f() { return 2 * 3 + 4; }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.EInt);
  assertEq(Number(ret.expr.value), 10);
});
test('INLINER folds constant comparisons', () => {
  const u = compileAndOptimize('int f() { return 1 < 2; }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.EInt);
  assertEq(Number(ret.expr.value), 1);
});
test('INLINER folds short-circuit `0 && x` to 0', () => {
  // Even if x is non-constant, 0 && x folds (drops x per C semantics).
  const u = compileAndOptimize('int f(int x) { return 0 && x; }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.EInt);
  assertEq(Number(ret.expr.value), 0);
});
test('INLINER eliminates dead if-branch under constant condition', () => {
  const u = compileAndOptimize(
    'int f() { if (1 == 1) return 7; return 99; }');
  const stmts = u.definedFunctions[0].body.statements;
  // The if collapses to its then-branch (return 7); the trailing return
  // 99 stays (unreachable but not removed).
  assert(stmts[0] instanceof AST.SReturn, 'if collapses to its then-branch');
  assertEq(Number(stmts[0].expr.value), 7);
});
test('INLINER inlines a single-return function with UNRESTRICTED args', () => {
  const u = compileAndOptimize(
    'static int square(int n) { return n * n; } int main() { return square(5); }');
  const main = u.definedFunctions[0];
  const ret = main.body.statements[0];
  // square(5) → 5 * 5 → 25 (cascaded)
  assert(ret.expr instanceof AST.EInt);
  assertEq(Number(ret.expr.value), 25);
});
test('INLINER cascades inlining: add(square(3), 4) → 13', () => {
  const u = compileAndOptimize(
    'static int square(int n) { return n * n; } ' +
    'static int add(int a, int b) { return a + b; } ' +
    'int main() { return add(square(3), 4); }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.EInt);
  assertEq(Number(ret.expr.value), 13);
});
test('INLINER does NOT inline recursive function (recursion stack bails)', () => {
  // factorial(0) is not foldable because the body has an if (which is LINEAR
  // by op type, not just by children). Even if it were, recursion bails.
  // Use a simpler self-referential that wouldn't infinite-loop:
  const u = compileAndOptimize(
    'static int fact(int n) { return n ? fact(n - 1) : 1; }\n' +
    'int main() { return fact(3); }');
  const ret = u.definedFunctions[0].body.statements[0];
  // Should NOT be a constant — recursion bails inlining.
  assert(ret.expr instanceof AST.ECall || ret.expr instanceof AST.ETernary,
    'recursive call should not fully inline');
});
test('INLINER does NOT inline when body has side effects', () => {
  const u = compileAndOptimize(
    'static int g; static int sideeffect(int n) { return ++g; }\n' +
    'int main() { return sideeffect(5); }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.ECall, 'side-effecting body should not inline');
});

// =============================================================================
// DExceptionTag class
// =============================================================================

test('DExceptionTag is a real Decl class', () => {
  const t = new AST.DExceptionTag(LOC, 'Foo', [Types.TINT]);
  assert(t instanceof AST.Decl, 'should extend Decl');
  assertEq(t.name, 'Foo');
  assertEq(t.paramTypes.length, 1);
  assertEq(t.paramTypes[0], Types.TINT);
});

// =============================================================================
// runner output
// =============================================================================

console.log(`AST unit tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) {
    console.log(`\n  FAIL ${f.name}`);
    console.log(`    ${f.message}`);
  }
  process.exit(1);
}
