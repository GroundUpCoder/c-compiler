# 0006 — threads + atomics

- **Status**: **deferred — indefinitely** (2026-07-07; was queued)
- **Depends**: a concrete port that hard-requires pthreads (none exists or is planned)
- **Design**: `todos/OS.md` (Phase 2 sketch, kept);
  deferral rationale: `logs/2026-07-07/threads-atomics-deferral.md`

## Decision (2026-07-07): deferred indefinitely

**Processes are the parallelism unit in this OS** — same family of decision
as posix_spawn-not-fork. Don't re-litigate without a concrete consumer.

Why:

- **Nothing needs it.** Every vendored port landed single-threaded (sqlite
  `THREADSAFE=0`, busybox, micropython GIL-stub, lua, doom, quake, libgit2).
  `make -j`-style parallelism is *process*-parallel and already works via
  spawn. The WM/compositor (Phase 3) composites host-side and needs no C
  threads. C11 explicitly permits declining atomics/threads
  (`__STDC_NO_ATOMICS__`/`__STDC_NO_THREADS__`).
- **The cost is a permanent complexity tax**, sized (survey in the dev log)
  at comparable-to-larger-than the whole 0005 kernel arc: a second
  (imported + shared, max-bounded) memory model forked through host
  instantiation and OS-image metadata; real TLS; thread workers;
  errno/malloc/stdio thread-safety obligations on every future libc change;
  the one-RPC-in-flight kernel page needing a lock (starvation) or
  per-thread channels (kernel redesign); signals × threads semantics;
  a nondeterministic test surface with no TSan.

Rejected alternatives (recorded so they aren't re-proposed):

- **Atomics-only codegen slice** (~600–900 lines: `_Atomic` through
  lexer/types/sema/codegen + 0xFE opcodes on unshared memory): semantically
  unobservable in a single-threaded-by-construction environment — pure
  prepaid cost for a feature this item defers.
- **Parse-and-discard `_Atomic` + plain-ops `stdatomic.h` shim**: correct
  while single-threaded, but rejected on principle — we don't accept syntax
  and silently give it no semantics. `__STDC_NO_ATOMICS__` stays defined and
  truthful; code that needs atomics fails loudly at its own guard.

**Re-trigger**: a port we actually want whose threading cannot be configured
out. That port's real requirements then drive the design (thread-pool
sizing, RPC channels, signal semantics) instead of speculation. Until then
this item stays out of *Next up*.

---

## Original goal (kept for if/when re-triggered)

Real pthreads + C11 `_Atomic` codegen: shared `WebAssembly.Memory`, worker
pool as threads, wasm atomics, real `_Thread_local`, futex-backed
mutex/cond. Processes stay separate-memory (the spawn model); threads share
one memory — orthogonal and composed.

## Plan sketch (needs its own design pass before starting)

- Compiler: `_Atomic` loads/stores/RMW → wasm atomics; `_Thread_local` →
  per-thread base; shared-memory flag on the memory section; TLS init.
  Note from the 2026-07-07 survey: threaded modules must *import* a shared
  memory (each thread re-instantiates the module; module-defined memory
  can't be shared), wasm globals are per-instance so per-thread
  `__stack_pointer` is free, and futex maps to `memory.atomic.wait32/notify`
  in pure C with no host round-trip.
- host/kernel: thread workers within a process (distinct from process
  workers); pthread_create/join/detach; futex via Atomics on the shared
  heap; per-thread (or locked) kernel-page RPC; decide the SDL threading
  policy (answered for now — see `todos/SDL3.md`) alongside.

## Acceptance

- C11 threads.h + pthread.h conformance-style unit tests; a vendored
  pthread-using program runs (candidate: a threaded renderer or make -j —
  note: make -j is actually process-parallel, pick a genuinely threaded one).
