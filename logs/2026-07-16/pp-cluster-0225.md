# 0225 — preprocessor cluster: # stringize spacing, #elif-after-#else, _Pragma/__STDC_HOSTED__/__COUNTER__

Three confirmed findings (G18/G19/G20) from the 2026-07-16 read-only bug
hunt, batched because they all live in compiler.js's preprocessor. clang
was the oracle throughout.

## G18 — `#` stringize whitespace fidelity

The hunt filed this as two defects (lexer comment branches + cloneToken
preserving definition spacing), but a clang-diffed battery showed ONE root
cause: the lexer never marked "whitespace before this token" for comments
or newlines — only for literal space/tab bytes. So:

- `S(a/**/b)` → `"ab"` (clang: `"a b"`) — comment between arg tokens.
- A two-line argument stringized as one word — the NEWLINE-token branch
  explicitly reset `space = false`, and (inconsistently) a token after TWO
  newlines DID get the flag, because the second NL falls into the plain
  whitespace branch.
- Through expansion: `#define V2 (2/**/+ 1)` stringized as `"(2+ 1)"`
  (clang `"(2 + 1)"`) — same missing flag, at the definition site.
  cloneToken preserving flags verbatim is CORRECT behavior; the flags it
  preserved were wrong. (The hunt's claimed cloneToken repro — clang
  giving `"(2 + 1)"` for `#define V ( 2 +1)` — did not reproduce: clang
  keeps that definition's spacing, `"( 2 +1)"`, and so do we.)

Fix: the `//` and `/* */` branches and the NEWLINE-token branch set
`space = true` (C11 5.1.1.2p1 phase 3: each comment becomes one space;
6.10.3.2p2: any inter-token white space stringizes as ONE space, leading/
trailing deleted — the existing `ai > 0` guard already handles those).
Deliberate side effect, also clang-matching: `#define f/**/(x)` is now an
OBJECT-like macro (the `(` carries hasSpace).

`hasSpace` consumers audited: stringize (the fix's target), paste-result
spacing (takes left's flag — unaffected), function-like-define detection
(the object-like flip above). Nothing else reads it.

The 0196 pinned xfail (`pp_stringize_va_comma_space`, space before an
arg-separating comma) stays xfail — those commas are re-synthesized fresh
in __VA_ARGS__ reconstruction, a different mechanism.

## G19 — `#elif` after `#else`

`#if 0 / #else / #elif 1` was accepted and the `#elif` evaluated —
ifStack frames carried no saw-#else state, so a taken `#else` could be
followed by more branch selection. C11 6.10.1's grammar puts every
elif-group before the else-group; clang errors "#elif after #else" and
"#else after #else", and (verified empirically) diagnoses both even
inside a skipped enclosing group — the conditional-nesting bookkeeping
runs there regardless, so ours diagnoses there too. Frames grow
`sawElse`; the two directives error with clang's message shape; normal
`#if/#elif/#elif/#else/#endif` chains are untouched (the error path adds
no behavior change beyond the diagnostic — after `#else`, anyBranchRan
is already true, so the bogus `#elif` never activated anyway; it just
now fails the compile).

## G20 — `_Pragma`, `__STDC_HOSTED__`, `__COUNTER__`

- `_Pragma` existed (contra the hunt's "parses as undeclared identifier")
  but only as a raw-stream literal special case that string-compared the
  quoted contents to `once`. Now: `destringize` implements 6.10.9p1
  (drop encoding prefix + quotes, `\"`→`"`, `\\`→`\`), the destringized
  text is re-lexed and routed through `applyPragma` — the ONE handler the
  `#pragma` directive also uses (`once` → onceGuards; anything else
  ignored identically) — and `emitExpandedTokens` intercepts
  `_Pragma ( "..." )` sequences in macro-expansion output, so the
  DO_PRAGMA(#x) idiom works (previously those tokens leaked through as a
  parse error).
- `__STDC_HOSTED__: 1` (C11 6.10.8.1 required — this is a hosted
  implementation) joins the predefined table next to `__STDC_VERSION__`.
- `__COUNTER__` (GNU) joins the builtin macros (`isBuiltinMacro` now
  gates both the direct-stream site and the `expand()` site): one counter
  per preprocess run = per translation unit, matching gcc; expands 0, 1,
  2, …; verified the two-level `CAT(id_, __COUNTER__)` paste idiom
  produces distinct identifiers, byte-identical output to clang.

## Gating decision

Pure preprocessor, zero codegen change — same rationale as 0217/0218:

- Fast gate: `node tests/run.js unit ast` — the six new conformance tests
  pass, xfail count preserved (8), no test moved by this diff.
  (`unit/sdl_delay_throws` is red at HEAD before this work — 0224
  fallout, verified on a clean stash; filed as P0 todos/0226.)
- SameBoy checksum interlock, run once at the end: HEAD compiler.js vs
  this diff over the full SameBoy core build — **byte-identical**
  (236,837 bytes), proving no codegen movement.
- No mkimage bake / kernel suite / browser sweep: nothing outside the
  front-end moved, and the interlock proves it.
