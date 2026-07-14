# todos/0158 — implicit function decls now reach the linker

ICE-on-accepted-input, filed from the mgp port (todos/0119): under
`--allow-old-c`, a call to an undeclared function whose definition lives in
another TU parsed and "linked" cleanly, then codegen threw
`emitExpr: function 'f' not found`. The bison shape (grammar.c calls
`yylex()`, scanner.c defines it) hit this for real; the vendor tree worked
around it with an explicit extern.

## Root cause

The parser's implicit-decl path (`parsePrimary`, the
`_allowImplicitFunctionDecl` block) created the `DFunc` node and dropped it
into `varScope` — and nothing else. It never joined any of the unit's
declaration lists (`declaredFunctions` / `localDeclaredFunctions`), so the
linker never saw it: no undefined-symbol check, no `.definition` stitching.
Codegen then met a decl node with no `.definition` and no wasm index. The
"links cleanly" in the bug report was an illusion — the symbol was simply
invisible to linking, in both directions.

## Fix (two lines, both in the parser)

1. **Register it like a block-scope extern decl**: push the implicit decl
   onto `currentParsingFunc.externLocalFuncs` — the exact channel a literal
   `extern int f();` inside a function body uses — which flows to
   `unit.localDeclaredFunctions` at function end. The linker now stitches
   `.definition` to a cross-TU definition, or reports a real
   `Undefined symbol 'f' during linking` when there isn't one. The tree-shake
   keeps it alive via the caller's `referencedFunctions` bag, same as any
   explicit decl.
2. **Type it per C89**: `Types.functionType(TINT, [], false, /*unspecified*/
   true)` — `extern int f()`, not `int f(void)`. Before, the implicit decl's
   `()` meant zero-params, so an implicit call **with** arguments tripped the
   arity check ("too many arguments") instead of getting the C89
   default-argument-promotion treatment. Now it takes the same
   unspecified-params path as an explicit `int f();`.

The linker's `checkCompatibility` also starts working for these: an implicit
decl (return int assumed) against a cross-TU `double f(...)` definition is
now a real "conflicting types" link error instead of silent nonsense.

## Test

`tests/unit/conformance/link_implicit_decl_cross_tu/` — two-file link
(`config.json` carries `--allow-old-c`; first conformance dir to use
`compilerArgs`), no-arg and promoted-int-arg flavors, clang `-std=c89`
verified. Gate: `tests/run.js --diff` → unit 712/0 (+3 skip), blockfs 15/0,
kernel suite green (resumed from checkpoint after a session restart —
`--resume` did its job).

## Residue

Calls through unprototyped decls whose *promoted argument types* disagree
with the definition's wasm signature (K&R float params, empty-parens fn
pointers, arg-count skew) still emit invalid wasm — that's todos/0159, next.
