# 0181 — SPSC pipe fast path: shared-memory rings, kernel only for wakeups + fallback

- **Status**: done (2026-07-14; log: logs/2026-07-14/spsc-pipes.md)
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

## Landed notes — deviations from the plan's letter (both deliberate)

1. **No demotion drain — the ring is the buffer in EVERY mode.** The plan
   said "a demoted pipe drains the ring into the OFD buffer". Landed
   instead: a ringed pipe keeps its bytes in the ring for life, and the
   kernel's own stream ops (`_streamRead`/`_streamWrite`/`_pipeNotify`/
   `_selectScan`/`_traceLine`/pipe fstat) go through storage accessors
   (`_pipeAvail`/`_pipeTake`/`_pipePut`) that read the same ring. Why: a
   demotion-time ring→buf drain races a mid-flight fast reader (kernel and
   reader both consuming = double-delivery), and fixing that honestly
   needs a per-end spinlock plus dead-holder lock stealing. With no drain,
   every instant has at most one producer and one consumer per ring: mode
   flips happen only while every process that could fast-op the flipped
   role is parked in the very RPC doing the flip (promotion fires on a
   holder REMOVAL — the closer is parked; demotion fires on spawn
   inheritance — the only holder-adding event, and the spawner is parked),
   and a straggler fast op that loaded FAST just before a flip commits
   into an end that stayed single-holder. Zero locks, same observable
   behavior; a stale mode read is never wrong, only slower (the kernel
   serves brokered ops on a FAST pipe from the same ring).
2. **Self-pipes stay brokered.** Promotion is REMOVAL-triggered only —
   never at create — because the creator's spawns would demote a
   create-time promotion and burn the one-way ladder before the pipeline's
   steady state even starts. Consequence: a pipe whose two ends stay in one
   process for life (self-pipe wakeup pattern) never promotes. Documented
   limit; the holders are one thread anyway, so there is nothing to win.

Other decisions on the record: strace holds a kernel pseudo-holder ref
(pid 0) on the trace pipe's write end — attached BEFORE spawn fd-actions
so the pipe never even transiently promotes; traced pipes stay brokered
and every byte shows in the trace (the plan's "fast path disabled under
trace" option). select()/FS_WAIT needed NO demotion: `_selectScan` reads
ring occupancy directly, so multiplexing works at full speed on FAST
pipes. Ring capacity is 256K (4× brokered PIPE_CAP — each park/kick cycle
moves a whole ring, so fewer wake RPCs per MB; POSIX only mandates
PIPE_BUF atomicity). Recorded follow-up idea, NOT landed: a low-water
mark for the space-side doorbell (PR_WWAIT as a byte threshold — virtio
EVENT_IDX style) would roughly halve wake RPCs in full-ring lockstep, but
changes when a blocked writer resumes vs today; needs its own written
correctness story.

Measured (bench_fs.js pipe leg, 16MB writer|reader): 271.6 → 442.8 MB/s;
test_spsc_e2e's 8MB pipeline: FS_READ=0, FS_WRITE=4 (result printfs only;
brokered needs ~280 data RPCs), FS_WAIT=125 + PIPE_KICK=123 wake RPCs.
