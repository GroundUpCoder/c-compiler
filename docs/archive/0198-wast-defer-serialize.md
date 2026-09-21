# 0198 — WAST Stage 2: defer serialization, open pass hook (byte-identical)

- **Status**: done (2026-07-15; serialization deferred to WasmModule.emit's code-section writer — node lists persist on funcDefs[].wast, identity WAST.runPasses(wmod) seam opened at the top of emit(), source-map entries produced at serialize time, goto-retry rollback is a node discard. BYTE-IDENTICAL: 726 unit records/629 wasm + 25 vendor wasm + 162 baked-image entries match the Stage-1 baseline, disw/sourcemap goldens untouched, full estate green (os-wm sweep flake pre-existing, filed separately), mkimage v93 seals. No passes — those are later stages. Log: logs/2026-07-15/wast-defer-serialize-0198.md)
- **Design**: logs/2026-07-15/wast-flat-substrate-0197.md (Stage 1), todos/done/0197

## Goal

Make the per-function WAST node lists (todos/0197) PERSIST past codegen and
serialize at the code-section writer, so later stages (peephole is local, the
inliner is cross-function) can transform them in between. Open the seam —
one clearly-named identity pass hook — but run NO passes. Output stays
byte-identical across the whole estate.

## Plan

- `emitFunctionBody` stores `wmod.funcDefs[defIdx].wast = <node list>` after
  `validate()` instead of serializing into `.body`; the goto-rollback skip
  (unbalanced attempt when `gotoErrors` grew) is preserved.
- `WasmModule.emit`'s code-section loop serializes each `def.wast` into the
  body bytes at that point; `onSrcLoc` source-map entries are recorded there
  (byte offsets exist only at serialize time) and the existing
  body-relative → absolute rebasing is unchanged (flatten + stable
  offset-sort makes push order irrelevant).
- The driver's goto-retry rollback becomes a node-list discard; the
  `body`/`sourceMapEntries` snapshots die (nothing appends to them during
  emit anymore), locals/gotoErrors/localNames resets stay.
- `WAST.runPasses(wmod)` is the hook, called at the TOP of `WasmModule.emit`
  (before any section is written — future passes may add locals/types, and
  sections 1/3 precede the code section). Identity in Stage 2.

## Acceptance

- Byte-identity harness (Date frozen): every unit/conformance wasm + all
  vendor builds + the full image bake hash-identical to Stage-1 HEAD.
- disw + sourcemap goldens pass untouched; `node tests/run.js all` green
  (modulo the 3 pre-existing micropython float failures); kernel suite
  green; `tools/mkimage.js` bakes/seals/verifies.
- No optimization passes added; WasmCode untouched.
