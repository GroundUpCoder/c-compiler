# \#if vs lexer integer-literal drift: 0b rejected in #if (todos/0232)

## The bug

`int x = 0b1;` compiled; `#if 0b1` errored with `invalid integer constant
'0b1' in preprocessor expression`. Classic duplication-with-drift (flagged
by the code-debt scan): two integer-literal decoders — the lexer's
PP_NUMBER→INT resolution in `postProcess` (knows 0x / 0b / octal /
decimal) and a private copy inside `ConstEval.itemFromPPNumber` serving
the #if evaluator (knows 0x / octal / decimal — 0b was added to the lexer
at some point and the #if copy never followed). Oracle: clang and gcc
both accept 0b in #if (C23 / GNU extension); a compiler that accepts a
form in expressions must accept it in #if.

## The fix — unify, not patch

One new `decodeIntegerLiteral(text)` in the Lexer module (exported):
strips the u/U/l/L suffix tail (recording unsignedness), then dispatches
hex / binary (BigInt parses `0b…` natively) / leading-0 octal (via
`"0o"+rest`, so `08` throws → null) / decimal, returning
`{value, unsigned, decimal}` or null for malformed. Both call sites now
funnel through it:

- the lexer INT branch keeps its LexError on null and its
  `flags.isDecimal` (drives the 6.4.4.1 type progression);
- `itemFromPPNumber` keeps only the #if-specific POLICY: C11 6.10.1p4
  intmax_t/uintmax_t typing (unsigned suffix or doesn't-fit-intmax →
  uintmax_t) — the 0218 intmax work is untouched, decoding is shared.

They can't drift again because there is nothing left to drift.

Deliberately preserved quirks (parity, not new strictness): the suffix
strip is loose in both contexts (`1lul` was accepted by both before and
still is); `0` stays non-decimal (octal per grammar — value 0 types
identically either way).

## Verification

- Before/after repro: `#if 0b1` error → compiles; normal-code `0b101`
  fine in both.
- Battery vs clang: `0b1`, `0b1010==10`, `0B11u`, `0b101ull`, 64-bit
  `0b111…1u == 0xFFFFFFFFFFFFFFFFu`, shifts/negation over 0b, printf
  parity — our wasm output byte-equal to the clang binary's.
- Negative parity: `0b2` and `08` still rejected in BOTH #if and normal
  code (clang agrees).
- Regression test `tests/unit/conformance/pp_if_binary_literal/`
  (clang-verified golden).

## Gating decision

Pure front-end (preprocessor + lexer decode share): `node tests/run.js
unit ast` — unit 757 passed / 0 failed / 8 xfailed (count preserved),
ast green. No codegen path moved, so per the 0218/0225
preprocessor-only precedent: no mkimage bake, no kernel suite, no
browser sweep; instead the SameBoy interlock ran once — HEAD compiler
vs patched compiler on `vendor/sameboy/bin.json`, output wasm
byte-identical (sha256 3cff309a…).
