# WAST Stage 2 — defer serialization, open the pass hook (todos/0198)

Function bodies now PERSIST as WAST node lists on `wmod.funcDefs[i].wast`
after codegen and serialize at `WasmModule.emit`'s code-section writer,
with an identity `WAST.runPasses(wmod)` seam in between. Output is again
byte-for-byte identical to Stage 1 (todos/0197) — deferring WHEN we
serialize changed nothing about WHAT we serialize.

## Why

Stage 1 built the representation; Stage 2 buys the WINDOW. Later stages'
transforms need finished trees: peephole is per-function, but the inliner
is cross-function — it must see every function's nodes at once, which is
only possible after all of codegen has run. Serializing at the end of
`emitFunctionBody` (Stage 1) closed that window per-function; moving the
serialization point to the code-section writer opens it module-wide.

## Shape

- `emitFunctionBody` validates the sequence (unchanged, same error
  attribution) and stores `wmod.funcDefs[defIdx].wast = nodes` instead of
  serializing. The Stage-1 goto-rollback skip is preserved verbatim: an
  attempt whose `gotoErrors` grew stores nothing (the sequence may be
  legitimately unbalanced — forward-label blocks opened, never closed).
- The driver's goto-retry rollback becomes a node discard (`wd.wast =
  null`) + the surviving side-array truncations (locals, gotoErrors,
  localNames). The `body`/`sourceMapEntries` length snapshots died —
  nothing appends to either during emit anymore.
- `WAST.runPasses(wmod)` is the seam, called at the TOP of
  `WasmModule.emit` — before ANY section bytes, because future passes may
  add locals or types and sections 1/3 precede the code section. Identity
  in Stage 2 by design; a pass that rewrites a function must re-run
  `validate()` on it (rule recorded at the hook).
- The code-section loop serializes each `def.wast` into `def.body` right
  where the size prefix / `funcBodyOffsets` / `preambleSize` math already
  ran; a funcDef without a tree falls through to the raw-bytes path.
  All func/global/type indices are pre-pass-assigned, so trees are fully
  formed by emit time.

## Source map

`onSrcLoc` byte offsets exist only at serialize time, so
`sourceMapEntries` ({funcIdx, entries}) are produced by the code-section
writer now (pushed into the same cg-shared array; the `c.sourcemap`
section is written after section 10, so ordering works out). Push order
shifted from codegen order to defIdx order — irrelevant by construction:
the section writer flattens ALL entries and stable-sorts by absolute
offset, and cross-function offsets can't collide (bodies occupy disjoint
section ranges). Codegen's `currentFuncSourceMap` collector array became
the honest boolean `emitSrcLocMarkers` (it only gated WSrcLoc marker
creation since Stage 1). sourcemap + disw goldens pass untouched.

## The `.body` early-reader audit

The main correctness risk of the move: anything reading
`funcDefs[].body` bytes between `emitFunctionBody` and `emit`. Grepped
the lot — exactly two touch points existed, both in on the plan:
the code-section writer (now the serialization point) and the driver
rollback's `bodyLen` snapshot (now dead, removed). Nothing else reads
function-body bytes before emit; `WebAssembly.validate` runs on the
emitted module after.

## The gate (all foreground, this machine)

- Byte-identity harness (the Stage-1 recipe: compile all tests/unit
  in-process + build all 25 vendor bin.jsons + bake the system image
  in-memory, `Date` frozen for `__DATE__`/`__TIME__`): **726 unit records
  (629 wasm hashes) + 25 vendor wasm + 162 image entries — zero diffs**
  vs a fresh Stage-1-HEAD baseline (which itself reproduced the Stage-1
  run bit-for-bit).
- disw + sourcemap byte-level goldens: 8/8, not regenerated.
- unit 715 + 8 xfail; host ok; blockfs 15; run.py categories 274;
  micropython-upstream 513 passed / 3 failed — the SAME 3 float tests
  fail on clean HEAD (pre-existing, environmental).
- kernel 73/73 (423s, includes full OS boots).
- browser sweep 24/25 + os-wm.mjs retried green. The os-wm failure
  ("keyboard Move relocated C") is a pre-existing timing flake, NOT this
  change: the binaries the sweep drives hashed identical, and the leg
  flip-flops run-to-run on this machine (fail/pass/pass on the same
  tree). Filed as its own P0 (todos/0199) rather than quieted here.
- `tools/mkimage.js`: v93 bakes, seals, verifies.

## Deliberately NOT here

No passes — no peephole, no inliner. No WasmCode deletion (still the
right tool for 2-instruction const-exprs). No change to emitStmt/emitExpr
or the WAST node set. Next stage plugs real passes into `runPasses` and
re-validates each rewritten function.
