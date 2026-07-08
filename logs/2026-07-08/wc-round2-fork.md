# WC round 2 — fork-first is authoritative; the dialect is the project

Second wc design session today, run in parallel with other work — and it
collided with the first: this session's thread designed the `.wc` dialect
in depth and concluded "fork `compiler.js` → `wc.js`", while the earlier
session had just rewritten `todos/WC.md` the other way ("no dialect, two
flags on plain C" — `wc-round1-flags.md`). The collision surfaced when
this thread went to write WC.md and found it already rewritten.

**Ruling (user, explicit): fork wins.** This thread's design is
authoritative; the round-1 flags approach is demoted to the *fold-back*
plan, applied to the main compiler only after wc proves the language's
usefulness and effectiveness. Rationale: total isolation — the experiment
must not get in the way of the main compiler/OS project at all, and the
language should be proven in its own artifact first. WC.md is rewritten
accordingly (round-1 verified code facts preserved — they hold in wc.js
too, since it starts as a byte copy).

## What this session settled (now in WC.md "The language")

- **Memory-less by design**; userland escape hatch = the existing
  `__wasm(...)` inline-wasm + `__memory_size/grow` (verified present,
  compiler.js:10706 — zero new compiler features needed); memory section
  demand-gated, compiler does no bookkeeping.
- **`struct` ≡ `__struct` verbatim** — all GC-struct rules inherited
  unchanged, including `struct Foo *` as the ref spelling. Arrays →
  `__array(T)`, no decay. Unions removed.
- **Pointers are ints**: non-GC `T*` parses but IS i32; deref errors.
  Keeps adapted `.h` prototypes compiling; Tier-1 opaque-handle interop.
  Function pointers stay ints → **call_indirect inherited, funcref
  deferred** to the `.so` callback milestone (also keeps the two threads
  agreeing — round 1 reached the same call independently).
- **String literals → importedStringConstants, module `"#"`**, typed
  `__refextern`; `str` = prelude typedef of `__externref` for v1.
  Verified this session: the `wasm:js-string` import surface already
  exists in the stdlib (:22009+), host.js already passes
  `builtins:['js-string']` (:8210), and `importedStringConstants` works
  in Node v25.8.2 (hand-encoded module probe).
- **Variadics dropped; `format("...", ...)` builtin** instead —
  compile-time checked, lowers to js-string concat. Gap found:
  `wasm:js-string` has NO number→string conversion, so `%d`-class is
  pure-prelude itoa (i16 array + `fromCharCodeArray`) and `%f` is one
  host util (`__wc_dtoa`).
- **Exceptions survive** — `__try/__catch/__throw` (`DExceptionTag`,
  :3545) is independent of the setjmp/longjmp lowering (stripped); wasm
  tags carry typed values incl. refs. Becomes wc's error idiom.
- **Statics are near-free**: a static local is a function-scoped global →
  wasm global; the linear-memory need was only ever aggregates/
  address-taken, which don't exist in wc. Ref-typed globals/statics init
  to null or string literal only; no start-function synthesis.
- **Compound literals in v1**: `(T[]){...}` → `__array_of` (trivial);
  `(struct Foo){...}` → `struct.new` / `struct.new_default`+`struct.set`.
- **Runtime ABI**: `int main(void)` + a pull-based `__wc_*` import veneer
  (argc/arg/getenv/read/write/exit/dtoa — host never constructs GC
  values). **Loader stays fully agnostic**: superset import object +
  unconditional compileOptions; call convention dispatched on
  `main.length` (3 → C argv path, 0 → wc). No provenance flags anywhere.

## Queue

`todos/0041` — `__gcstr` in the MAIN compiler (the one sanctioned
pre-fork touch; independently useful to C, fork inherits it).
`todos/0042` — the fork itself. Both slotted at the END of Next up:
wc is a side project and must not get in the way of the OS work.

## Process note

Two agents were active in the repo during this session (the other landed
69d37f2 mid-thread). This commit touches only wc docs/queue files;
compiler.js working-tree changes belong to the other thread.
