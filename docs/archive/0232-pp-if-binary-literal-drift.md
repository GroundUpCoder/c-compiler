# 0232 — #if rejects 0b binary literals — dedupe the diverged #if integer decoder

- **Status**: done (2026-07-17) — 0a94216; one decodeIntegerLiteral shared by lexer + #if evaluator; conformance pin 800a5e8; SameBoy byte-identical
- **Design**: —

## Goal

P0 correctness bug from the code-debt scan (duplication-with-drift): the
compiler had TWO integer-literal decoders — the lexer's PP_NUMBER→INT
resolution (postProcess) and a diverged private copy inside
`ConstEval.itemFromPPNumber` serving the `#if` constant-expression
evaluator. The #if copy never learned 0b/0B binary literals, so
`int x = 0b1;` compiled while `#if 0b1` died with
`invalid integer constant '0b1' in preprocessor expression`. Oracle:
clang and gcc accept 0b in #if (C23 / GNU extension) — and this compiler
already accepts it everywhere else, so #if must agree.

## Plan

Unify, don't patch: extract ONE `decodeIntegerLiteral(text)` (suffix strip
u/U/l/L → hex / binary / octal / decimal dispatch → `{value, unsigned,
decimal}` or null on malformed) in the Lexer module, exported; both the
lexer INT resolution and `itemFromPPNumber` funnel through it so the two
contexts can never drift again. Keep the 0218 #if-intmax typing rule
(intmax_t/uintmax_t, unsigned-suffix or doesn't-fit-intmax escalation)
in itemFromPPNumber — it's #if-specific policy, not decoding.

## Acceptance

- `#if 0b1` selects the true branch; suffixed (`0b101u`, `0b110UL`,
  `0b111ull`), 64-bit binary constants, and arithmetic over them all agree
  with clang; malformed forms (`0b2`, `08`) still rejected in BOTH contexts.
- Regression test `tests/unit/conformance/pp_if_binary_literal/`
  (clang-verified golden, #if + normal-code parity line).
- `node tests/run.js unit ast` green, xfail counts preserved; SameBoy
  A/B build byte-identical (pure front-end — no codegen change, no bake).
