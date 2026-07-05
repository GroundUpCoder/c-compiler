# kernel.js Phase 1: the skeleton lands

Implemented Phase 1 of `todos/KERNEL.md`: `kernel.js` (owner-side process
control plane) + `tests/kernel/`. host.js is untouched — the whole point of
Phase 1 was proving the kernel could land behind the existing `spawnHooks`
seam. `KernelClient.spawnHooks()` returns an object shaped exactly like the
hooks `createSpawn` already accepts; the difference is that the hooks now
park the worker on the kernel-page doorbell (`Atomics.wait`) instead of
being embedder magic.

## What landed

- **kernel.js** (~530 lines): kernel-page SAB layout (doorbell, SIGPEND,
  SIGBLOCK, flags, RPC region — the Phase 2 words are already reserved so
  the format is stable), JSON block-RPC codec, `Kernel` (process table,
  spawn/wait/kill/exit/compile dispatch, zombies, reaping, orphan
  reparenting to pid 1, pid-1 halt), `KernelClient`, and `nodeCreateWorker`
  — the tested Node reference factory whose bootstrap runs host.js's
  `runModule` in a worker_thread with a private in-memory BlockFS.
- **libc `kill()`/`killpg()`** in compiler.js — the family comment always
  claimed kill(), but no C wrapper over `__spawn_kill` actually existed
  (only `raise()`'s synchronous self-delivery). Self-directed kill takes the
  raise() path (delivers before return, which the kernel round-trip can't do
  until Phase 2); everything else goes to the kernel. Also refreshed the
  stale sys/wait.h comment: waitpid(-1) and pgroup selectors now work.
- **tests/kernel/**: `test_kernel.js` (51 checks) plays the process side of
  the SAB protocol by hand against fake workers — deterministic, no
  threads, covers the whole table: inheritance (envp/cwd/pgid),
  SETPGROUP both forms, zombie-before-wait and wait-before-zombie, WNOHANG,
  ECHILD, pgid selectors, kill across all disposition kinds (DFL
  terminate/ignore classes, IGN, HANDLER → SIGPEND bit + doorbell),
  SIGKILL, pgroup kill, setsid/getpgid, orphan reparenting, crash paths,
  compile round-trip, halt. `test_e2e.js` (8 checks) compiles three real C
  programs and runs the tree live: init spawns /bin/child (argv/env/pid/ppid
  all assert through printf), waitpids its exit code, then SIGTERMs
  /bin/sleeper *while it's parked in sleep(100)* — worker.terminate as the
  preemption backstop, termsig round-tripping through wait status — and
  exits 42 into onHalt.

## Decisions/notes along the way

- The test-side trick in test_kernel.js is worth remembering: because the
  kernel responds on the same thread's microtasks, the test can submit an
  RPC and poll RPC_STATE with setImmediate — full protocol coverage with
  zero worker_threads. Deferred WAIT is tested by injecting the child's
  'exited' message mid-wait.
- Per-process private BlockFS in the Node bootstrap is explicit Phase 1
  scope (the shared store is OPFS in the browser; a SAB-backed shared
  MemoryByteStore is future Node work). fd_actions ride through procSpec
  untouched until Phase 4.
- Payloads are JSON in the page (64 KiB cap, E2BIG/ENOMEM on overflow).
  Control-plane rates don't care, and bulk ops (PIPE_*) can define raw
  layouts per-opcode later without breaking anything.
- Suites: kernel 59 checks green; tests/spawn parity green; full unit suite
  694/0 (kill/killpg link into every program via __signal.c — no fallout);
  BlockFS all green.

Next: Phase 2 (doorbell-driven signal delivery at libc safe points, EINTR,
ordered exit handshake) — that's the one that starts touching host.js.
