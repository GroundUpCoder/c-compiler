# 0201 — WAST Stage 3b: whole-body inliner

- **Status**: done (2026-07-15; WAST.inlineFunctions landed in runPasses ahead of foldMemOffsets — eligible direct WCalls splice the callee's renumbered body under a fresh wrapper block, WReturn/funcLabel-branches → WBr(wrapper), reverse-drain param binding, verbatim fixed-frame splice, Tarjan callee-first order with SITE-LEVEL recursion snapshots (refuse only caller==callee — the SameBoy hot loop is one SCC closed by the run-once GB_borrow_sgb_border→GB_run_frame boot edge, so the specced SCC-wide refusal was relaxed by coordinator decision). Conservative budgets BY DESIGN (calleeCap 64 real nodes / callerGrowth 1000, tunable via WAST.inlineDefaults): the big-callee 5.4x unlock (GB_read_memory ~397 / GB_advance_cycles ~534 / cycle_write ~1211 nodes at dozens of sites, real V8 tier-up risk) is documented DEFERRED work, not a bug. Clones are fresh instances (shared WMop = double-fold miscompile) and drop WSrcLoc (call-site attribution — flat c.sourcemap has no inline frames). SameBoy: 510 sites inlined (863 budget-refused), checksums IDENTICAL across all runs vs baselines + clang, ms/frame FLAT as pre-accepted (5.565→5.636 mean, inside the ±2.5% clang-control noise band; +9.5% wasm bytes). tests/ast/test_wast_inline.js: 53 pinned cases — every supported mechanic, every refusal category, 4 end-to-end C execution checks. Full estate green: unit 715+8 xfail, run.py 274, blockfs+host, kernel 73/73, sweep 25/25 first try, mkimage v95 seals; mp-upstream at the same 3 pre-existing float failures (verified vs clean HEAD). Log: logs/2026-07-15/wast-inliner-0201.md)
- **Design**: WAST substrate (todos/0197/0198), pass seam `WAST.runPasses`;
  Step-0 hot-callee analysis in logs/2026-07-15/wast-inliner-0201.md

## Goal

Whole-body inlining at the WAST level — replace an eligible direct `WCall`
with the callee's renumbered body spliced into the caller, using the
substrate's symbolic label identities (return → `WBr` to a fresh wrapper
block; internal branches keep their cloned labels; no depth arithmetic).

**Deliberately CONSERVATIVE-CORRECT (coordinator decision 2026-07-15):**
semantic correctness + exhaustive transform-mechanics tests first; modest
budgets that inline only small/simple callees. This stage does NOT chase
the SameBoy 5.4x gap — that would need aggressive big-callee inlining
(GB_read_memory ~397 nodes, GB_advance_cycles ~534, cycle_write ~1211,
read_high_memory ~1685) at dozens of sites, with real V8 tier-up risk.
Documented deferred option, not a bug. Flat/modest bench movement is
acceptable and reported, not gated.

## Plan

- Stamp `fnMeta` (variadic / frameSize / overAligned / structRet /
  usesAlloca) on the funcDef at emitFunctionBody time.
- `WAST.inlineFunctions(wmod)`: Tarjan over the WCall graph, SCC
  condensation post-order (callees before callers on the DAG part);
  site-level recursion rule — refuse only caller==callee, splice a SINGLE
  snapshot of a same-SCC callee's current body (no fixpoint; internal
  recursive calls stay real calls). The SameBoy hot loop is one big SCC
  closed by the run-once SGB-border boot edge
  (GB_borrow_sgb_border→GB_run_frame), so the SCC-wide v1 refusal would
  have blocked everything.
- Transform: local renumber (+callerLocalCount, params share the callee
  index space), append callee param types + declared RLE locals to the
  caller vector, reverse-order `WLocalSet` drain binds args (eval-once,
  source order), body wrapped in `WBlock(result-type)`, `WReturn` and
  funcLabel-targeted branches → `WBr(wrapper)`. Standard fixed frames
  splice VERBATIM (savedSp renumbered → correctly nested dynamic frame).
  Deep-clone every node (a shared mutable `WMop` would double-fold later).
- Refuse (silent per-site skip): self-recursion, variadic, alloca,
  over-aligned frameBase, struct-return, WTryTable/WThrow, WRaw, imported
  targets, missing wast, multi-value results, over-budget
  (calleeCap / callerGrowth, tunable via `WAST.inlineDefaults`).
- Pass order: inline FIRST, then foldMemOffsets; re-validate every
  rewritten function; never delete inlined-away functions (indices baked
  into call immediates + element section).

## Acceptance

- `tests/ast/test_wast_inline.js`: pinned shape tests for EVERY supported
  case (single/multi-arg binding, return-in-loop lowering, frameless +
  fixed-frame splice, recursion snapshot, nested composition, local
  renumber) and one per refusal category; plus end-to-end C execution
  checks (eval-once, return-in-loop, frame nesting, recursion).
- SameBoy framebuffer-checksum interlock identical vs baselines.json and
  the clang leg (primary oracle).
- Full estate green (unit/ast/run.py/blockfs/host/kernel/browser sweep/
  mkimage); micropython-upstream same 3 pre-existing float failures.
- ms/frame delta + inline/refusal counts reported (perf informational).
