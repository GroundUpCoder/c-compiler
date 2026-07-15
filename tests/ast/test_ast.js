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
test('ECompoundLiteral is frozen', () => {
  const initList = new AST.EInitList(LOC, Types.TINT, [int(1)], [], -1);
  const n = new AST.ECompoundLiteral(LOC, Types.TINT, initList);
  assert(Object.isFrozen(n), 'ECompoundLiteral should be frozen now (bag-driven layout)');
  assertThrows(() => { n.initList = null; }, /read only|Cannot assign/);
});
test('ECompoundLiteral.referencedCompoundLiterals contains itself', () => {
  const initList = new AST.EInitList(LOC, Types.TINT, [int(1)], [], -1);
  const cl = new AST.ECompoundLiteral(LOC, Types.TINT, initList);
  const found = [...cl.referencedCompoundLiterals];
  assertEq(found.length, 1, 'self-bag has one entry');
  assertEq(found[0], cl, 'and that entry is itself');
});
test('referencedCompoundLiterals bubbles up through containing exprs', () => {
  const innerInit = new AST.EInitList(LOC, Types.TINT, [int(1)], [], -1);
  const cl = new AST.ECompoundLiteral(LOC, Types.TINT, innerInit);
  const outerInit = new AST.EInitList(LOC, Types.TINT, [cl], [], -1);
  const outer = new AST.ECompoundLiteral(LOC, Types.TINT, outerInit);
  const found = new Set(outer.referencedCompoundLiterals);
  assertEq(found.size, 2, 'outer bag includes both compound literals');
  assert(found.has(cl), 'inner CL is reachable');
  assert(found.has(outer), 'outer CL self-reference');
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
  const parent = new AST.TreeBag(null, [left, right]);
  assertEq(parent.size, 2);
  assert(parent.has(a));
  assert(parent.has(b));
});
test('TreeBag iteration walks tree on demand', () => {
  const a = {}, b = {}, c = {};
  const inner = new AST.TreeBag([a, b]);
  const outer = new AST.TreeBag([c], [inner]);
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

// --- Bail-out cases: each documents a tryInline guard ---

test('INLINER bails when an argument is LINEAR (side-effecting)', () => {
  // Inlining substitutes each parameter with the corresponding arg expr.
  // If an arg has side effects (here: ++counter), substituting it could
  // duplicate or eliminate the side effect. Bail.
  const u = compileAndOptimize(
    'static int counter;\n' +
    'static int twice(int n) { return n + n; }\n' +
    'int main(void) { return twice(++counter); }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.ECall,
    'call with LINEAR arg should not inline');
});
test('INLINER bails when the body has multiple statements', () => {
  // singleReturnBody only matches `return EXPR;` or `{ return EXPR; }`.
  // Anything else (a real local, a side effect, a branch) bails.
  const u = compileAndOptimize(
    'static int two_stmt(int x) { int t = x + 1; return t * 2; }\n' +
    'int main(void) { return two_stmt(5); }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.ECall,
    'multi-statement body should not inline');
});
test('INLINER bails on indirect (function-pointer) calls', () => {
  // Indirect call: callee is `fp` (a variable), not a known function.
  // ECall.funcDecl is null, so tryInline has nothing to inline against.
  const u = compileAndOptimize(
    'static int square(int n) { return n * n; }\n' +
    'int main(void) {\n' +
    '  int (*fp)(int) = square;\n' +
    '  return fp(7);\n' +
    '}');
  const stmts = u.definedFunctions[0].body.statements;
  // Last stmt is `return fp(7);` — should still be a call.
  const ret = stmts[stmts.length - 1];
  assert(ret.expr instanceof AST.ECall,
    'indirect call should not inline');
});
test('INLINER bails when an argument is AFFINE (address-take)', () => {
  // &x has identity (the address is observable), so it's AFFINE, not
  // UNRESTRICTED. The inliner refuses to substitute it as a param.
  const u = compileAndOptimize(
    'static int g;\n' +
    'static int deref(int *p) { return *p; }\n' +
    'int main(void) { return deref(&g); }');
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.ECall,
    'call with AFFINE arg should not inline');
});
test('INLINER diamond worklist: A→D, B→D, main→A and main→B (no inlining)', () => {
  // Diamond reachability test for the optimize() worklist. None of these
  // are inlineable (D is multi-statement; A and B contain calls, which
  // are LINEAR, making their return expr LINEAR too). The walk should
  // visit each function exactly once and keep all four — exercising the
  // liveFuncs dedup so D isn't enqueued twice and isn't dropped.
  const u = compileAndOptimize(
    'static int d(int x) { int t = x + 1; return t * 7; }\n' +
    'static int a(int n) { return d(n) + 1; }\n' +
    'static int b(int n) { return d(n) + 2; }\n' +
    'int main(int argc, char **argv) { return a(argc) + b(argc + 1); }');
  const names = u.staticFunctions.map(f => f.name);
  for (const want of ['a', 'b', 'd']) {
    assert(names.includes(want),
      `${want} should be kept by diamond walk; got: ${names.join(",")}`);
  }
});

// =============================================================================
// Whole-program (post-link) inlining + expansion budget (todos/0188)
// =============================================================================
// linkTranslationUnits runs INLINER.optimizeLinked after wiring
// decl.definition across TUs, so cross-TU single-return callees inline
// under the same rule the per-TU pass uses. Order is callee-before-caller
// (post-order over the call graph) so bodies that only become
// single-return after their own calls inline are folded before their
// callers are visited.

// Parse each source as its own TU (running the per-TU pass, as
// parseAllUnits does), then link — which runs the post-link round.
function compileLinkOptimize(sources) {
  const units = sources.map(([name, src]) => {
    const r = C.parseSource(name, src);
    if (r.errors.length > 0) throw new Error('parse errors: ' + r.errors.map(e => e.message).join('; '));
    INLINER.optimize(r.translationUnit);
    return r.translationUnit;
  });
  const link = C.linkTranslationUnits(units, {});
  if (link.errors.length > 0) throw new Error('link errors: ' + link.errors.map(e => e.message).join('; '));
  return units;
}

test('INLINER post-link round inlines a cross-TU single-return callee', () => {
  const units = compileLinkOptimize([
    ['a.c', 'extern int sq(int n); int main(void) { return sq(5); }'],
    ['b.c', 'int sq(int n) { return n * n; }'],
  ]);
  const main = units[0].definedFunctions.find(f => f.name === 'main');
  const ret = main.body.statements[0];
  // Per-TU, sq's body was invisible (no definition wired); post-link it
  // inlines and folds: sq(5) → 5 * 5 → 25.
  assert(ret.expr instanceof AST.EInt, 'cross-TU call should inline post-link');
  assertEq(Number(ret.expr.value), 25);
});
test('INLINER post-link round folds callees before callers (call-graph post-order)', () => {
  // pick's body only becomes a single UNRESTRICTED return after its own
  // cross-TU call to one() inlines and the ternary folds. main can then
  // inline pick — but only if pick was folded first.
  const units = compileLinkOptimize([
    ['a.c', 'extern int pick(int x); int main(void) { return pick(5); }'],
    ['b.c', 'extern int one(void); int pick(int x) { return one() ? x * 2 : x * 3; }'],
    ['c.c', 'int one(void) { return 1; }'],
  ]);
  const main = units[0].definedFunctions.find(f => f.name === 'main');
  const ret = main.body.statements[0];
  assert(ret.expr instanceof AST.EInt, 'caller should see the already-folded callee body');
  assertEq(Number(ret.expr.value), 10);
});
test('INLINER expansion budget refuses duplication of a large argument', () => {
  // twice() uses its parameter twice; the argument is a large pure
  // expression, so substitution would grow the site past
  // INLINE_GROWTH_CAP effective nodes. The call must stay a call, and
  // the refusal must be charged to the budget counter.
  const arg = Array(40).fill('a').join(' + ');  // 40 idents + 39 adds
  const before = INLINER.stats.budgetRefused;
  const u = compileAndOptimize(
    'static int twice(int n) { return n + n; }\n' +
    `int f(int a) { return twice(${arg}); }`);
  const ret = u.definedFunctions[0].body.statements[0];
  assert(ret.expr instanceof AST.ECall, 'budget-refused call should stay a call');
  assert(INLINER.stats.budgetRefused > before, 'refusal should be counted');
});
test('INLINER expansion budget allows single-use params regardless of argument size', () => {
  // once() uses its parameter once — no duplication, so growth is just
  // the body overhead and even a large (non-constant) argument inlines.
  const arg = Array(40).fill('a').join(' + ');  // same 79-node arg as above
  const u = compileAndOptimize(
    'static int once(int n) { return n + 1; }\n' +
    `int f(int a) { return once(${arg}); }`);
  const ret = u.definedFunctions[0].body.statements[0];
  assert(!(ret.expr instanceof AST.ECall), 'single-use param should inline past the budget');
  assert(ret.expr instanceof AST.EBinary, 'inlined body is the substituted n + 1');
});

// =============================================================================
// Volatile access linearity (todos/0187)
// =============================================================================
// C11 5.1.2.3: accesses to volatile objects are observable behavior — the
// count and order of volatile reads must survive optimization. A memory
// access whose accessed object is volatile-qualified is LINEAR, never
// UNRESTRICTED; tryInline's UNRESTRICTED guards then keep the call a real
// call (exactly one read, in order). Non-volatile accesses MUST stay
// UNRESTRICTED — these tests pin both directions.

// Parse and return the expression of the first `return EXPR;` in function
// `fname` (unwrapping nothing — callers assert on the node as built).
function returnExprOf(src, fname) {
  const r = C.parseSource('test.c', src);
  if (r.errors.length > 0) throw new Error('parse errors: ' + r.errors.map(e => e.message).join('; '));
  const f = r.translationUnit.definedFunctions.find(fn => fn.name === fname);
  const ret = f.body.statements.find(s => s instanceof AST.SReturn);
  return ret.expr;
}
// Count reads of variable `name` (EIdent references) under `node`.
function countIdentReads(node, name) {
  let n = 0;
  (function walk(e) {
    if (!e || typeof e !== 'object') return;
    if (e instanceof AST.EIdent && e.name === name) n++;
    for (const c of (e.children || [])) walk(c);
  })(node);
  return n;
}

test('volatile global read is LINEAR; non-volatile stays UNRESTRICTED', () => {
  assertEq(returnExprOf('volatile int g; int f(void) { return g; }', 'f').linearity,
    AST.Linearity.LINEAR, 'volatile global read');
  assertEq(returnExprOf('int g; int f(void) { return g; }', 'f').linearity,
    AST.Linearity.UNRESTRICTED, 'plain global read');
});
test('deref of pointer-to-volatile is LINEAR; plain deref stays UNRESTRICTED', () => {
  assertEq(returnExprOf('int f(volatile int *p) { return *p; }', 'f').linearity,
    AST.Linearity.LINEAR, '*p, p: volatile int *');
  assertEq(returnExprOf('int f(int *p) { return *p; }', 'f').linearity,
    AST.Linearity.UNRESTRICTED, '*p, p: int *');
});
test('MMIO idiom *(volatile int *)ADDR is LINEAR', () => {
  assertEq(returnExprOf('int f(void) { return *(volatile int *)0x1000; }', 'f').linearity,
    AST.Linearity.LINEAR);
});
test('volatile array element is LINEAR (direct and typedef-qualified)', () => {
  assertEq(returnExprOf('volatile int a[4]; int f(void) { return a[1]; }', 'f').linearity,
    AST.Linearity.LINEAR, 'volatile int a[4]');
  // C11 6.7.3p9: qualifying an array type qualifies the ELEMENT type —
  // reachable only through a typedef, where the qualifier lands on the
  // array TypeInfo itself and makeSubscript must push it down.
  assertEq(returnExprOf('typedef int A[4]; volatile A a; int f(void) { return a[1]; }', 'f').linearity,
    AST.Linearity.LINEAR, 'volatile A a (typedef int A[4])');
  assertEq(returnExprOf('int a[4]; int f(void) { return a[1]; }', 'f').linearity,
    AST.Linearity.UNRESTRICTED, 'plain array element');
});
test('volatile member is LINEAR: s.f, volatile struct, p->f through pointee', () => {
  assertEq(returnExprOf(
    'struct S { volatile int f; int g; }; struct S s; int f(void) { return s.f; }', 'f').linearity,
    AST.Linearity.LINEAR, 's.f with volatile member');
  assertEq(returnExprOf(
    'struct S { volatile int f; int g; }; struct S s; int f(void) { return s.g; }', 'f').linearity,
    AST.Linearity.UNRESTRICTED, 's.g non-volatile member of same struct');
  assertEq(returnExprOf(
    'struct S { int f; }; volatile struct S s; int f(void) { return s.f; }', 'f').linearity,
    AST.Linearity.LINEAR, 's.f with volatile-qualified s');
  assertEq(returnExprOf(
    'struct S { int f; }; int f(volatile struct S *p) { return p->f; }', 'f').linearity,
    AST.Linearity.LINEAR, 'p->f with p: volatile struct S *');
  assertEq(returnExprOf(
    'struct S { int f; }; int f(struct S *p) { return p->f; }', 'f').linearity,
    AST.Linearity.UNRESTRICTED, 'p->f plain');
});
test('INLINER does not duplicate a volatile read: twice(mmio) stays a call', () => {
  // Pre-0187 this inlined to `mmio + mmio` — TWO volatile reads where
  // C requires the argument be read exactly once.
  const u = compileAndOptimize(
    'static volatile int mmio;\n' +
    'static int twice(int x) { return x + x; }\n' +
    'int main(void) { return twice(mmio); }');
  const ret = u.definedFunctions.find(f => f.name === 'main').body.statements[0];
  assert(ret.expr instanceof AST.ECall, 'twice(mmio) must remain a call');
  assertEq(countIdentReads(ret.expr, 'mmio'), 1, 'exactly one mmio read');
});
test('INLINER does not drop a volatile read: ignore-shape stays a call', () => {
  // Pre-0187 this folded to EInt(0) — ZERO volatile reads where C
  // requires the argument be evaluated (exactly one read).
  const u = compileAndOptimize(
    'static volatile int mmio;\n' +
    'static int ignore(int x) { return 0; }\n' +
    'int main(void) { return ignore(mmio); }');
  const ret = u.definedFunctions.find(f => f.name === 'main').body.statements[0];
  assert(ret.expr instanceof AST.ECall, 'ignore(mmio) must remain a call');
  assertEq(countIdentReads(ret.expr, 'mmio'), 1, 'exactly one mmio read');
});
test('INLINER does not inline through a volatile deref argument', () => {
  const u = compileAndOptimize(
    'static int twice(int x) { return x + x; }\n' +
    'int f(volatile int *vp) { return twice(*vp); }');
  const ret = u.definedFunctions.find(f => f.name === 'f').body.statements[0];
  assert(ret.expr instanceof AST.ECall, 'twice(*vp) must remain a call');
});
test('INLINER refuses a body that READS a volatile (would drop/reorder it)', () => {
  // The body-side guard: returnExpr containing a volatile read is LINEAR,
  // so `getmmio()` never inlines (substitution could drop or reorder the
  // read relative to other volatile accesses at the call site).
  const u = compileAndOptimize(
    'static volatile int mmio;\n' +
    'static int getmmio(void) { return mmio; }\n' +
    'int main(void) { return getmmio(); }');
  const ret = u.definedFunctions.find(f => f.name === 'main').body.statements[0];
  assert(ret.expr instanceof AST.ECall, 'getmmio() must remain a call');
});
test('INLINER still inlines non-volatile memory args (no blanket downgrade)', () => {
  // The fix keys strictly on the volatile qualifier: a plain global read
  // and a plain deref stay UNRESTRICTED and keep inlining.
  let u = compileAndOptimize(
    'static int g;\n' +
    'static int twice(int x) { return x + x; }\n' +
    'int main(void) { return twice(g); }');
  let ret = u.definedFunctions.find(f => f.name === 'main').body.statements[0];
  assert(!(ret.expr instanceof AST.ECall), 'twice(g) must still inline');
  assertEq(countIdentReads(ret.expr, 'g'), 2, 'inlined to g + g');
  u = compileAndOptimize(
    'static int id(int x) { return x; }\n' +
    'int f(int *p) { return id(*p); }');
  ret = u.definedFunctions.find(f => f.name === 'f').body.statements[0];
  assert(!(ret.expr instanceof AST.ECall), 'id(*p) must still inline');
});

// =============================================================================
// Tree-shake: drop unreached static functions
// =============================================================================

test('tree-shake drops static function never referenced', () => {
  const u = compileAndOptimize(
    'static int dead(void) { return 42; }\n' +
    'static int live(void) { return 7; }\n' +
    'int main(void) { return live(); }');
  const names = u.staticFunctions.map(f => f.name);
  assert(!names.includes('dead'), `expected 'dead' dropped, got: ${names.join(",")}`);
});
test('tree-shake keeps static referenced via global function-pointer table', () => {
  // Global static array of function pointers. The bag walk on
  // unit.definedVariables must find the EIdent->DFunc references.
  const u = compileAndOptimize(
    'static int a(void) { return 1; }\n' +
    'static int b(void) { return 2; }\n' +
    'typedef int (*fp)(void);\n' +
    'static fp table[] = { a, b };\n' +
    'int main(void) { return table[0](); }');
  const names = u.staticFunctions.map(f => f.name);
  assert(names.includes('a'), `expected 'a' kept, got: ${names.join(",")}`);
  assert(names.includes('b'), `expected 'b' kept, got: ${names.join(",")}`);
});
test('tree-shake keeps static referenced via static-local function-pointer table', () => {
  // Static local in a function — diverted out of the body, so optimize()
  // must explicitly walk staticLocals' initExprs. Mirrors Lua's
  // createsearcherstable / searchers[] pattern.
  const u = compileAndOptimize(
    'static int a(void) { return 1; }\n' +
    'static int b(void) { return 2; }\n' +
    'typedef int (*fp)(void);\n' +
    'int main(void) {\n' +
    '  static const fp searchers[] = { a, b, 0 };\n' +
    '  return searchers[0]();\n' +
    '}');
  const names = u.staticFunctions.map(f => f.name);
  assert(names.includes('a'), `expected 'a' kept, got: ${names.join(",")}`);
  assert(names.includes('b'), `expected 'b' kept, got: ${names.join(",")}`);
});
test('tree-shake follows forward-declaration to definition', () => {
  // EIdent of the prototype must surface the linked definition so
  // optimized.has(...) matches the entry in unit.staticFunctions.
  const u = compileAndOptimize(
    'static int target(void);\n' +
    'typedef int (*fp)(void);\n' +
    'static fp table[] = { target };\n' +
    'static int target(void) { return 42; }\n' +
    'int main(void) { return table[0](); }');
  const names = u.staticFunctions.map(f => f.name);
  assert(names.includes('target'), `expected 'target' kept, got: ${names.join(",")}`);
});

// =============================================================================
// Tree-shake: referencedVariables bubble-up + dead static-global drops
// =============================================================================

test('tree-shake drops static global never referenced', () => {
  const u = compileAndOptimize(
    'static int dead = 99;\n' +
    'static int live = 7;\n' +
    'int main(void) { return live; }');
  const names = u.definedVariables.map(v => v.name);
  assert(!names.includes('dead'), `expected 'dead' dropped, got: ${names.join(",")}`);
  assert(names.includes('live'), `expected 'live' kept, got: ${names.join(",")}`);
});
test('tree-shake follows static-global chain via address-take', () => {
  const u = compileAndOptimize(
    'static int leaf = 100;\n' +
    'static int *mid = &leaf;\n' +
    'static int **root = &mid;\n' +
    'int main(void) { return **root; }');
  const names = u.definedVariables.map(v => v.name);
  assert(names.includes('leaf'), `expected 'leaf' kept, got: ${names.join(",")}`);
  assert(names.includes('mid'), `expected 'mid' kept, got: ${names.join(",")}`);
  assert(names.includes('root'), `expected 'root' kept, got: ${names.join(",")}`);
});
test('tree-shake drops static global only referenced from dead static', () => {
  // unused_func mentions secret_var; if unused_func is dropped (which
  // it should be — nothing live calls it), secret_var becomes dead too.
  const u = compileAndOptimize(
    'static int secret_var = 42;\n' +
    'static int unused_func(void) { return secret_var; }\n' +
    'int main(void) { return 0; }');
  const fnNames = u.staticFunctions.map(f => f.name);
  const varNames = u.definedVariables.map(v => v.name);
  assert(!fnNames.includes('unused_func'),
    `expected 'unused_func' dropped, got: ${fnNames.join(",")}`);
  assert(!varNames.includes('secret_var'),
    `expected 'secret_var' dropped, got: ${varNames.join(",")}`);
});
test('tree-shake follows forward-decl for variables', () => {
  // Forward declaration of a variable, then reference via address-take
  // before the definition appears. EIdent's referencedVariables must
  // surface the linked definition so identity matches definedVariables.
  const u = compileAndOptimize(
    'extern int target;\n' +
    'static int *ref = &target;\n' +
    'int target = 7;\n' +
    'int main(void) { return *ref; }');
  const names = u.definedVariables.map(v => v.name);
  assert(names.includes('target'), `expected 'target' kept, got: ${names.join(",")}`);
  assert(names.includes('ref'), `expected 'ref' kept, got: ${names.join(",")}`);
});
test('referencedVariables bubbles up from EBinary children', () => {
  const u = compileAndOptimize(
    'static int a = 1, b = 2;\n' +
    'int main(void) { return a + b; }');
  const main = u.definedFunctions[0];
  const refs = [...main.body.referencedVariables].map(v => v.name);
  assert(refs.includes('a'), `expected 'a' in refs, got: ${refs.join(",")}`);
  assert(refs.includes('b'), `expected 'b' in refs, got: ${refs.join(",")}`);
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
// typesAreAssignmentCompatible: C99 6.5.16.1 + extensions
// =============================================================================

const TAC = AST.typesAreAssignmentCompatible;

test('TAC: same type is compatible', () => {
  assert(TAC(Types.TINT, Types.TINT));
});
test('TAC: arithmetic ↔ arithmetic is compatible', () => {
  assert(TAC(Types.TINT, Types.TDOUBLE));
  assert(TAC(Types.TFLOAT, Types.TLONG));
  assert(TAC(Types.TCHAR, Types.TLLONG));
  assert(TAC(Types.TBOOL, Types.TINT));
});
test('TAC: int → pointer is rejected (without null-pointer constant)', () => {
  const intPtr = Types.TINT.pointer();
  // No expr passed — we don't know it's NPC, so reject.
  assert(!TAC(Types.TINT, intPtr));
});
test('TAC: pointer → int is rejected', () => {
  const intPtr = Types.TINT.pointer();
  assert(!TAC(intPtr, Types.TINT));
});
test('TAC: void* ↔ T* is compatible', () => {
  const voidPtr = Types.TVOID.pointer();
  const intPtr = Types.TINT.pointer();
  assert(TAC(voidPtr, intPtr), 'void* → int*');
  assert(TAC(intPtr, voidPtr), 'int* → void*');
});
test('TAC: pointer-to-T → pointer-to-T is compatible', () => {
  const a = Types.TINT.pointer();
  const b = Types.TINT.pointer();
  assert(TAC(a, b));
});
test('TAC: pointer can ADD const at the pointee', () => {
  const charPtr = Types.TCHAR.pointer();
  const constCharPtr = Types.TCHAR.addConst().pointer();
  assert(TAC(charPtr, constCharPtr), 'char* → const char* (adding const) OK');
});
test('TAC: pointer can NOT DROP const at the pointee', () => {
  const charPtr = Types.TCHAR.pointer();
  const constCharPtr = Types.TCHAR.addConst().pointer();
  assert(!TAC(constCharPtr, charPtr), 'const char* → char* (dropping const) rejected');
});
test('TAC: pointer-to-int → pointer-to-unsigned-int is compatible (same size)', () => {
  const ip = Types.TINT.pointer();
  const up = Types.TUINT.pointer();
  assert(TAC(ip, up), 'int* → unsigned int* compatible (same-size integer base)');
});
test('TAC: _Bool ← pointer is compatible', () => {
  const intPtr = Types.TINT.pointer();
  assert(TAC(intPtr, Types.TBOOL));
});
test('TAC: divergent absorbs', () => {
  assert(TAC(Types.TDIVERGENT, Types.TINT));
  assert(TAC(Types.TINT, Types.TDIVERGENT));
});
test('TAC: void absorbs (caller already errored elsewhere)', () => {
  assert(TAC(Types.TVOID, Types.TINT));
  assert(TAC(Types.TINT, Types.TVOID));
});
test('TAC: __refextern widens to __externref', () => {
  assert(TAC(Types.TREFEXTERN, Types.TEXTERNREF));
});
test('TAC: __externref does NOT narrow to __refextern', () => {
  assert(!TAC(Types.TEXTERNREF, Types.TREFEXTERN));
});
test('TAC: NPC (literal 0) flows into pointer type', () => {
  const intPtr = Types.TINT.pointer();
  const zero = new AST.EInt(LOC, Types.TINT, 0n);
  assert(TAC(Types.TINT, intPtr, zero), 'literal 0 → int* via NPC rule');
});
test('TAC: literal 1 does NOT flow into pointer type', () => {
  const intPtr = Types.TINT.pointer();
  const one = new AST.EInt(LOC, Types.TINT, 1n);
  assert(!TAC(Types.TINT, intPtr, one), 'literal 1 → int* rejected');
});
// =============================================================================
// isBoolContextType: cond legal in if/while/do/for/?:/!
// =============================================================================

const IBC = AST.isBoolContextType;

test('IBC: arithmetic types are bool-context', () => {
  assert(IBC(Types.TINT));
  assert(IBC(Types.TFLOAT));
  assert(IBC(Types.TBOOL));
  assert(IBC(Types.TCHAR));
});
test('IBC: pointers are bool-context', () => {
  assert(IBC(Types.TINT.pointer()));
  assert(IBC(Types.TVOID.pointer()));
});
test('IBC: refs are bool-context (compiler extension)', () => {
  assert(IBC(Types.TEXTERNREF));
  assert(IBC(Types.TREFEXTERN));
  assert(IBC(Types.TEQREF));
});
test('IBC: divergent absorbs', () => {
  assert(IBC(Types.TDIVERGENT));
});
test('IBC: void / arrays / functions / structs are NOT bool-context', () => {
  assert(!IBC(Types.TVOID));
  assert(!IBC(Types.arrayOf(Types.TINT, 3)));
  // (struct types need a tag; skip — covered via integration tests)
});

// =============================================================================
// typesAreOperandCompatible: per-op operand legality (C99 6.5.5–6.5.10)
// =============================================================================

const TOC = AST.typesAreOperandCompatible;

test('TOC: arithmetic ops accept arithmetic operands', () => {
  assert(TOC('ADD', Types.TINT, Types.TINT));
  assert(TOC('MUL', Types.TINT, Types.TDOUBLE));
  assert(TOC('DIV', Types.TFLOAT, Types.TLONG));
});
test('TOC: bitwise ops require integer operands', () => {
  assert(TOC('BAND', Types.TINT, Types.TINT));
  assert(TOC('BOR',  Types.TLONG, Types.TUINT));
  assert(!TOC('BAND', Types.TINT, Types.TFLOAT), 'int & float rejected');
  assert(!TOC('BOR',  Types.TFLOAT, Types.TFLOAT), 'float | float rejected');
});
test('TOC: shift ops require integer operands', () => {
  assert(TOC('SHL', Types.TINT, Types.TINT));
  assert(!TOC('SHL', Types.TINT, Types.TFLOAT), 'int << float rejected');
  assert(!TOC('SHR', Types.TFLOAT, Types.TINT), 'float >> int rejected');
});
test('TOC: MOD requires integer operands (% on float is illegal)', () => {
  assert(TOC('MOD', Types.TINT, Types.TINT));
  assert(!TOC('MOD', Types.TFLOAT, Types.TINT));
  assert(!TOC('MOD', Types.TINT, Types.TDOUBLE));
});
test('TOC: ADD allows pointer + integer (and reverse)', () => {
  const ip = Types.TINT.pointer();
  assert(TOC('ADD', ip, Types.TINT));
  assert(TOC('ADD', Types.TINT, ip));
  assert(!TOC('ADD', ip, ip), 'ptr + ptr rejected');
});
test('TOC: SUB allows ptr-int and ptr-ptr (compatible bases)', () => {
  const ip = Types.TINT.pointer();
  const fp = Types.TFLOAT.pointer();
  assert(TOC('SUB', ip, Types.TINT));
  assert(TOC('SUB', ip, ip));
  assert(!TOC('SUB', ip, fp), 'int* - float* rejected (base mismatch)');
  assert(!TOC('SUB', Types.TINT, ip), 'int - ptr rejected');
});
test('TOC: comparisons accept arith pairs and pointer pairs', () => {
  const ip = Types.TINT.pointer();
  const fp = Types.TFLOAT.pointer();
  assert(TOC('LT', Types.TINT, Types.TINT));
  assert(TOC('LT', ip, ip));
  assert(TOC('LT', ip, fp), 'pointer comparison across base types accepted (NPC etc.)');
  assert(!TOC('LT', ip, Types.TINT), 'ptr < int rejected (LT is strict)');
});
test('TOC: EQ/NE tolerate ptr+int (NPC handled at cast site)', () => {
  const ip = Types.TINT.pointer();
  assert(TOC('EQ', ip, Types.TINT));
  assert(TOC('NE', Types.TINT, ip));
});
test('TOC: logical && / || require scalar operands', () => {
  assert(TOC('LAND', Types.TINT, Types.TINT));
  assert(TOC('LAND', Types.TINT.pointer(), Types.TFLOAT));
  // struct isn't scalar
  // (we can't construct a struct here easily without a tag; skip)
});
test('TOC: divergent absorbs', () => {
  assert(TOC('BAND', Types.TDIVERGENT, Types.TFLOAT));
  assert(TOC('MOD',  Types.TDOUBLE, Types.TDIVERGENT));
});
test('TOC: refs are tolerated (caller does ref-specific dispatch)', () => {
  assert(TOC('ADD', Types.TEXTERNREF, Types.TINT));
  assert(TOC('EQ',  Types.TEXTERNREF, Types.TEXTERNREF));
});
test('TOC: compound assigns defer to underlying op', () => {
  assert(TOC('ADD_ASSIGN', Types.TINT, Types.TINT));
  assert(!TOC('BAND_ASSIGN', Types.TINT, Types.TFLOAT), 'int &= float rejected');
  assert(!TOC('SHL_ASSIGN',  Types.TFLOAT, Types.TINT), 'float <<= int rejected');
});
test('TOC: ASSIGN is tolerated here (handled by typesAreAssignmentCompatible)', () => {
  // ASSIGN has its own predicate; this one returns true to defer.
  assert(TOC('ASSIGN', Types.TINT, Types.TFLOAT));
});

test('TAC: dropping const at the immediate pointee is rejected', () => {
  // const char *const * → const char ** : strict C99 rejects (the
  // immediate pointee const is being dropped). Other compilers warn
  // but allow; we error. The Lua codebase used to trip this; the fix
  // turned out to be in the parser (T *const param qualifier was being
  // silently consumed) — once that's fixed, source and target are equal.
  const constChar = Types.TCHAR.addConst();
  const constCharPtr = constChar.pointer();
  const constCharConstPtr = constCharPtr.addConst();
  const src = constCharConstPtr.pointer();
  const tgt = constCharPtr.pointer();
  assert(!TAC(src, tgt),
    'const char *const * → const char ** drops const at the inner pointer; reject');
});

// =============================================================================
// BinOp / UnOp registries
// =============================================================================

test('BinOp registry covers every C binary op', () => {
  const expected = ['ADD','SUB','MUL','DIV','MOD',
                    'EQ','NE','LT','GT','LE','GE',
                    'LAND','LOR','BAND','BOR','BXOR','SHL','SHR',
                    'ASSIGN','ADD_ASSIGN','SUB_ASSIGN','MUL_ASSIGN','DIV_ASSIGN',
                    'MOD_ASSIGN','BAND_ASSIGN','BOR_ASSIGN','BXOR_ASSIGN',
                    'SHL_ASSIGN','SHR_ASSIGN'];
  for (const op of expected) {
    assert(AST.BinOp[op], `missing BinOp.${op}`);
    assert(typeof AST.BinOp[op].text === 'string', `BinOp.${op}.text`);
    assert(AST.BinOp[op].linearity, `BinOp.${op}.linearity`);
  }
});
test('BinOp flags classify ops correctly', () => {
  assert(AST.BinOp.ASSIGN.isAssign, 'ASSIGN.isAssign');
  assert(AST.BinOp.ADD_ASSIGN.isAssign, 'ADD_ASSIGN.isAssign');
  assert(!AST.BinOp.ADD.isAssign, 'ADD.isAssign should be false');
  assert(AST.BinOp.EQ.isCompare, 'EQ.isCompare');
  assert(AST.BinOp.LT.isCompare, 'LT.isCompare');
  assert(!AST.BinOp.ADD.isCompare, 'ADD.isCompare should be false');
  assert(AST.BinOp.LAND.isLogical, 'LAND.isLogical');
  assert(AST.BinOp.LOR.isLogical, 'LOR.isLogical');
  assert(AST.BinOp.SHL.isShift, 'SHL.isShift');
  assert(AST.BinOp.SHR_ASSIGN.isShift, 'SHR_ASSIGN.isShift');
  assert(AST.BinOp.BAND.isBitwise, 'BAND.isBitwise');
  assert(AST.BinOp.BOR_ASSIGN.isBitwise, 'BOR_ASSIGN.isBitwise');
});
test('BinOp linearity: assigns are LINEAR, others UNRESTRICTED', () => {
  for (const op of Object.keys(AST.BinOp)) {
    const meta = AST.BinOp[op];
    if (meta.isAssign) {
      assertEq(meta.linearity, 'LINEAR', `BinOp.${op}.linearity`);
    } else {
      assertEq(meta.linearity, 'UNRESTRICTED', `BinOp.${op}.linearity`);
    }
  }
});
test('EBinary rejects unknown op strings', () => {
  const i1 = new AST.EInt(LOC, Types.TINT, 1n);
  const i2 = new AST.EInt(LOC, Types.TINT, 2n);
  assertThrows(() => new AST.EBinary(LOC, Types.TINT, 'NOT_A_REAL_OP', i1, i2),
    /unknown op/);
  assertThrows(() => new AST.EBinary(LOC, Types.TINT, 'ASSING', i1, i2),
    /unknown op/);
});
test('EBinary picks up linearity from the registry', () => {
  const i1 = new AST.EInt(LOC, Types.TINT, 1n);
  const i2 = new AST.EInt(LOC, Types.TINT, 2n);
  const add = new AST.EBinary(LOC, Types.TINT, 'ADD', i1, i2);
  assertEq(add.linearity, 'UNRESTRICTED', 'ADD on pure ints is UNRESTRICTED');
  const assign = new AST.EBinary(LOC, Types.TINT, 'ASSIGN', i1, i2);
  assertEq(assign.linearity, 'LINEAR', 'ASSIGN is LINEAR regardless of operands');
});

test('UnOp registry covers every C unary op', () => {
  const expected = ['OP_PRE_INC','OP_PRE_DEC','OP_POST_INC','OP_POST_DEC',
                    'OP_ADDR','OP_DEREF','OP_POS','OP_NEG','OP_BNOT','OP_LNOT'];
  for (const op of expected) {
    assert(AST.UnOp[op], `missing UnOp.${op}`);
    assert(typeof AST.UnOp[op].text === 'string', `UnOp.${op}.text`);
    assert(AST.UnOp[op].linearity, `UnOp.${op}.linearity`);
  }
});
test('UnOp flags: isIncDec, isAddr, isDeref', () => {
  assert(AST.UnOp.OP_PRE_INC.isIncDec, 'OP_PRE_INC.isIncDec');
  assert(AST.UnOp.OP_POST_DEC.isIncDec, 'OP_POST_DEC.isIncDec');
  assert(!AST.UnOp.OP_NEG.isIncDec, 'OP_NEG.isIncDec should be false');
  assert(AST.UnOp.OP_ADDR.isAddr, 'OP_ADDR.isAddr');
  assert(!AST.UnOp.OP_DEREF.isAddr, 'OP_DEREF.isAddr should be false');
  assert(AST.UnOp.OP_DEREF.isDeref, 'OP_DEREF.isDeref');
});
test('UnOp linearity: inc/dec LINEAR, addr AFFINE, others UNRESTRICTED', () => {
  assertEq(AST.UnOp.OP_PRE_INC.linearity,  'LINEAR');
  assertEq(AST.UnOp.OP_POST_DEC.linearity, 'LINEAR');
  assertEq(AST.UnOp.OP_ADDR.linearity,     'AFFINE');
  assertEq(AST.UnOp.OP_DEREF.linearity,    'UNRESTRICTED');
  assertEq(AST.UnOp.OP_NEG.linearity,      'UNRESTRICTED');
  assertEq(AST.UnOp.OP_LNOT.linearity,     'UNRESTRICTED');
});
test('EUnary rejects unknown op strings', () => {
  const i1 = new AST.EInt(LOC, Types.TINT, 1n);
  assertThrows(() => new AST.EUnary(LOC, Types.TINT, 'OP_NOT_REAL', i1),
    /unknown op/);
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
