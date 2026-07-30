# Specialization-aware inlining + WAST simplification pipeline — unified design

Status: DESIGN (no implementation). Companion queue items to be filed on
acceptance (Item A substrate first, Item B on top of it).

Background (read first): the WAST substrate + whole-body inliner —
todos/done/0197 (nodes), 0198 (pass seam), 0201 (inliner), 0214 (tree-shake,
policy attrs); logs/2026-07-15/{compiler-perf-bench-0186,
whole-program-inlining-0188, wast-inliner-0201}.md. Bench harness:
`tests/bench/run.js` (SameBoy GBC, slope ms/frame over the 800-frame span,
framebuffer-checksum interlock against `baselines.json`, clang leg via
external `cc2wasm`).

---

## 1. Problem statement

The measured baseline (0186, stable across months):

```
cc 5.70 ms/frame | clang 1.05 ms/frame | 5.4x | checksums IDENTICAL
```

Purely a speed gap — the pixels never move. Root cause is settled (0201 Step
0): SameBoy's whole hot loop is ONE mutually-recursive SCC
(`cycle_read → GB_advance_cycles → … → GB_cpu_run → cycle_read`, closed by
the run-once SGB-border boot edge). The 0201 inliner CAN splice those
callees — the machinery is proven under the checksum interlock (510 sites
spliced, pixels identical) — but the budget is the closed gate:
`inlineDefaults.calleeCap 64 / hintCalleeCap 256` produced **863
budgetCallee refusals by design**, exactly on the big hot callees
(GB_read_memory ~397 real nodes, GB_advance_cycles ~534, cycle_write ~1211,
read_high_memory ~1685; dozens of sites each).

**Why the fix is NOT "raise calleeCap".** 0201's own reading: splicing a
~400-node callee verbatim at 58 sites inflates the caller by ~23k nodes of
mostly-foldable dispatch, with a real V8 tier-up-regression risk, and V8's
optimizing tier already re-derives nothing we didn't hand it — we'd be
paying full size cost for code that is 90% dead AT EACH SPECIFIC SITE.
clang wins because:

1. it **re-simplifies between inlining rounds**, bottom-up per call edge —
   SCCP/DCE/CSE clean each splice before the next decision is made;
2. its cost model **simulates and specializes**: it propagates THIS site's
   constant arguments into the callee and prices the *post-specialization*
   size, discounting instructions it knows the cleanup will fold. SameBoy's
   memory-region dispatch (`GB_read_memory`'s address-class `switch`)
   collapses to one arm when the address class is a compile-time constant
   at the site — the ~397-node callee inlines as ~30 specialized nodes;
3. hot/cold call-site weighting spends size where the cycles are;
4. recursion is bounded by **inline-history depth**, not a blanket SCC
   refusal.

clang's cost model is only honest because its cleanup pipeline exists — the
model *predicts the cleanup*. We currently have exactly one cleanup pass
(`foldMemOffsets`, a narrow const+add→displacement peephole). So this is
two coupled designs:

- **Item A (substrate, ships first):** a Binaryen-shaped simplification
  pipeline on the WAST tree — precompute/const-prop, DCE, local CSE,
  peephole — backed by ONE reusable local-def-use / reaching-defs analysis.
- **Item B (on A):** retarget `inlineFunctions` to a
  simulate-and-specialize cost model whose simulation IS Item A's engine
  run in measure-only mode, plus hot/cold weighting, inline-history
  recursion bounding, and a V8-cliff-calibrated caller budget.

They share the analysis, so the interface is drawn here, together, first.

## 2. Core principle — build the general case

Per the repo's core principle: **no "small-callee-only / demo-pass"
shortcut.** The entire point of this project is the big-callee path — the
863 refusals. Every piece below is designed at full generality:

- The analysis engine handles *every* WAST node class the serializer
  accepts (fail-loud on an unknown class, the `cloneInlineBody` precedent),
  not just the subset SameBoy's hot loop happens to use.
- Passes are correct on arbitrary structured bodies (framed callees, EH
  regions as barriers, WRaw as barriers) — not tuned to one benchmark.
  SameBoy is the *oracle*, not the *scope*.
- Specialization simulation covers written params naturally (initial-value
  seeding + kill semantics), with read-only params as the cheap fast path —
  not a read-only-only special case.
- No pass may be "correct only under the current pass order": each pass
  re-validates its rewrites and is independently toggleable.

The escape hatches taken are enumerated in §9 (risks) and §10 (open
questions) — surfaced, not silently cut.

## 3. The shared analysis layer

### 3.1 What both consumers need

| Consumer | Query |
|---|---|
| A: const-prop/precompute | "what value does this `WLocalGet` hold?" → reaching defs + the def's value producer |
| A: DCE (dead stores) | "is this `WLocalSet` ever read?" → def→use chains |
| A: local CSE | "do the locals used by this window get redefined in between?" |
| B: read-only-param check | "is param k ever written in the callee?" |
| B: specialization simulation | "seed params with these constants; how many real nodes survive folding + DCE?" — i.e. run A's evaluator without rewriting |

So the layer is two artifacts over one walk skeleton:

1. **`LocalUse`** — the Binaryen-LocalGraph equivalent: def→use / use→def
   chains over mutable locals, computed **on demand** per function.
2. **`AbstractEval`** — the one abstract interpreter (shadow value stack +
   local lattice + control stack) with two modes: `rewrite` (Item A's
   precompute pass) and `measure` (Item B's simulation). One engine, so
   B's prediction and A's cleanup can never drift apart — that is the
   load-bearing property clang has and we are copying.

### 3.2 Explicitly NON-SSA

Binaryen precedent: it optimizes structured IR with no persistent SSA form,
computing SSA-flavored local-def-use on demand (LocalGraph). We do the
same. Wasm structured control flow is **always reducible** — every loop has
exactly one header (`WLoop`), every branch targets an enclosing construct —
which makes reaching-defs tractable with a single forward pass plus a
per-loop gen-set (no worklist, no fixpoint iteration; §3.4). Wasm locals
are function-private and untouched by calls/memory, so the analysis has
none of C's aliasing problems: **the ONLY defs are `WLocalSet`/`WLocalTee`
and the function entry** (params = argument values, non-params = zero
init). Building persistent SSA would buy nothing and cost a
representation migration; rejected.

### 3.3 API surface (inside the WAST module)

```js
// ---- shared analysis (todos/A) ----

// Per-node stack arity. Everything the serializer accepts has a static
// {pops, pushes} derivable from the node + wmod (WCall via typeDefs,
// WAop via wt/op, WMop load 1→1 / store 2→0, ...). WRaw and WTryTable
// return null = OPAQUE (analysis barrier). Fail-loud on unknown classes.
function stackEffect(node, wmod, ctx) -> { pops, pushes } | null

// Reaching-defs / def-use over one function. O(nodes + loops·assignedLocals).
// PURE — never mutates the tree.
function computeLocalUse(def, wmod) -> LocalUse
LocalUse = {
  wast,                    // the def.wast array identity this was computed on
  defsFor(getNode)  -> Set<WLocalSet|WLocalTee|ENTRY>,   // ENTRY = param/zero-init sentinel
  usesFor(defNode)  -> Set<WLocalGet|WLocalTee-as-read>,
  singleDef(getNode)-> WLocalSet|WLocalTee|ENTRY|null,   // convenience: |defs|==1
  writtenLocals     -> Uint8Array,                       // any set/tee per local idx
}

// The cheap linear check (no LocalUse needed): param idx k is READ-ONLY
// iff no WLocalSet/WLocalTee in the body targets k. A read-only param is
// SSA-equivalent — its entry value holds at every use.
function readOnlyParams(def, wmod) -> Uint8Array   // 1 = read-only, per param idx

// The one engine. opts.mode:
//  'rewrite'  — Item A precompute: folds const chains, prunes untaken
//               arms, returns { nodes, changed } (fresh array, input untouched)
//  'measure'  — Item B simulation: NO tree mutation; returns
//               { realSurviving, foldedBranches, collapsedNodes }
// opts.paramFacts: Array<{wt, value}|null> — seeds the ENTRY defs (Item B
// passes the call site's constant args; Item A passes nothing).
function abstractEval(def, wmod, opts) -> RewriteResult | MeasureResult
```

Exported for tests as `WAST.Analysis = { stackEffect, computeLocalUse,
readOnlyParams, abstractEval }`.

### 3.4 The reaching-defs algorithm (concrete)

One forward walk over the flat node list, mirroring `validate()`'s control
stack. State: `localIdx → def set` (sets of node identities + the ENTRY
sentinel), plus an `unreachable` flag.

- `WLocalSet/WLocalTee idx` — kill: state[idx] = {thisNode}.
- `WBlock` — push frame; frame accumulates a pending-merge state from
  branches that target it.
- `WBr/WBrIf/WBrTable` — union current state into each target frame's
  pending merge; after an unconditional `WBr`/`WReturn`/`WUnreachable`/
  `WThrow*`, state := ⊥ (unreachable) until the next `WElse`/`WEnd`.
- `WIf` — save input state for the else arm; `WElse` restores it; `WEnd`
  of an if unions the arm outputs (+ the input when no else).
- `WEnd` of a block — union the fall-through state with the frame's
  pending merge.
- `WLoop` — the one place back edges exist. Instead of fixpoint
  iteration: pre-scan the loop's extent once for its **gen set** (every
  local assigned anywhere inside), and at the loop head widen
  `state[idx] ∪= defsInside(idx)` for each gen-set local. For a
  union/may lattice this IS the fixpoint result (a def inside the loop
  either reaches the back edge or is killed on every path — the union
  over-approximates the latter case only, which is sound and in practice
  near-exact). Single pass, no worklist; nested loops compose because the
  outer pre-scan covers the inner extent.
- `WCall/WCallIndirect/WMop/WGlobal*` — no effect on locals (wasm
  guarantee). `WRaw` — treated as *potentially reading and writing every
  local* (raw bytes may embed local indices — the inliner refuses them
  for exactly this reason): kill all locals to a fresh OPAQUE def and
  mark every prior def as used. `WTryTable` regions — same conservative
  treatment for the whole region in v1 (EH bodies are rare and cold).
- `WSrcLoc` — transparent.

`abstractEval` runs the same walk with a **shadow value stack** alongside:
each stack slot carries `{kind: CONST|OTHER, wt, value, producerRange}`
where producerRange is the contiguous node span that produced the slot
(enabling rewrite mode to delete/replace producers). Merges at control
joins meet CONST×CONST-equal → CONST, else OTHER. Opaque nodes (`WRaw`,
`stackEffect === null`) flush the shadow stack to OTHER and end the
current folding window — a **barrier, not a bailout** (the rest of the
function still optimizes; `foldMemOffsets` precedent).

### 3.5 Invalidation contract

Cache key = the `def.wast` **array identity** (the `scanCallee` precedent
at compiler.js:15330). The existing pass convention is load-bearing and
becomes normative:

> A pass that changes local flow MUST replace `def.wast` with a fresh
> array (rebuild-out style, like `foldMemOffsets`/`inlineFunctions`) and
> re-run `validate()`. In-place mutation is permitted ONLY for immediates
> that no analysis reads for flow (e.g. `WMop.offset`, `WCall.funcIdx`
> renumbering).

Consumers hold a `LocalUse` only while `localUse.wast === def.wast`;
`computeLocalUse` memoizes on a per-`runPasses` WeakMap keyed by the array,
so between inliner rounds every rewritten function re-analyzes and every
untouched function hits cache. Nothing is persisted across `runPasses`
invocations (compiles are independent).

### 3.6 The fold-prediction discount model (the B↔A hinge)

`abstractEval(callee, wmod, {mode:'measure', paramFacts})` computes, in one
pass, the exact quantity B's cost model needs:

- seeds ENTRY defs from `paramFacts` (constants for this site's const
  args; read-only params make the seed globally valid; written params get
  the seed as an initial value naturally killed at the first redefine —
  full generality, zero extra code);
- counts `realSurviving`: real (non-WSrcLoc) nodes that survive folding —
  const chains collapse to 1 (`i32.const`), untaken `WIf` arms and
  non-selected `WBrTable` targets contribute 0 (structured dispatch
  collapse — the SameBoy memory-region case), `WLocalGet`s of folded
  locals contribute 0, dead `WLocalSet`s whose uses all folded contribute
  0 (a bounded DCE approximation using the same walk's use counts);
- because rewrite mode and measure mode are the same interpreter, the
  discount is not a heuristic guess at what A "should" do — it is a dry
  run of what A **will** do to the spliced clone.

Predicted-vs-actual drift is telemetry (`passStats.inline.predictErr`
histogram): the deliberate check that the model stays honest.

## 4. Item A — the WAST simplification pipeline

### 4.1 Passes

All passes are per-function, rebuild-out, re-validate on change, refuse
nothing silently (barriers are local, telemetry per pass in `passStats`).
Order within one simplify round:

1. **precompute / const-prop** — `abstractEval` rewrite mode:
   - const chains fold (`const a; const b; add` → `const a+b`), through
     locals via LocalUse (a `WLocalGet` whose defs are one `WLocalSet`
     fed by a `WConst`, or a read-only param seeded const in B's clones);
   - `WIf` on const cond: delete the cond producer, keep the taken arm.
     Label identity is preserved by replacing the `WIf` with a `WBlock`
     of the same bt and **remapping arm-internal branches that target
     the WIf to the new WBlock** (the `cloneInlineBody` map mechanism);
   - `WBrIf` on const: 0 → delete (with producer); 1 → `WBr` (fall
     through to DCE);
   - `WBrTable` on const index → `WBr` to the selected target;
   - **trap preservation is absolute**: never fold a trapping op into its
     would-be trap (i32/i64 div/rem with const 0 divisor, INT_MIN/−1;
     trunc of out-of-range const float) — leave the op in place, exactly
     the `ConstEval.convert` decline-don't-saturate stance. Float folds
     use Math.fround for f32 and (v1) refuse NaN-producing folds
     (§10 Q6).
2. **DCE** —
   - unreachable-code sweep: after an unconditional `WBr`/`WReturn`/
     `WUnreachable`/`WThrow*`, delete to the matching `WElse`/`WEnd`;
   - dead stores: a `WLocalSet` with zero uses (LocalUse) becomes `WDrop`
     (the value producer may trap or have effects — never deleted here);
     a `WLocalTee` with zero uses becomes nothing (value stays on stack);
   - drop-of-pure peephole: `pure-producer-range + WDrop` deletes both
     (purity = const/local.get/global.get/pure Aop chains; loads are NOT
     pure — OOB traps);
   - empty-construct sweep: `WBlock/WLoop + WEnd` with no branches
     targeting them, `WNop`.
3. **local CSE** — bounded, window-based (Binaryen LocalCSE-shaped):
   hash pure producer ranges (via the shadow stack's producerRange);
   a repeat within the same window with (a) no redefinition of any local
   the range reads (LocalUse.writtenLocals + position check) and (b) for
   ranges containing loads, no intervening store/`WCall`/`WCallIndirect`/
   `WMemoryCopy`/`WMemoryFill`/`WMemoryGrow`/`WRaw`/`WGlobalSet` (calls
   may write memory and globals — full barrier), rewrites: first
   occurrence tees into a fresh local (`pushLocalRLE`), repeat becomes
   `WLocalGet`. localCap guard applies (the 0209 engine limit).
4. **peephole** — the grab-bag with `foldMemOffsets` **subsumed as its
   first member** (identical fold, one home; the standalone pass is
   deleted from `runPasses` — §10 Q4): const+add→displacement,
   `eqz;eqz;br_if`→`br_if`-inverted-free forms (`eqz` pairs), `tee;get`
   of the same idx → `tee` reuse, `set;get` same idx → `tee`, double
   drop merges, etc. Grows by evidence (instruction-frequency census on
   the bench module), not speculation.

`WSrcLoc` is transparent to all matching and preserved in place; a deleted
region's markers die with it and attribution falls back to the previous
surviving marker — the flat offset→line format's semantics (0201's
call-site-attribution precedent; `tests/sourcemap/line_numbers` stays the
pin).

### 4.2 Driver + defaults

```js
const simplifyDefaults = {
  enabled: true,
  rounds: 2,        // per-function pass-list repeats within one simplify() call
                    // (round 2 catches precompute work exposed by DCE/CSE;
                    //  measured, not assumed — bump only with bench evidence)
};
function simplifyFunctions(wmod, optsIn) -> stats   // per-pass counters
```

`runPasses` (Item A landing, pre-B): `inline → shake → simplify` (simplify
replaces the standalone foldMemOffsets loop). Telemetry mirrors to
`WAST.lastPassStats` as today.

### 4.3 Item A oracle

- **Off = byte-identical**: `simplifyDefaults.enabled = false` must
  reproduce today's bytes exactly (minus the foldMemOffsets relocation —
  gated by keeping the fold as peephole member #1 and comparing against
  a pre-change build in the landing gate). Every pass independently
  toggleable for bisection.
- **On**: the SameBoy framebuffer-checksum interlock (all N, cc ≡ clang ≡
  `baselines.json`) — the primary miscompile tripwire; then the full
  estate via `node tests/run.js --diff` → effectively `all` (compiler.js
  maps to everything): unit+conformance, ast (new
  `tests/ast/test_wast_analysis.js` + `test_wast_simplify.js` pinning
  every pass mechanic, every barrier, trap-preservation refusals, the
  loop gen-set widening), run.py, blockfs, kernel (full image bake — every
  seeded binary through the pipeline), browser sweep. Image version bump
  (compiler.js changes every baked binary — the 0201 precedent).
- Size/compile-time ledger per vendor (the 0188 table format) committed in
  the close-out log. A is allowed to be perf-FLAT (V8 folds much of this
  itself — the 0198 offset-fold lesson); its value is (a) module size and
  (b) being B's substrate. No perf claim is made for A.

## 5. Item B — the specialization-aware inliner

### 5.1 What survives from 0201 unchanged

Tarjan callee-before-caller order; the splice mechanism (arg drain,
wrapper block, label-identity clone, fresh instances, live site counts);
ALL soundness refusals (imported, noBody, variadic, alloca, overAligned,
structRet, eh, raw, multiResult); `localCap`; `noinline` hard refusal;
`alwaysInline` budget bypass; single-use bypass; tree-shake afterward.
The AST-level expression inliner (0188) also stays — it feeds per-TU
shaking and is upstream of codegen; B is WAST-level only.

### 5.2 Per-site simulation replaces the blanket size caps

At each eligible `WCall` site, the caller walk already runs under
`abstractEval` (the caller's own facts are live), so the site knows which
argument stack slots are CONST — including constants that became known
because *this caller was itself specialized earlier in the round* (the
bottom-up compounding clang gets). Then:

```
argFacts  = per-param {wt, value} | null            // from the caller's shadow stack
roParams  = readOnlyParams(callee)                   // fast path annotation
m         = abstractEval(callee, {mode:'measure', paramFacts: argFacts})
specSize  = m.realSurviving                          // predicted post-A real nodes
```

Decision (replaces the `budgetCallee`/`budgetCaller` block):

```
w         = siteWeight(site)                 // §5.3: hot ≥ 1, cold < 1
inline iff  specSize            <= specCap * w
        &&  callerPredicted + specSize <= hotCallerCap      // §5.4, the V8 budget
        &&  localCount checks pass                          // unchanged (0209)
        &&  historyDepth(site, callee) <= depthCap          // §5.5
```

`callerPredicted` is the caller's own running predicted-post-A size (start:
its measure-mode count; each accepted splice adds `specSize`, not
`scan.real`). Worked example — the design's acceptance shape:
`GB_read_memory` (~397 real nodes) at a `cycle_read`-inlined site where
the address class folded to a constant → the region dispatch collapses,
`specSize ≈ 30` → passes a `specCap` of 64 that the raw 397 failed 863
times. No cap was raised; the *measure* changed.

New defaults (all in `inlineDefaults`, tunable as today):

```js
specCap: 64,          // predicted-post-A nodes per site (same spirit as calleeCap)
hotSiteWeight: 4,     // w for hot sites  → up to 256 predicted nodes
coldSiteWeight: 0.25, // w for cold sites → 16
hotCallerCap: TBD,    // §5.4 — the V8-cliff calibration output
moduleGrowthCap: 1.5, // total real nodes ≤ 1.5× pre-inline module (global fuse)
depthCap: 1,          // §5.5
maxRounds: 3,         // §5.6
```

`calleeCap`/`hintCalleeCap` are retired; `inlineHint` becomes a weight
bump (×2) instead of a second cap — one model, biased, not two models.

### 5.3 Hot/cold site weighting

No profile exists; v1 signals, in priority order:

1. **`__attribute__((hot))`/`((cold))`** — already recognized by the
   attribute parser (compiler.js:10189) but currently dropped at 10284;
   thread them through `fnAttrs` → `fnMeta.hot/cold` (the same trivial
   plumbing 0214 used for noinline). A cold CALLEE also self-discounts
   (`GB_log`, `__assert_fail` class).
2. **Loop depth at the call site** — free from the walk's control stack:
   count enclosing `WLoop`s. depth ≥ 1 → hot; deeper compounds mildly
   (cap the multiplier — depth is a proxy, not a count).
3. **Callee cold-path inference** — a site inside a `WIf` arm whose
   sibling ends in `WUnreachable`/`WThrow` (assert/abort shape) → cold.

Profile-guided weighting (bench-instrumented counters) is a recorded
follow-on, not v1 (§10 Q2).

### 5.4 The V8-cliff caller budget — our tuning problem, stated honestly

The key difference from clang: our size threshold is **not native code
size** — it is V8's optimizing-tier behavior on one hot wasm function.
Overshoot and V8's top tier compiles the merged function worse (regalloc
degradation, superlinear compile time) or later (tier-up latency) — the
0201-warned regression where inlining more makes the program SLOWER.
There is no documented V8 constant to read this from; the cliff is
**empirical and machine/version-dependent**, so calibration is part of the
deliverable, not a magic number in the diff:

- `tests/bench/run.js --sweep=hotCallerCap=2000,4000,8000,16000,32000` —
  one build+bench per value, reporting (a) the slope ms/frame (steady
  state, tier-up cancelled — the existing metric) and (b) a NEW
  early-window metric (total wall of the first 200 frames) that *exposes*
  tier-up cost instead of cancelling it.
- Choose the knee; commit the sweep table + chosen default to
  `tests/bench/README.md` with the V8/Node version stamped. Recalibration
  is a documented one-command re-run whenever Node majors bump.
- `hotCallerCap` is expressed in predicted-post-A real nodes (≈ static
  instrs, the unit `passStats` already reports), so the budget and the
  telemetry speak the same unit.

### 5.5 Bounded recursion — inline history replaces the self refusal

0201 refuses only `caller == callee` and never re-scans spliced content.
B needs both relaxed (the hot SCC *is* recursive, and re-scanning is what
lets specialized constants flow into second-level splices):

- Every spliced clone's `WCall` nodes carry `inlineHist`: the chain of
  callee def-indices inlined to produce them (parent hist + this callee;
  original call sites have empty hist). Cloning cost: one shared frozen
  array per splice.
- Refusal: callee appears in the site's `inlineHist` more than `depthCap`
  times. `depthCap 1` = a function may be entered once per chain — direct
  self-splice of `f` inside `f` is allowed ONCE (peeling one level:
  `GB_advance_cycles`' unlikely speed-switch self-call), then refused.
  Mutual recursion (`cycle_read → … → cycle_read`) terminates identically:
  the second appearance of any member in one chain stops that chain.
- Termination proof shape: each splice strictly grows the finite
  hist-multiset bounded by `depthCap × #functions`; combined with
  `moduleGrowthCap` (a hard global fuse) and `maxRounds`, non-termination
  is structurally impossible.

### 5.6 Round structure — re-simplify between rounds

`runPasses` becomes a bounded fixpoint driver (the clang shape):

```
repeat up to maxRounds, stop early when a round inlines 0 sites:
  inlineFunctions(wmod)      // specialization-aware, Tarjan order,
                             // re-scans previously spliced content (hist-bounded)
  treeShakeFunctions(wmod)   // delete stranded bodies + remap (unchanged)
  simplifyFunctions(wmod)    // Item A — ONLY functions whose wast identity
                             // changed this round (cache key = §3.5)
```

Round 1 ≈ today + specialization; round 2 is where the compounding lives:
`cycle_read` spliced into `GB_cpu_run` exposes const address classes →
`GB_read_memory` sites inside the splice now measure at `specSize ≈ 30` →
inline → simplify collapses the dispatch for real. The per-round simplify
is what keeps `callerPredicted` honest between rounds.

### 5.7 Item B oracles

1. **Perf**: `tests/bench/run.js` — the 5.4x is the target; any landing
   reports slope + early-window numbers vs the 0186 baseline, and the
   sweep table (§5.4). A tier-up regression (early-window worse while
   slope improves, or slope worse at higher caps) is a FINDING to report,
   never silently absorbed by lowering the cap without recording why.
2. **Correctness**: the checksum interlock (all N, all reps, cc ≡ clang ≡
   baselines) + the full estate + image bake + browser sweep — identical
   to 0201's gate. `passStats.inline.predictErr` sanity-checks the model.
3. **Size**: `moduleGrowthCap` ledger per vendor (0188 table format);
   busybox/sqlite are the size canaries (many cold sites — the cold
   weight must hold them near-flat).

## 6. Sequencing

1. **A lands first, alone**: analysis layer + pipeline + tests + the
   off-switch byte-identity check + full gate. No perf claim. Its own
   queue item.
2. **B lands second**: fnMeta hot/cold plumbing, the simulate/specialize
   cost model, hist recursion, round driver, the calibration sweep +
   committed default, full gate + bench. Its own queue item, hard-dep on
   A (`--blocked-by`).

Why strictly A-then-B (not one landing): B's cost model is meaningless
without A (specSize predicts a cleanup that must exist, or every splice
ships its dead dispatch to V8 — the exact regression this design
exists to avoid); and A's byte-identity/off-switch oracle is only clean
while the inliner around it is unchanged. Two gates, two bisectable
landings, one design.

## 7. Risks

- **Compile-time.** The analysis is O(nodes) per function per round with
  small constants, but sqlite (1.29 MB wasm) and the in-OS `/bin/cc`
  (browser UX) will feel careless growth. Mitigations: on-demand +
  identity-keyed caching (§3.5), single-pass reaching-defs (§3.4), bounded
  rounds, CSE window caps. Budget: per-vendor compile wall in the ledger;
  regression target < +25% (§10 Q1 for the real number).
- **New miscompile surface.** Stack-slice reconstruction (producerRange)
  is the dangerous new machinery. Defenses, layered: `validate()` after
  every rewrite; the fresh-instance rule; trap-preservation refusals;
  per-pass toggles; the checksum interlock; the conformance corpus as a
  differential suite (passes on vs off); and a NEW model-based fuzzer in
  the `test_fuzz.js` tradition — random small WAST bodies, execute
  pre/post-pipeline in a real engine, compare results (recommended in-A
  deliverable, not optional).
- **V8 cliff nonstationarity.** The calibrated cap is machine/V8-version
  specific. Mitigations: conservative default from the knee's low side,
  the one-command recalibration, version-stamped table.
- **Hot callees refused for WRaw.** 0201 counted 80 `raw` refusals; if a
  hot SCC member carries `__wasm` bytes, specialization can't reach it.
  Pre-B audit deliverable: name the raw-refused functions on the bench
  module. If hot ones appear, the recorded extension is teaching the
  `__wasm` parser to record local-index sites for relocation (lifting the
  refusal) — separate item, not silently folded into B.
- **CSE vs memory model.** All loads treat stores/calls/bulk-memory/WRaw
  as full barriers (§4.1.3). gucOS processes are single-threaded over
  private linear memory (SABs are reached via imports, not raw loads), so
  no cross-thread visibility hazard — but the conservative barrier set is
  kept anyway (calls may write anything).
- **Sourcemap fidelity degrades** as more code attributes to call sites —
  accepted 0201 trade-off, extended; the inline-frame sourcemap format
  remains recorded deferred work.
- **Predicted-size drift** (model says 30, reality is 300 → caller blows
  the V8 budget anyway). `predictErr` telemetry + `moduleGrowthCap` as
  the fuse; a persistent large drift is a bug in the shared engine by
  construction (same code both sides) and fails loud in the A tests.

## 8. Deliberately NOT in scope (recorded, not forgotten)

Frame merging across splices (0201 deferral stands); persistent SSA;
profile-guided hotness; inline-frame sourcemaps; global (cross-function)
CSE/GVN; scheduling/regalloc-shaped transforms (V8's job); WRaw local
relocation (conditional follow-on, §7); a second bench workload
(doom/quake timedemo — 0186 deferral stands, harness takes it without
redesign).

## 9. Open questions for jku

1. **Compile-time budget**: is < +25% wall per vendor build (and in-OS
   `/bin/cc` feel) the right ceiling for A+B together, or tighter?
2. **Hotness v1**: attributes + loop depth + cold-sibling inference
   (§5.3) enough, or do you want the bench-counter profile hook designed
   into A now (it touches the engine's walk)?
3. **`depthCap` default**: 1 (peel one recursion level, §5.5) or 0
   (keep 0201's no-self rule until the sweep proves peeling pays)?
4. **foldMemOffsets**: fold into peephole member #1 immediately (one
   home, §4.1.4) — or keep the standalone pass one release for
   bisection comfort and delete in B's landing?
5. **Float NaN folds**: v1 refuses NaN-producing const folds (§4.1.1) —
   acceptable, or do you want bit-exact NaN folding (wasm permits any
   payload, so folding is spec-legal but observable via reinterpret)?
6. **Fuzzer scope**: the WAST-level differential fuzzer (§7) — in-A
   acceptance criterion (my recommendation) or its own queue item?
7. **Calibration numbers in-repo**: OK to commit the mac-mini
   V8-cliff sweep table to `tests/bench/README.md` as the reference
   (with version stamp), knowing other machines will differ?
8. **Module growth**: is 1.5× (`moduleGrowthCap`) an acceptable size
   ceiling for the OS image binaries, given OPFS/fetch cost — or should
   size-sensitive builds (image bake) run a tighter profile via
   compiler options?
