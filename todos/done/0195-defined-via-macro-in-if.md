# 0195 — defined produced via macro expansion in #if evaluates wrong

- **Status**: done (P2)
- **Design**: this file; found in the 2026-07-15 passes/preprocessor bug hunt (/tmp/cchunt-passes/FINDINGS.md BUG 2)
- **Regression test**: `tests/unit/conformance/pp_defined_via_macro/` (pinned xfail, `config.json` `"knownBug":"0195"`)

## Goal

A `defined` operator produced BY macro expansion inside `#if` evaluates wrong.

Repro:
```c
#define D defined
#define FOO 1
#if D(FOO)
  ... true branch ...
#endif
```
- Expected (gcc AND clang): true — they expand `D`→`defined`, treat it as
  `defined(FOO)` == 1
- Actual (compiler.js): false (evaluates to 0), so it takes the `#else` branch

Severity: P2. Per C11 6.10.1p4 this is strictly UNDEFINED BEHAVIOR, so
compiler.js is technically conforming — but gcc and clang both document +
implement the expansion, so real portable-ish config headers that rely on it
silently take the wrong branch. Filed as a portability trap, not a conformance
defect.

## Plan

Root-cause hypothesis: the `#if` controlling-expression evaluator recognizes
`defined` only as a literal token before macro expansion, then macro-expands the
line — so a `defined` that appears *after* expansion is treated as an ordinary
(undefined→0) identifier. Matching gcc/clang means recognizing `defined`
produced by expansion as the operator (the common implementation: expand, then
scan for `defined` in the expanded token stream before arithmetic evaluation).

## Acceptance

- `tests/unit/conformance/pp_defined_via_macro/` flips from xfail to a hard pass;
  remove its `"knownBug"` tag.
- Ordinary `#if defined(X)` and `#if X` evaluation unchanged.
