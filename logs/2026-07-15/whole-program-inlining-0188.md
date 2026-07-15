# Stage A: whole-program inlining by post-link pass placement (todos/0188)

## What landed

`INLINER.optimizeLinked(units)` — an ADDITIVE whole-program inline+fold
round invoked at the end of `linkTranslationUnits` (error-free links,
gated on `--no-fold`), after `decl.definition` is wired across TUs.
`tryInline`'s existing `decl.definition || decl` then resolves cross-TU
callee bodies with **zero change to the inlining rule** (single
`return EXPR;`, UNRESTRICTED body + args). The per-TU pass stays (it
feeds per-TU tree-shaking). Placed inside the linker so every driver —
CLI, in-OS `/bin/cc` (os-common.js), tests — gets it uniformly.

- **Callee-before-caller order**: iterative post-order DFS over the call
  graph (edges = the body bag's `referencedFunctions`, already
  canonicalized through `.definition`; cycles broken by the visited
  set). A callee whose body only becomes single-return after its own
  folds (ternary over an inlinable cross-TU call, `if (1) ...`) is
  folded before its callers try to inline it — pinned by an ast test.
- **Bounded-expansion guard**: budget on GROWTH per call site — the
  substituted expression may exceed the argument material already at
  the site by at most `INLINE_GROWTH_CAP` (64) EFFECTIVE nodes
  (shared substituted subtrees counted per occurrence, which is what
  the tree-walking codegen emits — and what bounds fold/codegen time
  against the `sq(sq(sq(x)))` multiplicative class). Single-use params
  inline regardless of arg size (no duplication = pure win);
  duplicating large args refuses. `effSize` early-exits at the cap, and
  the per-arg scan is ceilinged (4096) so the check itself stays cheap
  on DAG-shared trees. Recursion stack now keyed on the canonical def
  (cross-TU decl aliases of one function can't slip past).
- **Instrumentation**: `INLINER.stats` — inlines + budget refusals,
  post-link share snapshotted into `stats.postLink`.
- Liveness untouched: no tree-shake in the new round; bags recompute
  from current children, `gcSectionsPass` reaps as before.

Tests: 4 new ast tests (cross-TU inline, callee-before-caller ordering,
budget refusal counted, single-use-param exemption).

## The honest headline: NO measurable SameBoy speedup

| | baseline (0186) | after 0188 |
|---|---|---|
| cc ms/frame | 5.697 | 6.044 / 6.500 (two runs) |
| clang ms/frame (identical binary!) | 1.049 | 1.104 / 1.161 |
| ratio | 5.43x | 5.48x / 5.60x |
| wasm bytes | 281051 | 283815 (+0.98%) |
| static instrs | 120084 | 121728 (+1.37%) |

The clang lane — an **unchanged binary** — drifted +5%/+11% across the
two runs (machine under concurrent-agent load), so the wall numbers are
noise-dominated; ratio-normalized, cc is flat to ~+2%. **Framebuffer
checksums identical to baselines.json at every N and every rep, and cc
vs clang agree — the correctness interlock passes.** But there is no
real ms/frame drop.

### Why: the rule is now the binding constraint, not visibility

Instrumentation on the sameboy bench build: per-TU passes inline 109
sites; the post-link round adds **137 more** (246 total), **0 budget
refusals**, +16ms link time. So the placement works — but the census's
~1163 "callee body not visible" refusals mostly became refusals on the
RULE once the body was visible. Top surviving direct-call sites:

```
GB_get_thread_id 76   (cold; body is `return &errno` — OP_ADDR, not UNRESTRICTED)
GB_log 76  memcpy 70  __assert_fail 58  cycle_read 58  GB_random 44
GB_advance_cycles 39  memset 38  GB_write_memory 37  cycle_write 29
```

The hot path — `cycle_read` / `cycle_write` / `GB_advance_cycles` /
`GB_write_memory` — is multi-statement, side-effecting code the
single-return-expression rule can never touch, from any TU. The 137 new
inlines are cold helpers. **Stage A removed the visibility refusal; the
speedup the census pointed at requires Stage C (statement-position /
whole-body inlining).** Whole-program placement, ordering, and the
expansion budget are exactly the substrate Stage C needs, so this lands
as that substrate — with the perf claim explicitly NOT made.

## Cost (bounded, as gated)

Per-vendor wasm size and compile wall-time (before → after):

```
doom    478836 → 479378  (+0.11%)     ~1.09s → 1.09s
quake   456227 → 456211  (-16 B)      ~1.10s → 1.12s
busybox 228430 → 231902  (+1.51%)     ~1.73s → 1.73s
lua     257870 → 260286  (+0.93%)     ~1.07s → 1.09s
sqlite  1287425 → 1292420 (+0.38%)    ~1.92s → 1.97s
sameboy 299113 → 301876  (+0.92%)     ~0.58s → 0.60s
```

Growth is inlined-expression duplication at sites whose callee stays
live (extern linkage, no `--gc-sections` in these builds). Budget
refusals across the whole vendor estate: 0 — the cap never bit a real
program; it exists for the pathological class.

## Gates

- bench checksums: UNCHANGED vs baselines.json (all N, all reps, cc ≡ clang)
- unit: 715 passed, 0 failed (conformance included)
- ast: 139 passed, 0 failed (4 new)
- blockfs: green (89.8s)
- kernel: 73 passed, 0 failed (566.9s, fresh whole-vendor image bake —
  the real differential test: every seeded binary rebuilt with
  whole-program inlining and the e2e estate holds)
