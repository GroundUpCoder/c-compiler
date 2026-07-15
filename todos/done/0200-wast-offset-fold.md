# 0200 — WAST Stage 3a: load/store offset-fold peephole

- **Status**: done (2026-07-15; foldMemOffsets landed in WAST.runPasses — loads fold the adjacent const+add into the memarg offset, stores match across one pure value node (the adjacent-triple store form is a miscompile, pinned in tests/ast/test_wast_passes.js), k >= 0 only via serialize()'s own Number|0 normalization, greedy +0 chains, second pass a no-op, rewritten functions re-validated. SameBoy: 3931 folds, −6.5% instructions, −4.4% wasm bytes, framebuffer checksums IDENTICAL (the interlock gate); ms/frame flat (V8 already folds addressing — the inliner remains the perf candidate, todos/0186). Full estate green: unit 715+8 xfail, ast 2/2, run.py 274, kernel 73/73, sweep 25/25 first try, mkimage v94 seals; mp-upstream at the same 3 pre-existing float failures (verified vs clean HEAD). disw/sourcemap goldens legitimately unchanged (the only compiler-built golden has zero memory ops); spot-check done against a real binary instead. Log: logs/2026-07-15/wast-offset-fold-0200.md)
- **Design**: logs/2026-07-15/wast-defer-serialize-0198.md (substrate), this item (pass)

## Goal

The first real WAST optimization pass: fold the `i32.const k; i32.add`
address-displacement pair into the load/store memarg `offset=` immediate.
Codegen emits EVERY memory op with offset 0 and materializes all address
arithmetic explicitly, so the immediate is entirely unused — folding it
removes a const+add pair on essentially every struct-member and array
access. Registered in `WAST.runPasses(wmod)` (the 0198 seam).

## Plan

- Adjacent-sequence peephole per function node list:
  - loads: `[WConst i32 k, WAop i32.add, WMop load off=0]` → `[WMop load off=k]`
  - stores: `[WConst i32 k, WAop i32.add, V, WMop store off=0]` →
    `[V, WMop store off=k]` where V is ONE pure single-push node
    (WConst/WLocalGet/WGlobalGet) — a store pops [value, addr] with the
    value on TOP, so the node before the store is the value producer and
    the naive adjacent triple would fold the VALUE computation (miscompile).
- Skip: negative k (and its wrapped-u32 spelling — normalize via
  `Number(v)|0`, exactly what serialize() emits), non-i32-add, nonzero
  existing offset, any class mismatch (WRaw/control/WSrcLoc barriers fall
  out of exact-class matching).
- Greedy at the fold site so `+0` chains collapse in one pass; second run
  of the pass is a no-op. Re-validate every rewritten function.

## Acceptance

- SameBoy framebuffer-checksum interlock (`tests/bench`) unchanged vs
  `baselines.json` — the primary correctness oracle.
- Full estate green: unit, ast (incl. new `test_wast_passes.js`), run.py
  categories, blockfs, host, kernel, browser sweep; mkimage bakes/seals;
  micropython-upstream at the same 3 pre-existing float failures.
- Fold count + ms/frame + bytes/instr deltas reported in the close-out log.
