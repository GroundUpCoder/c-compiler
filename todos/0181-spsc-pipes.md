# 0181 — SPSC pipe fast path: shared-memory rings, kernel only for wakeups + fallback

- **Status**: open
- **Design**: KERNEL.md "What may leave the kernel — the single-writer rule".
  Sibling items: todos/0179 (vDSO page), todos/0180 (read-only /usr).
  Depends culturally on todos/0178 (unified wait) for the blocking story —
  a ring-parked reader/writer should block via WAIT, not a bespoke futex.

## Goal

Pipe reads/writes are RPCs today — every `cmd | cmd` byte crosses the
kernel worker twice. A pipe with exactly one reader and one writer is a
single-producer/single-consumer ring: data moves process↔process through
shared memory with lock-free head/tail atomics (the io_uring/input-ring
pattern, already proven in-tree), and the kernel is involved only to
wake a blocked end (futex/WAIT) and to arbitrate the slow cases.

## Plan

- PIPE_CREATE gains a fast-path variant: an SAB ring + head/tail/flags
  words, both ends' host.js doing memcpy + Atomics locally; whole-or-
  block write semantics, EOF/EPIPE via flags words + a final wake.
- FALL BACK to the brokered path whenever the SPSC precondition breaks:
  either end dup'd/inherited to a second holder, fd passed to spawn
  fd-actions beyond the simple case, select() multiplexing needs, or the
  trace flag set (strace must still see the traffic — decide: fast path
  disabled under trace, documented). The kernel owns the demotion (it
  sees every dup/spawn); a demoted pipe drains the ring into the OFD
  buffer, then proceeds brokered. Demotion is one-way and rare.
- Blocking: reader/writer park via the 0178 WAIT (ring-space/ring-data
  as a wait source) — do not add a third bespoke park.
- SIGPIPE semantics preserved (writer-after-reader-gone must still
  raise; the flags word carries reader-gone, host.js raises locally).
- Perf proof: bench_fs.js pipe throughput before/after; a hush pipeline
  (`yes | head`-shape) end-to-end.

## Acceptance

- SPSC pipelines move bytes with zero kernel RPCs in steady state
  (counter probe); throughput improvement shown in bench_fs.js.
- dup/inheritance/select/strace cases all demote correctly and behave
  byte-identically to today (test each demotion trigger).
- Pipe e2e surface green (test_pipes.js + shell pipeline e2es); flake
  gate green (this touches blocking/wake paths — the 0168 lesson).
