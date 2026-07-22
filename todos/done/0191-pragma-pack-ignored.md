# 0191 — #pragma pack(N)/push/pop silently ignored (wrong struct layout, no diagnostic)

- **Status**: open (P1)
- **Design**: this file; found in the 2026-07-15 frontend bug hunt (/tmp/cchunt-frontend/FINDINGS.md F3)
- **Regression test**: `tests/unit/conformance/pragma_pack_layout/` (pinned xfail, `config.json` `"knownBug":"0191"`)

## Goal

`__attribute__((packed))` IS honored, but `#pragma pack(N)` / `push` / `pop` are
dropped on the floor (compiler.js ~line 2084, "Other pragmas silently ignored").
No warning; the struct silently gets default alignment.

Repro:
```c
#pragma pack(1)
struct P { char c; int i; };   // clang: 5
#pragma pack(2)
struct Q { char c; int i; };   // clang: 6
#pragma pack()
printf("%zu %zu\n", sizeof(struct P), sizeof(struct Q));
```
- Expected (clang): `5 6`
- Actual (compiler.js): `8 8`

Severity: P1. Latent silent-miscompile for any binary-format / MMIO / savestate
code that relies on `#pragma pack` (MSVC-style — real ports use it; OS.md
already flags "#pragma pack already?" as an open question, and MGBA's
gb/serialize.h uses it, though that core isn't currently compiled).

## Plan

Root-cause hypothesis: the pragma handler near compiler.js:2084 recognizes only
a few pragmas and silently ignores the rest, including `pack`. The
packed-attribute layout path already exists, so the fix is to (a) parse
`#pragma pack(N)` / `push`/`push,N` / `pop` into a max-alignment stack, and
(b) thread the current pack value into the struct-layout allocator (cap each
member's alignment at the pack value, same mechanism as the packed attribute).
Minimum acceptable: emit a "pragma pack ignored" diagnostic; preferred:
implement it.

## Acceptance

- `tests/unit/conformance/pragma_pack_layout/` flips from xfail to a hard pass;
  remove its `"knownBug"` tag. pack(1)/pack(2)/pack() and push/pop nesting
  produce clang-matching `sizeof`.
- `__attribute__((packed))` layout unchanged.
