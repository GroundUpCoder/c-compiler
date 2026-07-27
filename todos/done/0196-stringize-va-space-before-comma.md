# 0196 — #__VA_ARGS__ drops the space before a comma when stringizing

- **Status**: done (P3)
- **Design**: this file; found in the 2026-07-15 passes/preprocessor bug hunt (/tmp/cchunt-passes/FINDINGS.md BUG 1)
- **Regression test**: `tests/unit/conformance/pp_stringize_va_comma_space/` (pinned xfail, `config.json` `"knownBug":"0196"`)

## Goal

`#__VA_ARGS__` drops the whitespace immediately BEFORE an argument-separating
comma. Space AFTER a comma is preserved; only the space before the delimiter
comma is lost.

Repro:
```c
#define S(...) #__VA_ARGS__
printf("[%s]\n", S(a , b));
```
- Expected (clang & gcc): `[a , b]`
- Actual (compiler.js): `[a, b]`

More cases: `S(a ,b)` → clang `a ,b` / cjs `a,b`; `S(x + y , z)` → clang
`x + y , z` / cjs `x + y, z`.

Severity: P3, cosmetic — affects only `#`-stringized message text (log/assert
macros); no effect on compiled behavior.

## Plan

Root cause (compiler.js ~1443-1454): when reconstructing `__VA_ARGS__`, the
arg-separating commas are re-synthesized fresh:
```js
const comma = new Token(null,0,0,TokenKind.PUNCT, intern(","));
comma.punct = Punct.COMMA;
vaRaw.push(comma);
```
The synthesized comma never gets `flags.hasSpace` set (defaults false). The
stringize loop (~1522-1523) emits a leading space only when `flags.hasSpace`, so
the original "there was whitespace before this comma" bit — which lived on the
delimiter comma token consumed as the arg separator — is gone. Fix: carry the
delimiter comma's leading-whitespace flag onto the synthesized comma.

## Acceptance

- `tests/unit/conformance/pp_stringize_va_comma_space/` flips from xfail to a
  hard pass; remove its `"knownBug"` tag.
- Space-after-comma and non-variadic `#` stringizing unchanged.
