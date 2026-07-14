# 0158 — compiler: call via implicit function decl defined in another TU crashes codegen (emitExpr: function not found)

- **Status**: done (2026-07-15; log: logs/2026-07-15/implicit-decl-cross-tu.md)
- **Priority**: P1 (was P0 — internal compiler error on accepted input; deprioritized behind 0160/0161 since the mgp port works around it, so nothing ships broken; restore to P0 if the edge case resurfaces in live code)

## Repro

With `--allow-old-c` (allowImplicitFunctionDecl), a call to an undeclared
function whose definition lives in ANOTHER translation unit parses and
LINKS cleanly, then codegen throws:

    emitExpr: function 'yylex' not found

(`compiler.js` ~16877: `funcDefToWasmFuncIdx.get(funcDef)` misses — the
call's `funcDecl` is the implicit declaration node, its `.definition` was
never stitched to the real cross-TU definition, and the implicit decl
itself is not in the index map.)

Hit porting mgp (todos/0119): bison's generated `grammar.c` calls `yylex()`
with no declaration; `scanner.c` defines it. Worked around by adding an
explicit `extern int yylex(void);` to the generated file (see
`vendor/magicpoint/README.md`).

Minimal shape:

```c
/* a.c */ int main(void) { return f(); }      /* no decl of f */
/* b.c */ int f(void) { return 42; }
/* node compiler.js --allow-old-c a.c b.c — ICE instead of wasm or diagnostic */
```

## Fix expectation

Either stitch implicit decls to cross-TU definitions during link (they
already resolve there — link reports no undefined symbol), or fail with a
proper diagnostic. An internal throw is never the right outcome. Add the
repro under tests/unit (conformance-style, two-file link).
