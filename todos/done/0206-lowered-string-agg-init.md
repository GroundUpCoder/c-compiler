# 0206 — string-literal aggregate init miscompiles under IRREDUCIBLE_LOWERING

- **Status**: done (2026-07-16) — brace-wrapped EString recognized as whole-array fill + element-sized LE decode in the per-element store loop (emitAggregateInitAssigns); conformance test lowered_string_agg_init (--force-dispatch-loop via compilerArgs); array_brace_string_init + char16_char32 green under forced lowering; full gate green
- **Design**: compiler.js emitAggregateInitAssigns (the IRREDUCIBLE_LOWERING decl-hoist rewrite), CLAUDE.md "Conformance tests"

## Goal

Two same-root miscompiles in lowered functions (hunt items G4+G5):
- `char B[] = {"brace"};` stored the literal's ADDRESS low byte to B[0]
  (the brace-wrapped EString fell to the scalar-leaf fallback as
  `B[0] = <string>`), flipping tests/unit/core/array_brace_string_init
  under --force-dispatch-loop.
- `char16_t W[] = u"XY"` yielded {88,0,89} not {88,89,0}: the per-element
  store loop indexed the literal's little-endian BYTES by element index.
  Flipped tests/unit/core/char16_char32 under --force-dispatch-loop.

## Plan

In emitAggregateInitAssigns: (1) recognize the
EInitList{char[N],[EString]} shape normalizeInitList deliberately keeps
(C11 6.7.9p14 brace-wrapped string) and recurse the string as the WHOLE
array's initializer; (2) decode element-sized little-endian units in the
EString per-element store loop. Conformance test
`lowered_string_agg_init` pins both via config compilerArgs
--force-dispatch-loop.

## Acceptance

- New conformance test fails before, passes after; array_brace_string_init
  + char16_char32 pass under --force-dispatch-loop.
- Full estate green.
