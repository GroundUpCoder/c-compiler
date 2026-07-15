# Bug-hunt regression corpus + xfail mechanism (todos 0189–0196)

2026-07-15. A three-front read-only differential bug hunt (compiler.js vs
clang, findings in `/tmp/cchunt-{frontend,codegen,passes}/FINDINGS.md`)
surfaced 8 confirmed divergences. This lands a **proving regression test per
bug** and files each as an open todo — **no fixes**, per the task.

## The 8 bugs → todo ids → tests

| todo | bug | class | P | test dir (`tests/unit/conformance/`) |
|------|-----|-------|---|--------------------------------------|
| 0189 | F1 | enum bitfield read signed (wrong value) | P1 | `bitfield_enum_signedness/` |
| 0190 | F2 | mixed-type bitfields don't share a unit (ABI) | P1 | `bitfield_mixed_type_unit/` |
| 0191 | F3 | `#pragma pack` silently ignored | P1 | `pragma_pack_layout/` |
| 0192 | C1 | out-of-range decimal const typed signed | P1 | `decimal_oor_const_unsigned/` |
| 0193 | F4 | `1[arr]` commutative subscript rejected | P2 | `subscript_commutative/` |
| 0194 | F5 | `_Alignas(>8)` rejected for statics | P2 | `alignas_over8_static/` |
| 0195 | P2 | `defined` via macro expansion in `#if` | P2 | `pp_defined_via_macro/` |
| 0196 | P1 | `#__VA_ARGS__` drops space before comma | P3 | `pp_stringize_va_comma_space/` |

All 8 expected outputs were re-verified against native clang (Apple clang 21)
before pinning; the values are int-width/pointer-mod based, valid on ILP32.

## Priority calls

The user gave an explicit priority table (which overrides the blanket "any bug
= P0" policy). F1 was left to my call (P0 **or** P1): filed **P1**, matching
F2's classification — the signedness of an enum bit-field is
*implementation-defined* (compiler.js's signed choice is conforming), so it's
an ABI divergence from clang, not a miscompile of well-defined code. C1 is
likewise a silent-wrong-value but on technically ill-formed input → P1. The
rest follow the given table.

## The xfail mechanism (the load-bearing part)

These bugs are unfixed, so a conformance test encoding the CORRECT answer
currently FAILS. Leaving the category red is exactly the fakegit/0183
anti-pattern (a permanently-red suite masks real regressions). So I added a
minimal expected-fail mechanism instead of a stub:

- `tests/run-unit.js` `applyKnownBug()`: a test tagged `config.json`
  `"knownBug":"NNNN"` still compiles + runs + diffs (real proof, recorded in
  the result msg), but a *pinned failure* reports as **`xfail`** — green, not
  counted as a failure. If the test starts PASSING (bug fixed) it reports
  **`xpass`** — a LOUD failure whose message tells the fixer to delete the
  `knownBug` tag, converting the test into a permanent hard-pass regression
  guard. Verified both directions (temporarily flipping an expected value made
  it xpass-fail as designed).
- `tests/run.py` `run_unit_node`: maps `xfail`→skip (green), `xpass`→record
  failure — so the python category consumer stays honest too.
- Documented in CLAUDE.md's "Conformance tests" section.

## Verification (all foreground)

- `node tests/run-unit.js` (full unit corpus): **715 passed, 0 failed, 8
  xfailed, 3 skipped**.
- `python3 tests/run.py --types=unit --filter=conformance`: **75 passed, 0
  failed, 8 skipped** (xfail→skip mapping confirmed).
- `node todos/queue.js check`: OK — 51 open, 143 done.

The 8 todos stay OPEN (they are the future fixes). Each item body carries the
repro, expected-vs-actual, root-cause hypothesis (with line numbers), and a
pointer to its pinned test; each test header comment points back at its
`todos/NNNN` id — cross-linked both ways.
