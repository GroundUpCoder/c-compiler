# 0188 — Stage A: whole-program inlining by post-link pass placement

- **Status**: done (2026-07-15; post-link INLINER.optimizeLinked landed — cross-TU inlining under the unchanged rule, callee-before-caller order, 64-effective-node growth budget + stats. Checksums unchanged, full corpus green. HEADLINE NOT MET: no measurable SameBoy ms/frame drop (+137 inlines are all cold — the hot path is multi-statement, rule-bound not visibility-bound; Stage C is where the win is). Log: logs/2026-07-15/whole-program-inlining-0188.md)
- **Design**: logs/2026-07-15/compiler-perf-bench-0186.md (baseline), todos/OS.md (north star)

## Goal

Make inlining WHOLE-PROGRAM by pass placement only — no new rewrite
machinery, no whole-body inlining (that's Stage C). The per-TU
INLINER.optimize (compiler.js ~5300s) runs before linkTranslationUnits
(~8860s) wires `decl.definition` across TUs, so cross-TU callee bodies are
structurally invisible at inline time — the dominant refusal in a census
(~2822 sites in doom, ~1163 in sameboy: "callee body not visible"). All
TUs are in memory simultaneously and codegen is already whole-program, so
an ADDITIVE inline+fold round after linking makes inlining whole-program
with zero change to the linking model.

## Plan

1. `INLINER.optimizeLinked(units)`: post-link inline+fold round over every
   canonical (body-bearing) definition. `tryInline`'s existing
   `decl.definition || decl` resolves cross-TU bodies once the linker has
   run — the rule itself is unchanged (single-`return EXPR;`, UNRESTRICTED
   body + args). Invoked at the end of linkTranslationUnits (error-free
   links only, gated on `--no-fold` like the per-TU pass) so every driver
   — CLI, in-OS cc, tests — gets it uniformly. The per-TU pass stays (it
   feeds per-TU tree-shaking and keeps link inputs small).
2. Callee-before-caller order: iterative post-order DFS over the call
   graph (edges = the body bag's referencedFunctions, canonicalized;
   cycles broken by the visited set), so a callee whose body only becomes
   single-return after its own folds (e.g. a ternary on an inlinable
   cross-TU call) is folded before its callers try to inline it.
3. Bounded-expansion guard: substitution duplicates each argument once per
   parameter use and foldExpr re-folds substituted bodies, so nested pure
   helpers compound. Budget = GROWTH per call site: the substituted
   expression may exceed the argument material already at the site by at
   most INLINE_GROWTH_CAP (64) EFFECTIVE nodes (shared subtrees counted
   per occurrence — that's what the tree-walking codegen emits). A
   single-use param inlines regardless of arg size; duplicating large args
   refuses. `INLINER.stats` counts inlines + budget refusals (postLink
   share snapshotted separately). Recursion stack keyed on the canonical
   def (cross-TU decl aliases can't slip past).

## Acceptance

- Correctness: tests/bench framebuffer checksums UNCHANGED vs
  baselines.json (a changed checksum is a miscompile); cc-vs-clang sums
  agree; full corpus green (unit incl. conformance, ast, blockfs, kernel
  with fresh image bake).
- Liveness/exports preserved: referencedFunctions bag + gcSectionsPass
  unchanged; inlining only removes bag references, never definitions.
- Headline: SameBoy bench ms/frame + instrs vs the 5.697 / 120084
  baseline, with inline/refusal instrumentation and code-size numbers in
  the close-out log. (Result recorded there — see the log for the honest
  outcome and the Stage C implication.)
