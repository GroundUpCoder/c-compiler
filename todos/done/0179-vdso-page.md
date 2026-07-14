# 0179 — vDSO page: seqlock-published kernel state readable process-side (no RPC)

- **Status**: done (2026-07-14) — a 12-word seqlock block on the kernel
  page tail (words N-16..N-5, `KP_VD_*`; payload cap now 64 bytes short of
  the page end): pid/ppid/pgid/sid + boot instant (lo/hi) + screen dims,
  published by `_vdsoPublish` at spawn/SETPGID/SETSID/reparent-to-init/
  wmSetScreen (fan-out). `KernelClient._vdsoRead` = bounded-spin seqlock
  reader → RPC fallback; spawnHooks getpgid/getsid answer self-queries
  from the page (foreign pids still RPC), `getppid()` is LIVE (tracks
  reparenting — the spawn-time static went stale; threaded as an optional
  `getppid` fn through runModule→ctx→createPosix, passed by
  process-worker.js and BOOT_SOURCE), `uptimeMs()`/`screen()` accessors.
  libc grew `setsid()` (the Phase-1 RPC finally got a C surface). Decided:
  per-process tail extension, NOT a separate system page (every field is
  per-process or trivially fanned out). Not taken, recorded: fd-flag
  queries (variable-size table, low traffic), fg pgid (per-TTY — tty SAB
  header territory, where winsize already publishes TIOCGWINSZ zero-RPC),
  multi-memory. GetSystemMetrics keeps its synthetic 800×500 by design.
  Tests: `test_vdso.js` (37 checks; the fake-worker harness makes zero-RPC
  structural — a fallthrough would deadlock), `test_vdso_e2e.js` (real
  4-process C run; `_dispatchRpc` op counter shows zero GETPGID/GETSID
  across setsid + orphan reparent). Dev log:
  `logs/2026-07-14/vdso-page.md`.
- **Design**: KERNEL.md "What may leave the kernel — the single-writer rule"
  (added with this item; the 2026-07-14 design-review lineage: IDLE-POWER →
  0178 unified wait → this tier growth). Sibling items: todos/0180
  (read-only /usr), todos/0181 (SPSC pipes).

## Goal

The expensive part of a syscall here is the cross-WORKER hop into the
single-lane kernel event loop, not the wasm→JS import (host.js is
process-local). Kernel state that is single-writer can therefore be
PUBLISHED instead of SERVED — the vDSO pattern (Linux exports clock data
read-only; readers never enter the kernel). The per-process kernel page's
`KP_*` words (vsync seq, SIGPEND, flags) already do this ad hoc; this item
generalizes it into a deliberate surface.

Candidates (all kernel-written, process-read): pid/ppid/pgid/sid, screen
dims, per-tty winsize (TIOCGWINSZ), uptime/boot instant, pending-signal
bits, fd-flag queries (FD_CLOEXEC/O_NONBLOCK), fg pgid. Retires the
GETSID-class chatty RPCs.

## Plan

- One shared region (per-process tail extension of the kernel page, or one
  system page + per-process page — decide by what the fields need), with a
  SEQLOCK version word: kernel bumps odd→write→even; readers retry on odd
  or changed version. Single writer ⇒ no locks, the proven pattern.
- host.js syscall shims consult the page first and fall back to the RPC
  (unknown field). The RPC stays the source of truth; the page is a cache
  with an explicit coherence story.
- Keep KERNEL.md's layout comment + tests in sync (payload-cap arithmetic
  if the kernel page grows — the 0169 precedent).
- NOT in scope: anything multi-writer, anything whose read has side
  effects (tty reads), wasm multi-memory (imports are already cheap —
  revisit only if profiling shows the import boundary mattering).

## Acceptance

- getpid/getppid/getsid/uptime/winsize-read paths make ZERO kernel RPCs
  (strace shows none; a counter test proves it).
- Values stay correct across the mutations that change them (setsid,
  TIOCSWINSZ, screen resize) — the seqlock retry test.
- Kernel suite green; no kernel-page consumers broken.
