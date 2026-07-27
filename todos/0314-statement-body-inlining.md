# 0314 — compiler.js: statement-body inlining (tryInline only handles 'return EXPR;' bodies — the measured 5.4x cc-vs-clang gap's highest-value lever)

- **Status**: open
- **Difficulty**: heavy
- **Design**: `todos/INLINER-WAST-PIPELINE-DESIGN.md` — **already on main**
  (commit `cc532651`), with 8 open questions. *(Correction to the source brief,
  which described it as unmerged branch work: it is merged. Verified 2026-07-27.)*
  Background: `~/git/meta/meta/notes/pygame-design-passes-synthesis.md` (pass D).
- **Provenance**: **(decider call)** — surfaced by Fable design pass D
  (2026-07-27) while answering a *clang-lane* question, and queued on its own
  merits. jku never raised this item. It is **not pygame-specific**: it serves
  every app in gucOS.

## Why — this is a measured gap, not a suspected one

`tests/bench` (todos/0186) A/Bs the **identical** SameBoy GBC core under both
toolchains — same ROM, same `host.js`, with a framebuffer-checksum interlock so a
miscompile cannot fake a speedup:

> **cc 5.70 ms/frame vs clang 1.04 ms/frame ~ 5.4x** (281 KB vs 169 KB wasm).

That is a 5x-class gap, not a rounding error. Pass D called statement-body
inlining **"the highest-value lever in the whole conversation."**

**The specific defect (re-verified against HEAD `ae3c7013`, 2026-07-27):**
whole-program *placement* inlining landed and produced **+137 cross-TU inlines on
SameBoy — and moved the bench ZERO**. The reason is `compiler.js:6267`:

```js
function singleReturnBody(body) {
  if (!body) return null;
  if (body instanceof AST.SReturn) return body.expr || null;
  if (body instanceof AST.SCompound &&
      body.statements.length === 1 &&
      body.statements[0] instanceof AST.SReturn) {
    return body.statements[0].expr || null;
  }
  return null;                    // <-- everything else refuses to inline
}
```

`tryInline` (`compiler.js:6286`) calls it at `:6296` and bails on `null`, and even
on success additionally requires `returnExpr.linearity === UNRESTRICTED`. So the
inliner can only ever fold a single-expression accessor — **and every interpreter
hot helper has a statement body.** Placement inlining had nothing to place.

This is why the lever is worth funding ahead of micro-optimisations: the existing
inlining machinery is already wired up and is simply refusing at the front door.

## Plan

1. **Measure before you change anything.** Pass D's recommended cheap first step:
   add `mp_bench.c` to `tests/bench/` (cc-only initially). It turns the open
   numbers here into measurements — including the **never-measured
   `--gc-spill-locals` tax**, which today spills ALL scalar locals.
2. Work through `todos/INLINER-WAST-PIPELINE-DESIGN.md`'s 8 open questions; the
   design predates this evidence, so **re-read it against the bench numbers** and
   record which questions the measurements now answer.
3. Extend inlining to statement bodies. The hard parts are the ones the current
   `UNRESTRICTED`-only rule sidesteps: multiple returns / early return, control
   flow in the body, parameter substitution when arguments have side effects (the
   current code substitutes an argument *multiple times*, which is exactly why it
   demands UNRESTRICTED), and interaction with `--gc-spill-locals` root
   visibility.
4. **Honour `__attribute__((noinline))`** — it is a hard refusal at every inlining
   layer (todos/0214) and must stay one.

## Acceptance

- **A bench delta, or an honest null result.** The whole point of this ticket is
  that the *last* inlining change moved the bench zero while reporting +137
  inlines. **An inline COUNT is not an acceptance criterion.** Report
  `tests/bench` ms/frame before and after, with the framebuffer-checksum interlock
  intact. If the delta is zero, say so — that is a real finding, not a failure to
  hide behind the count.
- Full gate green: kernel + sweep + unit. A codegen change of this class must not
  be trusted on a partial run.
- Every miscompile found on the way filed as its own ticket with a reduced repro.
- Runners-up pass D named — constant-offset folding into load/store immediates
  (interpreters are wall-to-wall struct-through-pointer), CSE for repeated address
  expressions, liveness-based `--gc-spill-locals` — should each become their own
  ticket if scoped out here, **not** silently absorbed or dropped.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry the gate goes RED — re-anchor or
  retire it in the same commit. If your work leaves a gap, file a ticket AND a
  register entry.
- Also relevant to the clang lane (**NOT YET, with a trigger** — see pass D): two
  toolchain gaps block a clang-built interpreter today, namely setjmp/longjmp
  being "accepted-unsupported" in the sibling (`wasm/libc/__setjmp.c` is a
  one-line stub) and clang -O2 having the same conservative-GC root-visibility
  failure mode that `--gc-spill-locals` exists to fix, with no clang equivalent.
  Neither gap touches doom/quake/imgui, which is why the clang lane looks more
  finished than it is for interpreter workloads.
