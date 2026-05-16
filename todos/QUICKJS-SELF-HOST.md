# QuickJS Self-Host Bootstrap — codegen bug FIXED

**Status (2026-05-17):** ✅ Fixed. The compiler can build QuickJS without
workarounds, and `compiler.js` runs inside the resulting wasm:

```bash
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs.wasm --std -e \
  "std.evalScript(std.loadFile('compiler.js')); console.log('PASS');"
# → PASS
```

`vendor/quickjs/bin.json` no longer needs `--no-reuse-locals`.

## Root cause

`GOTO_NORMALIZER.applyHoist` (in `compiler.js`) rewrites the AST so a
forward `goto` reaches a label that's structurally too deep. It splits
the label's compound: the label + everything after (the "tail") move out
to the LCA compound, and the original compound is replaced with
"pre-label statements + an unconditional goto."

The bug: if the pre-label region contained SDecls (which is exactly
QuickJS's `int opcode, arg_count, drop_count;` followed by the
`parse_func_call:` label), those DVars stay inside the now-tiny
declaring compound. Their *uses* are in the hoisted tail (different
compound). When codegen's `popLocalScope` runs at the end of the tiny
declaring compound, the DVar's wasm-local slot returns to the free
pool — even though uses still follow. A subsequent allocation reuses
the freed slot, silently corrupting the original variable.

In QuickJS this manifested as: `opcode` got the same wasm-local as
inner-block `scope` (declared inside `case OP_scope_get_var: { ... }`).
After `scope = get_u16(...)` assigned ~50, the parser later read
`opcode` and saw 50 — `OP_eval`. The bytecode emitter wrote `OP_eval`
in place of `OP_call`, mis-framed subsequent ops by 2 bytes, and the
bytecode verifier rejected the function with `stack underflow
(op=36, pc=2052)`.

## Fix

Mark every DVar whose declaring compound is split by `applyHoist` as
function-scope. Concretely:

- New `HOIST_PROMOTED_DVARS` WeakSet inside `GOTO_NORMALIZER`.
- In `applyHoist`, before the transform, iterate the pre-label
  statements; for each SDecl, add its DVars to the set.
- In codegen's `SDecl` handler, after `allocLocal`, check the set —
  if the DVar is in it, remove the just-pushed entry from the current
  local-scope tracking. The slot will never be returned to the free
  pool during this function, so no other variable can steal it.

Trade-off: ~one extra wasm-local per affected DVar. Negligible.

## Tests

- Regression test:
  `tests/unit/core/control_flow/goto/hoist_preserves_decl_lifetime/`
  — minimal C program that reproduces the exact pattern (sibling
  forward goto, outer-block SDecls, inner-block SDecl in hoisted tail
  that would otherwise steal the slot).
- All 526 existing unit tests still pass.
- QuickJS bootstrap (`scripts/quickjs-bootstrap.sh`) succeeds without
  the workaround.

## Remaining QuickJS work (separate from this bug)

- Interactive REPL: needs `qjsc.c` (QuickJS's AOT compiler) building
  and producing real bytecode for `repl.js`. Currently `repl_stub.c`
  ships an empty placeholder.
- Stage 4 self-host (compile new C inside the wasm-hosted QuickJS):
  see `demos/self-host/`.
