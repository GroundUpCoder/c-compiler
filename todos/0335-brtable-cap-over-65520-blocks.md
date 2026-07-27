# 0335 — a function with more than 65520 basic blocks still dispatches through a linear compare chain

- **Status**: open
- **Context**: `logs/2026-07-27/0332-dispatch-1000x-rootcause.md`

## Goal

Remove the last case in which `compiler.js` emits an O(cases) `br_if` compare
chain for a *dense* switch.

## What is established

`todos/0332` fixed the switch-lowering cap by raising `MAX_BR_TABLE_RANGE` from
512 to **65520**, which is V8's `kV8MaxWasmFunctionBrTableSize` — measured, not
recalled: a hand-built module with a 65520-entry `br_table` validates and 65521
is rejected with *"invalid table count (> max br_table size)"*.

That is an **engine ceiling**, so the residual cannot be closed by raising the
constant again. It bites the irreducible (loop-switch) lowering specifically: its
synthetic `switch (__irreducible_state)` has one perfectly-dense case per basic
block, so a lowered function with **more than 65520 blocks** falls back to the
linear chain and pays ~32,760 comparisons per block transition — the exact 0332
pathology, at 11x the scale.

No such function exists in the tree today. The largest measured is CPython's
`_PyEval_EvalFrameDefault` at **5752** blocks, an order of magnitude under the
cap. This is a **latent** bound, not a live defect — which is why it is P2 and
not a P0 like 0332.

## Plan

A two-level dispatch when `range > 65520`: a `br_table` on `state >> 16` into
per-chunk blocks, each holding a `br_table` on `state & 0xFFFF`. Two constant-time
hops instead of one, no chain at any size, and it composes with the existing
`dense` test — the outer table is dense by construction because the inner chunks
are contiguous.

Cheapest first step is a *detector*, not the fix: the lowering already knows the
segment count, so it can refuse-loudly (or warn) above 65520 rather than silently
emitting a 65520+-entry chain. A silent O(n) fallback is exactly how 0332 hid for
as long as it did.

## Acceptance

- A generated C repro with >65520 blocks in one function, compiled and run.
- Either the two-level dispatch, or a loud diagnostic naming the function and its
  block count — not a silent degradation.
- `tools/bench2x2/cmpchain.js` reports no chain longer than the ordinary
  sparse-switch tail (~31) in the repro's emitted wasm.
