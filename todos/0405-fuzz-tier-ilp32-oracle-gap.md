# 0405 — the fuzz tier has no ILP32 oracle; the width normalization is not guarded

- **Status**: open
- **Design**: —

## Goal

`todos/0404` made the differential fuzz tier sound for one class of divergence.
`tests/run.py` now rewrites every `L`/`UL` integer suffix to `LL`/`ULL` on both
sides. The LP64 native oracle and the ILP32 wasm build therefore read the same
program.

Two gaps stay open. The comment in `tests/run.py` states the first gap
correctly, but no ticket schedules the work. A true comment is not a guard.

**Gap 1 — the tier cannot test ILP32 semantics.**
The oracle is the host `clang`, which is LP64. The target is wasm32, which is
ILP32. A differential test cannot decide any behaviour that depends on the width
of `long`. The normalization removes the false alarms from literal suffixes. It
does not let the tier find a real miscompile in that area.
`tests/unit/conformance/ilp32_long_literal_typing` pins one expression. It does
not cover the class.

**Gap 2 — the completeness of the normalization is an assumption.**
`todos/0404` shows that the suffixes are the complete class of divergence for
the present generator flags. The corpus has no `sizeof`. It has one bare `long`,
which is the unused `__undefined` sink. Nothing enforces these two conditions.
If a person changes `CSMITH_GEN_FLAGS`, or adds a corpus file that uses
`sizeof(long)` or 32-bit `long` arithmetic, the tier fails without a signal. It
then reports a false miscompile, or it hides a true one.

## Plan

1. Audit each open ticket that cites a mismatch or a timeout from a live fuzz
   seed before 2026-07-29. Re-check each one against the normalized tier. Close
   the tickets that the unsound oracle caused. `todos/0404` identified this risk
   but did not do the audit.
2. Add a guard for gap 2. Make the fuzz category refuse a corpus file that has
   `sizeof`, or a bare `long` declaration that is not `__undefined`. Put the
   reason in the failure message. Point the message to this ticket.
3. Evaluate a sound ILP32 oracle for gap 1. Prefer an oracle that runs the
   program. An oracle that only folds constants is not sufficient.
   `clang -target i686-pc-linux-gnu` compiles correctly, but it cannot run on
   this machine, because the machine is arm64 Darwin. A clang build that targets
   `wasm32-wasi`, under a WASI runtime, is ILP32 and it does run. Report the
   cost before you build it.
4. If step 3 is too expensive, say so directly. Record the residual risk in
   `todos/LIABILITIES.md`. Do not leave the gap in a comment only.

## Acceptance

- The audit in step 1 is complete. Each affected ticket records its verdict.
- The fuzz category fails a corpus file that breaks the assumption in gap 2.
  A test proves that the guard operates.
- Step 3 ends in one of two states: a working ILP32 oracle, or a written cost
  and an anchored entry in `todos/LIABILITIES.md`.
