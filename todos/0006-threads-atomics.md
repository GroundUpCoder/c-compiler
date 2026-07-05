# 0006 — threads + atomics

- **Status**: queued
- **Depends**: — (parallel track; schedule after 0005)
- **Design**: `todos/OS.md` (Phase 2)

## Goal

Real pthreads + C11 `_Atomic` codegen: shared `WebAssembly.Memory`, worker
pool as threads, wasm atomics, real `_Thread_local`, futex-backed
mutex/cond. Processes stay separate-memory (the spawn model); threads share
one memory — orthogonal and composed.

## Plan sketch (needs its own design pass before starting)

- Compiler: `_Atomic` loads/stores/RMW → wasm atomics; `_Thread_local` →
  per-thread base; shared-memory flag on the memory section; TLS init.
- host/kernel: thread workers within a process (distinct from process
  workers); pthread_create/join/detach; futex via Atomics on the shared
  heap; decide the SDL threading policy (SDL3.md open question) alongside.

## Acceptance

- C11 threads.h + pthread.h conformance-style unit tests; a vendored
  pthread-using program runs (candidate: a threaded renderer or make -j).
