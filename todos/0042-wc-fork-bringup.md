# 0042 — wc fork bring-up: wc.js, the v1 language

- **Status**: open
- **Depends**: 0041 (fork inherits `__gcstr`/imported-globals emission)
- **Design**: `todos/WC.md` (authoritative, round-2 fork-first; v1
  semantics all decided there — don't re-litigate without new evidence)

## Goal

Fork `compiler.js` → `wc.js` and strip/redirect it into the wc v1
language: memory-less by design, `struct` ≡ `__struct` verbatim, GC
arrays, string literals as `"#"` imports, pointers-are-ints, no unions,
no variadics, exceptions kept. `.wc`/`.wh` sources. The main compiler
and os/ stay untouched.

## Plan

Per WC.md's fork worklist:

- Copy `compiler.js` → `wc.js`; driver accepts `.wc`/`.wh`.
- **Strip**: shadow stack + `AllocClass.MEMORY` promotion (address-taken
  becomes a blame-loc diagnostic), static data/data segments, variadic
  arg-block ABI, setjmp/longjmp lowering, unions, `alloca`, the C
  stdlib, always-on envelope.
- **Redirect**: `struct`→GC path, array declarators→`__array`,
  literals→`"#"` imports, non-GC `T*`→int (deref = error), compound
  literals→`__new`/`__array_of`.
- **Envelope gating**: memory section only on `__wasm`/`__memory_grow`
  demand; table/elem address-taken-only, omitted when unused; assert
  staticData/frameSize unreachable (blame locs).
- Tests: new suite dir (conformance-corpus style: minimal `.wc` +
  expected stdout; `diag_*` for the removed-construct diagnostics).
- Record the size baseline: hello-world section dump — no memory, no
  table, no data, no SP global.

Out of scope here (W3+): `format()`, the `__wc_*` veneer/prelude,
os/ loader arity dispatch, `.so` mode.

## Acceptance

- `struct`/array/string/exception smoke programs compile and run under
  a minimal node runner (superset imports + `"#"` polyfill or compile
  option).
- Hello-world binary contains no memory/table/data sections and no
  stack-pointer global (verifiable with tools/disw).
- Address-taken local, union, `va_arg`, deref-of-int-pointer each fail
  with a diagnostic at the demanding construct's loc.
- Main repo suites untouched and green (wc.js not loaded by anything).
