# 0336 — CPython startup is 26x clang because V8 spends 2.3 s optimizing ONE of our functions

- **Status**: open
- **Context**: `logs/2026-07-27/0332-dispatch-1000x-rootcause.md` §5
- **Raw**: `tools/bench2x2/results/0332-turbofan-census.txt`,
  `tools/bench2x2/results/0332-cpython-ab-throughput-startup.txt`

## Goal

Find and fix why our emitted wasm is ~41x more expensive for V8's **optimizing
tier** to compile than clang's, per byte of the same function.

This is the residue of `todos/0332`. It is filed **P0** under the standing rule
(a defect found from anywhere is P0 unless the user says otherwise); it is a
performance defect rather than a miscompile, so a demotion is reasonable — but it
should be an explicit call, not a silent one.

## What is established (measured)

`0332` made CPython bytecode **162x** faster and left whole-process startup
**unchanged** — 2.50 s vs the baseline's 2.53 s, against clang's 0.09 s. So the
ticket-0332 claim that "*both* disqualifying numbers are this one defect" is
**refuted**: throughput and startup are two different defects.

The bisection, in order:

- Instrumented `host.js`: `WebAssembly.Instance` 0.8 ms, `main()` 920.8 ms →
  205.5 ms after the 0332 fix, JS-observable total-to-exit **213 ms** — against a
  **2.42 s** process wall. ~2.2 s is after the JS `exit` event, in native teardown.
- `-X importtime` accounts for ~24 ms. `new WebAssembly.Module` (sync) is 1.3 ms.
  Neither is it.
- `node --liftoff-only` (V8's optimizing tier off entirely): baseline **0.95 s**,
  fixed **0.25 s**, clang 0.07 s. The whole gap moves.
- `node --trace-wasm-compilation-times` names it exactly:

| build | TurboFan on the eval loop | bodysize | TurboFan total |
|---|---|---|---|
| ours, baseline | **2341 ms** | 295,002 | 2381 ms over 43 fns |
| ours, 0332-fixed | **2277 ms** | 249,058 | 2274 ms over 43 fns |
| clang | **55 ms** | 90,192 | 63 ms over 33 fns |

V8 spends ~2.28 s optimizing our single lowered `_PyEval_EvalFrameDefault` and
the process blocks at exit waiting for it. **41x clang's compile cost for 2.8x
the bytes — superlinear.**

## Hypothesis — UNTESTED, treat as a suspect

The superlinearity is a property of the loop-switch **shape**: 5752 nested
`block`s, ~2000 locals, one basic block per case, giving TurboFan one function
with thousands of live ranges. clang never builds this shape — LLVM's wasm
backend keeps the natural loop structure and only fixes genuinely irreducible
regions.

This is written by the lane that measured the *symptom*, not the cause. Nobody
has tested it. It is here to be falsified, and a refutation is a result.

## Plan

1. Discriminate cheaply first. `--wasm-tier-up-filter` isolates a single
   function's TurboFan cost; a synthetic module that varies **locals count**,
   **block nesting depth** and **body size** independently says which axis drives
   it, without touching the compiler.
2. If the shape is implicated, the fix is upstream of codegen: a real relooper
   (so far fewer functions need the state machine at all), node-splitting instead
   of whole-function flattening, or cutting the local count the lowering hoists.
3. `--force-dispatch-loop` already exists and forces the lowering on any source,
   so the A/B can be run on a small program.

## Also noted, out of scope here

`~/build/bench2x2/python-ours-v176.wasm` (7,006,275 B, sha `bd83ef09…`) is **not
byte-reproducible** from `ccjs-build.sh` today: an unmodified-compiler rebuild
gives 7,163,772 B, differing only in the **data** section (+157,497 B). The
0332 A/B was run against a same-day rebuilt baseline for that reason. Whoever
re-runs `tools/bench2x2/verify.sh` should re-pin the artifact rather than trust
the committed sha.

## Acceptance

- The axis that drives TurboFan's cost NAMED, with the discriminating measurement.
- CPython `-c pass` startup on default V8 flags within a **stated multiple** of
  clang's 0.09 s.
- No regression on the estate.
