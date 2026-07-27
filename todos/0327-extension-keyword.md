# 0327 — GNU `__extension__` keyword is unsupported; it blocks CPython's entire hashlib family

- **Status**: open
- **Priority**: P2
- **Difficulty**: light
- **Design**: —
- **Provenance**: **measured**, not predicted — by the post-`0319` CPython re-probe
  (`logs/2026-07-27/0319-cpython-reprobe.md`), driving the full 235-TU CPython
  source list through `-a link`. It is one of only **two** front-end root causes
  standing between the current minimal CPython and a batteries-included one.

## The gap

`__extension__` is a GNU C keyword meaning *"do not warn about the non-standard
construct that follows."* It is a **no-op for semantics** — its entire job is to
suppress a diagnostic. We do not support it, so it parses as an identifier:

```
cpython/Modules/_hacl/include/krml/fstar_uint128_struct_endianness.h:27:
  error: Undeclared identifier '__extension__'
  error: Unexpected token in expression: PUNCT '{'
```

One header, but it is included by **8 translation units** — `Hacl_Hash_MD5.c`,
`Hacl_Hash_SHA1.c`, `Hacl_Hash_SHA2.c`, `Hacl_Hash_SHA3.c`, `md5module.c`,
`sha1module.c`, `sha2module.c`, `sha3module.c`. That is **the whole of CPython's
`hashlib`**, lost to one keyword. 8 of the 9 failing TUs out of 231; the other is
a harness include path.

`__extension__` is not CPython-specific — it is pervasive in glibc headers and in
generated C — so this will keep recurring across vendored projects.

## Plan

1. Accept `__extension__` wherever GCC/clang do and give it **no semantic effect**.
   It appears in three positions and all three should be handled, not just the one
   CPython needs:
   - before a declaration (`__extension__ typedef struct {...} x;`),
   - before a statement/expression (`__extension__ ({ ... })`),
   - before an initializer or compound-literal brace — this is the `{` in the
     error above.
2. Prefer the lexer/preprocessor path (treat it as a keyword the parser skips) over
   `#define __extension__` in a shim header: a shim fixes CPython only, and this
   ticket exists because the construct is general.
3. ⚠️ Do **not** confuse this with `__extension__`'s cousins. `__typeof__`,
   `__attribute__` and statement-expressions are separate features with real
   semantics; this ticket is the no-op keyword only. If step 1 reveals that the
   construct guarded here also needs one of those, that is a **separate finding and
   a separate ticket** — say so rather than widening this one.

## Acceptance

- A conformance test covering all three positions from step 1, including a
  compound literal after `__extension__` (the exact CPython shape).
- Re-run the re-probe's full-list link
  (`logs/2026-07-27/cpython-m0-reprobe-harness.md`) and show the failing-TU count
  go **9 → 1**, the remaining one being `_elementtree.c`'s missing
  `-I…/Modules/expat` (a harness flag, not ours).
- `unit` + `todos` green at baseline; no image bump owed unless codegen changes.

## What this does NOT unblock on its own

Codegen past these 8 TUs still stops on **6 undefined libc symbols** —
`clock_getres`, `explicit_bzero`, `fma`, `gmtime_r`, `tzset`, `wcstol`. `wcstol`
is already liability **`L29`**, funded by `todos/0309`. Closing 0327 moves the
blocker from the front end to the libc shim; it does not produce a working
hashlib by itself. State that when reporting.
