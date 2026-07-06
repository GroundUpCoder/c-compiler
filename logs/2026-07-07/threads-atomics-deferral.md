# 0006 threads + atomics → deferred indefinitely

**Decision**: `todos/0006` (threads + atomics, OS.md Phase 2) is deferred
indefinitely. No code lands. **Processes are the parallelism unit in this
OS** — the same family of decision as posix_spawn-not-fork. Re-trigger
only when a port we actually want hard-requires pthreads.

This started as "let's do 0006": we surveyed the codebase, produced a
phased plan (A: atomics codegen, B: TLS, C: thread workers + futex libc,
D: kernel integration + acceptance port), then stopped and asked whether
it was worth it at all. It isn't, today. The survey and the sizing are
recorded here so the next visit starts from facts, not archaeology.

## Survey findings (2026-07-07, three parallel code surveys)

Compiler (`compiler.js`):
- `_Atomic` is **not even a keyword** (the OS.md pillar table wrongly said
  "parses but doesn't codegen" — fixed). `__STDC_NO_ATOMICS__=1` is
  predefined. `_Thread_local` parses and is discarded.
- Zero `0xFE` atomic opcodes; memory is module-defined + **exported**, no
  shared flag, no max pages; one mutable `__stack_pointer` global.
- Useful seams that exist: `_Generic` is fully implemented; the
  `__builtin(kind, …)` intrinsic mechanism (~25 kinds, clean dispatch);
  `isVolatile` appears at only 14 sites (qualifier plumbing is compact);
  the "validator" is just a `WebAssembly.validate` backstop.
- libc is embedded strings: no `pthread.h`/`stdatomic.h`; `threads.h` is a
  one-line stub; errno is a plain global; TLSF malloc and stdio FILE have
  no locking; no crt/ctors to hook TLS init into.

Host/kernel:
- All SAB/Atomics machinery exists but *between* processes (kernel-page
  doorbell, tty ring, sleep cell). serve.js already sends COOP/COEP.
  Processes already run in workers, so `Atomics.wait` is legal where
  threads would run. Nothing resembling in-process threads exists.
- Key architectural facts for whenever this is revisited: threaded modules
  must **import** a shared, max-bounded memory (each thread is a fresh
  instantiation of the same module; module-defined memory can't be
  shared); wasm globals are per-instance, so per-thread `__stack_pointer`
  is free; TLS is the LLVM `__tls_base` model; futex maps to
  `memory.atomic.wait32/notify` in pure C, no host round-trip; the kernel
  page allows ONE in-flight RPC per process, so threaded syscalls need a
  process lock (blocked `read()` starves siblings) or per-thread channels
  (kernel.js redesign).

Vendor evidence:
- Every big port landed single-threaded: sqlite `THREADSAFE=0`, busybox
  ("barrier() empty, single thread"), micropython (GIL stub), lua, doom,
  quake, libgit2. Nothing queued needs threads. Even `make -j` — one of
  the todo's own acceptance suggestions — is *process*-parallel and would
  work today via spawn.

## Why deferred

- **No consumer.** The WM/compositor (Phase 3) composites host-side;
  networking doesn't need threads; coreutils don't. The genuinely
  thread-requiring class (ffmpeg-style codecs, CPython-with-threading,
  engines with audio/loader threads) is speculative — none queued.
- **Permanent complexity tax**, sized comparable-to-larger than the whole
  0005 kernel arc: a second memory model forked through host instantiation
  + OS-image metadata (mode per binary), real TLS, thread workers,
  errno/malloc/stdio thread-safety obligations on every future libc
  change, RPC locking or per-thread channels, signals × threads semantics
  (per-thread masks, STOP parking every thread), and a nondeterministic
  test surface with no TSan — against suites that are deterministic by
  design.
- C11 explicitly permits declining both features; the predefined
  `__STDC_NO_ATOMICS__`/`__STDC_NO_THREADS__` macros keep us honest and
  make well-behaved portable code take its single-threaded paths.

## Alternatives considered and rejected

1. **Atomics-only codegen slice** (exactly sized: ~600–900 lines —
   `_Atomic` keyword/parse/`isAtomic` qualifier, atomic lvalue semantics
   through the assignment/inc-dec codegen paths, ~50 lines of `0xFE`
   emitters, intrinsics, `stdatomic.h` over `_Generic`, ~15 conformance
   dirs; zero host changes since atomic ops validate on unshared memory).
   Rejected: **semantically unobservable** in a single-threaded-by-
   construction environment. Pure prepaid cost for a deferred feature.
2. **Parse-and-discard `_Atomic` + plain-ops `stdatomic.h` shim**
   (~150 lines, technically correct while single-threaded, precedent:
   `_Thread_local`). Rejected **on principle by the user**: we don't
   accept syntax and silently give it no semantics. Fail loudly instead.

## Fallout recorded elsewhere

- `todos/0006` — status + rationale + re-trigger condition (kept in
  `todos/`, not `done/`; it's deferred, not done).
- `todos/README.md` — dropped from *Next up*.
- `todos/OS.md` — Phase 2 header marked deferred; pillar row corrected.
- `todos/SDL3.md` — the P2 threading-policy open question is now decided:
  stub single-threaded, fail loud on `SDL_CreateThread`. (Single-threaded
  mutex/atomic impls behind the SDL API are fine — that's SDL's contract,
  not C11's, so it isn't the rejected shim.)
- `HANDOFF.md` — queue updated.
