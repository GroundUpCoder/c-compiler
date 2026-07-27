# 0324 — Provide C11 `<stdatomic.h>` (or the `__atomic_*` builtins) so CPython's pyatomic.h has a backend

- **Status**: open
- **Priority**: P1 (missing optional-C11 surface, not a defect)
- **Difficulty**: medium
- **Design**: —
- **Provenance**: found by the `todos/0313` CPython M0 probe — it is the very
  first wall: **every** CPython TU fails at header-parse time until it is worked
  around.

## The gap

compiler.js predefines `__STDC_NO_ATOMICS__` (`compiler.js:31368`) and provides
neither `<stdatomic.h>`, the `_Atomic` type qualifier, nor the GCC `__atomic_*`
builtins. That is a *conforming* choice — C11 atomics are optional — but
`Include/cpython/pyatomic.h` then falls through every branch to:

```
Include/cpython/pyatomic.h:543: error: "no available pyatomic implementation for this platform/compiler"
```

Its selection is: `__GNUC__`-ish → `pyatomic_gcc.h`; else
`__STDC_VERSION__ >= 201112L && !__STDC_NO_ATOMICS__` → `pyatomic_std.h`;
else `_MSC_VER` → `pyatomic_msc.h`; else `#error`. We match none:

```
no __GNUC__
__STDC_VERSION__=201112
__STDC_NO_ATOMICS__ defined
```

Probed support (all measured):

| feature | supported |
|---|---|
| `_Generic`, `_Thread_local`, `_Static_assert`, `__typeof__`, `_Alignas`/`_Alignof`, anonymous unions, flexible array members | yes |
| `_Atomic` (qualifier or `_Atomic(T)`) | **no** |
| `<stdatomic.h>` | **no** |
| `__atomic_load` / `__atomic_store_n` / `__ATOMIC_SEQ_CST` | **no** |
| statement expressions `({ … })` | **no** |
| VLAs | no (`__STDC_NO_VLA__`, deliberate) |
| computed goto (`&&label`) | no (matches CPython's WASI config, which also disables it) |

## Why this is cheap for our target

gucOS processes are single-threaded — one wasm instance per Web Worker, no
shared linear memory between processes — and CPython's own wasm32-wasi tier-2
config is single-threaded with pthread **stubs** (`configure.ac:4586`
`posix_threads=stub`). So a plain-load / plain-store lowering is semantically
sufficient: there is no second thread that could observe a torn or reordered
access.

The M0 probe shipped a throwaway shim proving this is enough to get all of
CPython through. Two notes from writing it:

- Only the **functional** form `_Atomic(T)` appears in `pyatomic_std.h`, never
  the qualifier form, so `#define _Atomic(T) T` suffices there.
- Read-modify-write must yield the **old** value, and without statement
  expressions there is no way to introduce a temporary inside an expression.
  The shim stashed the old value in a file-static scratch union and read it back
  through a `__typeof__`-derived pointer. A real implementation should not have
  to do that — which is an argument for implementing `_Atomic` properly, or for
  adding statement expressions (see also the `__extension__` note below).

## Options

1. **Implement `<stdatomic.h>`** with a single-threaded lowering + the
   `_Atomic(T)` functional form. Smallest change that unblocks CPython. Must
   NOT stop predefining `__STDC_NO_ATOMICS__` unless the qualifier form works
   too, or we would be lying about conformance.
2. **Implement the `__atomic_*` builtins.** Also unblocks any GCC-flavoured
   corpus, but CPython would only take that branch if we defined `__GNUC__`,
   which has much wider blast radius.
3. Implement the real `_Atomic` qualifier. Most work, most correct.

Related, found in the same probe and worth deciding together: compiler.js ships
`<threads.h>` as a builtin header **and** predefines `__STDC_NO_THREADS__`
(`compiler.js:31370`), which is self-contradictory. `_Thread_local` does work,
but `Include/pyport.h:489` gates it on `!defined(__STDC_NO_THREADS__)` and so
concludes there is no TLS.

## Acceptance

- A CPython 3.13.5 TU including `Python.h` parses with no shim on the include
  path.
- Unit tests for load/store/exchange/fetch-add/fetch-and/compare-exchange over
  each supported width, asserting RMW returns the OLD value.
- The `<threads.h>` / `__STDC_NO_THREADS__` contradiction is resolved one way or
  the other.
