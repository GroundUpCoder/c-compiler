# WAST Stage 3b — the whole-body inliner (todos/0201)

The first cross-function transform through the 0197/0198 substrate:
`WAST.inlineFunctions` replaces an eligible direct `WCall` with the
callee's renumbered body, spliced in place. The label-identity design
paid off exactly as intended — return lowering is `WReturn → WBr(wrapper
block)` (and funcLabel-targeted branches → the same wrapper), internal
branches keep their cloned labels, and the serializer re-derives every
depth; there is no depth arithmetic anywhere in the pass.

## Step 0 — the SCC finding, and the coordinator decision

Analysis of the actual SameBoy bench module (754 defined functions) before
building anything: **the entire hot loop is one mutually-recursive SCC**,
so the originally-specced v1 rule "any call-graph cycle participant →
refuse" would have blocked every hot callee. The closing edge is the
run-once SGB-border boot path — `GB_borrow_sgb_border → GB_run_frame`
(gb.c:302 runs 600 frames on a scratch GB to borrow a border) — which
statically links `cycle_read → GB_advance_cycles → GB_display_run →
GB_display_vblank → GB_borrow_sgb_border → GB_run_frame → GB_run →
GB_cpu_run → cycle_read`. `GB_advance_cycles` is also directly
self-recursive (timing.c:449, the `unlikely` speed-switch split).

Coordinator decision (green-light with conservative scope):

1. **Site-level recursion relaxation** — refuse only `caller == callee`;
   a same-SCC callee splices a SINGLE snapshot of its current body (no
   fixpoint). Each splice is locally semantics-preserving regardless of
   recursion (the clone's internal calls stay real calls) and termination
   is structural (one walk per caller's original nodes; spliced content
   is never re-scanned). The DAG part keeps Tarjan completion order —
   callees before callers — so nested inlines compose.
2. **Conservative budgets, deliberately NOT chasing the 5.4x.** This is
   the load-bearing scope decision: closing the SameBoy gap needs the big
   callees — GB_read_memory ~397 real nodes, GB_advance_cycles ~534,
   cycle_write ~1211, read_high_memory ~1685 — inlined at dozens of
   sites, which risks blowing hot functions past V8's optimizing-tier
   sweet spot (the classic tier-up regression). That path is a
   **documented, deliberate future option, not a bug**. Stage 3b ships
   `calleeCap: 64` real nodes / `callerGrowth: 1000` (tunable via
   `WAST.inlineDefaults`), which inlines the small-wrapper class —
   cycle_read (46 real nodes, 58 sites), memcpy/memset wrappers,
   GB_get_thread_id, __ap_str — and refuses the rest.

## Supported vs refused (v1 surface)

Supported (all pinned in `tests/ast/test_wast_inline.js`): frameless
callees; STANDARD fixed-frame callees spliced VERBATIM (savedSp
renumbered like any local — the self-contained prologue/epilogue nests a
dynamic frame per site; merging is future work); multi-arg binding via
reverse-order `WLocalSet` stack drain (args evaluated exactly once, in
source order — they're already on the operand stack as the call's
preceding siblings); return→br including returns nested inside
loops/ifs; nested composition; recursion snapshots; inlining INTO any
caller shape (variadic callers, framed callers, callers inside
try_table).

Refused per-site, silently, with per-reason telemetry
(`wmod.passStats.inline`): self-recursion, imported targets, raw/absent
bodies (`fnMeta` is stamped only alongside a stored tree), variadic
callees (dynamic arg-block ABI), alloca, over-aligned/masked frameBase,
struct-by-value return (sret ABI + caller-deferred SP restoration),
WTryTable/WThrow, WRaw (opaque bytes embed un-relocatable local
indices), multi-value results, budget. Inlined-away functions are never
deleted — indices are baked into call immediates and the element section.

Key implementation facts:

- `fnMeta` (variadic/frameSize/overAligned/structRet/usesAlloca) is
  stamped by `emitFunctionBody` next to the stored tree — the WAST level
  cannot reliably reconstruct ABI facts from nodes.
- Every cloned node is a FRESH instance. Not optional: `foldMemOffsets`
  mutates `WMop.offset` in place, so a node shared between two lists
  would fold in one and then read as already-folded (offset≠0) next to
  its still-present const+add in the other — a silent double-displacement
  miscompile. `order-fresh-instances` pins this.
- Pass order in `runPasses`: inline FIRST, then foldMemOffsets — folds
  newly exposed inside inlined bodies get taken (SameBoy: 3931 → 4183
  folds, +252 from clones). Every rewritten function re-validates.
- **Sourcemap semantics: call-site attribution.** Clones DROP the
  callee's `WSrcLoc` markers. The flat `c.sourcemap` offset→line table
  has no inline-frame concept, so callee lines inside the caller's byte
  range read as cross-function leakage — caught immediately by
  `tests/sourcemap/line_numbers` ("main references line 7 which belongs
  to 'use_stack'"), whose invariant is worth keeping. Inlined
  instructions attribute to the caller's marker at the call site.

## The gate (all foreground, this machine)

- **SameBoy framebuffer-checksum interlock (primary oracle): PASS.** All
  three sums (N=200/600/1000: 70866000 / bd26bb7b / 42d967fd) identical
  before vs after, vs `baselines.json`, and vs the clang leg, across
  every run (6 post-change legs). The delicate work — frame splice,
  renumber, return lowering — changed 510 call sites and the pixels
  didn't move.
- unit 715 + 8 xfail; ast 3/3 files (the new test_wast_inline.js: 53
  cases — every supported mechanic + every refusal category + 4
  end-to-end C execution checks); run.py categories 274/274; blockfs +
  host ok; kernel 73/73 (426s — full OS boot, every binary inlined);
  browser sweep 25/25 first try (the 0199 os-wm flake didn't trigger);
  mkimage v95 bakes/seals/verifies (version bumped 94→95 — compiler.js
  changes every baked binary).
- micropython-upstream: 513 passed / 3 failed — the SAME 3 float tests
  (builtin_float_round, math_domain, math_fun_int) fail on stashed clean
  HEAD, verified this run. Pre-existing/environmental.

## The measured result — FLAT, as pre-accepted

SameBoy bench (cc leg): pre mean **5.565 ms/frame** (5.564–5.566, 2
runs), post mean **5.636 ms/frame** (5.624–5.660, 4 runs) — nominally
**+1.3%**, while the unchanged clang control wobbled 1.041–1.095 across
the same span (±2.5%), so the delta is at/inside the harness noise
floor. Module: 271376 → 297055 B wasm (+9.5%), 113866 → 127141 instrs
(+11.7%), code section 224871 → 250550 B.

Inline telemetry for the bench module: **510 sites inlined**; refused:
863 budgetCallee (the big callees, by design), 119 imported, 94
variadic, 80 raw, 11 self, 6 budgetCaller, 1 alloca.

Reading: V8's optimizing tiers already inline the small-wrapper class
this budget admits, so wall-clock doesn't move; what we bought is the
transform machinery, proven correct under the checksum interlock, plus
cleaner post-inline node sequences for later passes. **The 5.4x gap
remains, and remains attributed to the big-callee path this stage
deliberately did not take.** Anyone picking that up later: raise
`calleeCap` toward ~600–1200, re-run the interlock + bench, and watch
for tier-up regressions — the machinery is ready; the budget is the
only gate.

## Deliberately NOT here

No frame merging (nested per-site frames are correct, just not fused),
no local-slot reuse across sites of the same callee, no dead-function
compaction after inlining, no fixpoint iteration within SCCs, no
inline-frame sourcemap representation, no big-callee budget tuning (the
documented deferred option above).
