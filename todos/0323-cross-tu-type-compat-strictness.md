# 0323 — Whole-program link rejects cross-TU declared-type mismatches that separate compilation allows

- **Status**: open
- **Priority**: P1 — **confirmed P1 by @master.** The mismatch is a `const`
  qualifier with **no ABI consequence**, clang/gcc/MSVC all accept it, and it is
  an artifact of our whole-program model rather than wrong code; P0 in this repo
  means silent wrong code in a shipped feature (that is `todos/0319`, not this).
  **This becomes a HARD PREREQUISITE the moment an M1 CPython port is funded** —
  CPython does not link under our model without it.
  The original analysis is kept below because it is the valuable part: filed P1
  rather than P0 because the compiler is arguably *more* correct here than
  clang — the program is technically UB — but it blocks a real corpus.
- **Difficulty**: medium
- **Design**: —
- **Provenance**: found by the `todos/0313` CPython M0 probe.

## The problem

`compiler.js:9555` makes a cross-TU declared-type mismatch a hard link error:

```
Link error: conflicting types for 'PyArg_ParseTupleAndKeywords'
  ('(*struct _object, *struct _object, *const char, *const *char, ...)int'
   vs '(*struct _object, *struct _object, *const char, *const *const char, ...)int')
  at Include/modsupport.h:11
  at Python/getargs.c:1249
```

CPython does this **deliberately**. `Include/modsupport.h` declares:

```c
PyAPI_FUNC(int) PyArg_ParseTupleAndKeywords(PyObject *, PyObject *,
                                            const char *, PY_CXX_CONST char * const *, ...);
```

`PY_CXX_CONST` is `const` under C++ and empty under C (`Include/pyport.h:605`),
so ordinary TUs see `char * const *` — which lets callers pass a plain `char **`.
`Python/getargs.c:4` does `#define PY_CXX_CONST const` **before** including
Python.h, so the TU holding the definition sees `const char * const *`, matching
its own definition.

Under separate compilation this is fine: the linker matches names, not types.
Our whole-program model sees both declarations at once and refuses.

C11 6.2.7p2 does say all declarations of the same function shall have compatible
type, "otherwise the behavior is undefined" — so we are within our rights. But
clang, gcc and MSVC all accept it; CPython ships it; and the difference here is a
`const` qualifier with no ABI consequence.

Note the obvious workaround does **not** work: forcing `-DPY_CXX_CONST=const`
globally just moves the error to the call sites, which legitimately pass
`char **` (`Modules/_functoolsmodule.c:634`, `Modules/_threadmodule.c:744`, …).
`PY_CXX_CONST` exists precisely to permit that.

## Plan

Options, in rough order of preference:

1. Treat a mismatch that is **qualifier-only on a pointee** as compatible for
   linking (still warn). Covers this case exactly and keeps genuine
   signature mismatches loud.
2. Downgrade all cross-TU declared-type mismatches to a warning, with a flag to
   restore the error. (What the probe did to get through — a blunt instrument.)
3. A `--allow-conflicting-types` escape hatch, opt-in per project via
   `bin.json` `compilerArgs`.

Whichever is chosen, the diagnostic should name both TUs (it already does) and
say what the difference is, since the cause is usually a config macro.

## Acceptance

- A two-TU test where one declares `void f(char * const *)` and the other
  `void f(const char * const *)` links, with a warning.
- A genuinely incompatible mismatch (different arity, different scalar types)
  still fails loud.
- CPython 3.13.5 core links with no `conflicting types` errors.
