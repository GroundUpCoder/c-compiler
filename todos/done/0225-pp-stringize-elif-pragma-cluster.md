# 0225 — preprocessor cluster: # stringize spacing, #elif-after-#else, _Pragma/__STDC_HOSTED__/__COUNTER__

- **Status**: done (2026-07-16) — three commits (lexer whitespace flags for
  comments/newlines; sawElse diagnostics; _Pragma/__STDC_HOSTED__/
  __COUNTER__); six conformance tests; fast gate green (unit + ast, 0196
  xfail preserved), SameBoy interlock byte-identical — no bake/kernel/sweep
  (pure front-end). Dev log: `logs/2026-07-16/pp-cluster-0225.md`
- **Design**: CLAUDE.md "Conformance tests"; found in the 2026-07-16 read-only
  bug hunt (findings G18/G19/G20, all confirmed against clang) — batched
  because all three live in the preprocessor layer of compiler.js

## Goal

Three confirmed preprocessor conformance defects (clang is the oracle):

- **G18 — `#` stringize whitespace fidelity.** (a) A comment or newline
  between argument tokens must become one space in the stringized result
  (C11 6.10.3.2p2 + 5.1.1.2p1 phase 3): `S(a/**/b)` must give `"a b"`, we
  gave `"ab"`. (b) The same loss through macro expansion: a definition-site
  comment (`#define V (2/**/+ 1)`) stringized as `"(2+ 1)"` instead of
  `"(2 + 1)"`. Root cause is ONE defect: the lexer's comment branches and
  the NEWLINE-token branch never set `hasSpace` on the following token.
- **G19 — `#elif` after `#else` accepted and evaluated.** The ifStack frame
  carried no saw-#else flag, so a closed conditional could silently re-open.
  C11 6.10.1's grammar puts every elif-group before the else-group; clang
  diagnoses "#elif after #else" (and "#else after #else") even inside a
  skipped enclosing group.
- **G20 — missing required PP features.** `_Pragma` only worked as a raw
  literal `_Pragma("once")` (no 6.10.9 destringize of `\"`/`\\`, dead when
  produced by macro expansion — the DO_PRAGMA(#x) idiom); `__STDC_HOSTED__`
  (C11 6.10.8.1 required) was not predefined; `__COUNTER__` (GNU, common in
  unique-id token pasting) was absent.

## Plan

- Lexer: `//` and `/* */` branches and the NEWLINE-token branch set
  `space = true` so the next token carries `hasSpace` (also makes
  `#define f/**/(x)` object-like, matching clang).
- ifStack frames grow `sawElse`; `#elif`/`#else` after `#else` diagnose
  with clang's message shape.
- `applyPragma` is the ONE pragma handler (the `#pragma` directive and the
  `_Pragma` operator both route through it); `destringize` per 6.10.9p1;
  `emitExpandedTokens` intercepts `_Pragma ( "..." )` in expansion output.
- `__STDC_HOSTED__: 1` joins the predefined-macro table; `__COUNTER__`
  joins the builtin macros (per-preprocess-run counter, both the direct
  stream and `expand()` gates).

## Acceptance

- Six conformance tests: `pp_stringize_comment_space` (clang-verified
  battery), `diag_pp_elif_after_else` + `diag_pp_else_after_else`
  (exitcode 1), `pp_pragma_operator` (`_Pragma("once")` dedups an include,
  direct + macro-produced), `pp_stdc_hosted`, `pp_counter` (0,1,2 sequence
  through the two-level CAT paste idiom).
- Fast gate green (unit + ast; the 0196 xfail stays xfail); SameBoy
  checksum interlock byte-identical (pure front-end, no codegen movement),
  so no bake/kernel/sweep.
