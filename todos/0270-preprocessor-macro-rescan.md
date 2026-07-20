# 0270 — compiler.js preprocessor: function-like macro name from inner expansion not re-scanned when its args come from the same replacement list

- **Status**: open
- **Design**: —

## Goal

Fix a compiler.js preprocessor correctness bug surfaced by the jq vendor
(`vendor/jq`, merged 322147e). Filed **P0** per the repo policy (any bug found
anywhere is P0) + the standing "always do bug fixes first" rule.

**The bug:** a function-like macro NAME produced by an inner macro expansion is
NOT re-scanned / re-expanded when its `( … )` argument list comes from the SAME
replacement list. Standard C (C11 6.10.3.4) requires the fully-expanded
replacement list to be rescanned for further macro names, including function-like
invocations formed during that expansion.

**Where it bit:** jq's variadic argument-count dispatch idiom
(`JV_ARRAY` / `BLOCK` / `JV_OBJECT` in `vendor/jq/src` headers), where a
count-selector macro expands to a target macro name and the arg list is glued in
the same replacement list. Worked around locally with an `EXPAND()` wrap in the
jq headers — a per-port shortcut we do NOT want to keep shipping.

**Reference:** the jq port dev log `logs/2026-07-20/vendor-jq.md` +
`vendor/jq/README.md` port-gotcha table; the reusable port-gotcha memory the jq
thread saved. Reproduce minimally with the split-selector/call + variadic
arg-count pattern (the `A(...)` → `SELECT(__VA_ARGS__)` → `A_N(...)` shape).

## Plan

- Minimal standalone repro: the smallest `#define` set that miscompiles under
  compiler.js and expands correctly under clang (the oracle).
- Fix the rescan in compiler.js's preprocessor so a function-like macro name
  emitted by an inner expansion IS re-scanned when its `()` args come from the
  same replacement list — at the right generality (not special-casing jq's
  idiom).
- **compiler.js-touch mandate:** run the SameBoy byte-identity gate (SameBoy does
  not use these idioms, so it should stay byte-identical — verify).

## Acceptance

- A `tests/unit/conformance/` regression entry: the variadic arg-count /
  split-selector pattern expands correctly (matches clang), failing before the
  fix and passing after.
- jq's local `EXPAND()` workaround can be removed and jq still builds + passes
  its corpus (confirm the workaround is no longer needed; removing it is
  optional cleanup, but the repro must be idiom-general).
- **Sequencing:** land BEFORE the C++ ladder T2 (ETL) rung — heavy variadic-
  template + macro TMP (T2 ETL, T6 fmt/exprtk/CTRE) will hit the same limit.
