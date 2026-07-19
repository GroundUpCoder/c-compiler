# 0269 — Nondeterministic wasm output: one function-table slot drifts run-to-run

- **Status**: open
- **Design**: —

## Goal

Identical inputs must produce byte-identical wasm. Found during the Unicode
Phase B SameBoy byte-identity gate (2026-07-19, logs/2026-07-19/
gucos-unicode-phaseB.md): building `vendor/sameboy/bin.json` via
`os-common.js buildProject` with the SAME compiler.js (main @ 7d04f1d,
untouched) produced TWO different 662546-byte outputs across 7 runs —
one outlier (`f3022c70…`), six agreeing (`04eccc9e…`).

The delta is exactly ONE function-table slot: the outlier's table is one
slot SMALLER (table limits 2523 vs 2524), a low slot (< fp 91) is absent,
and every baked function pointer above it shifts by 1 (elem offsets, ~289
data-segment fp constants — SameBoy's dispatch tables — and 15 code-side
`i32.const` fps). Code/function/type/import sections are otherwise
byte-identical, so this is slot ALLOCATION drift, not a codegen diff.

## Plan

- Find the table-slot allocation site whose order/count can vary run-to-run
  with identical inputs. Prime suspect classes: a recursion-depth fallback
  (V8 stack budget varies per-process with ASLR — a caught
  "Maximum call stack size" changing a path), or an iteration over a
  structure whose order isn't insertion-stable.
- Make slot assignment a pure function of the input program.
- Repro harness: loop `buildProject(sameboy)` N times in fresh processes,
  compare SHA-256s (the outlier appeared 1-in-7 on 2026-07-19).

## Acceptance

- N (≥ 50) fresh-process SameBoy builds produce one SHA.
- The A/B byte-identity gate (compiler.js-touch mandate) is trustworthy
  without needing a same-process rebuild baseline.
