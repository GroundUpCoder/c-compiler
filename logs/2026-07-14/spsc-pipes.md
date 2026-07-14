# todos/0181 — SPSC pipes: the ring is the pipe, the kernel is the doorbell

Third and last of the single-writer-rule trio (0179 vDSO → 0180 RO /usr →
**0181 SPSC pipes**; KERNEL.md "What may leave the kernel"). A pipe with one
reader process and one writer process is a single-producer/single-consumer
ring — the io_uring/input-ring pattern already proven in-tree — so in steady
state bytes move process↔process by memcpy + index commit, and the kernel is
involved only to wake a parked peer and to arbitrate when the SPSC
precondition breaks.

## Shape

- **kernel.js** (everything lives here — RemoteFS included): the PR_* ring
  block (32-byte header + 256K data; every header word single-writer), the
  `pipe-sab` handshake (creator allocates + posts before PIPE_CREATE — the
  audio-sab pattern, because the kernel can't hand an SAB to a parked
  worker), per-end holder maps on the pipe OFDs (`_ofdRef`/pid-aware
  `_ofdUnref`), the LATENT→FAST→DEMOTED ladder, the PIPE_KICK doorbell op,
  FS_WAIT/FS_SELECT flag-before-rescan parking, `procSpec.pipeRings`, and
  RemoteFS's fast read/write/dup bookkeeping.
- **os/kernel-worker.js + os/process-worker.js**: forward + register
  `pipeRings`, mirroring BOOT_SOURCE.
- Kernels without the handshake (fake-worker tests, sockets, ptys) are
  byte-identical: no SAB posted → JS-buf pipe, brokered forever.

## The design points worth recording

**1. No demotion drain — the ring is the buffer in EVERY mode.** The item's
plan said a demoted pipe "drains the ring into the OFD buffer". That drain
is a race: the kernel consuming ring→buf while the still-fast reader
consumes the same ring is double-delivery, and the honest fix is a per-end
spinlock plus dead-holder lock stealing. Landed instead: ringed pipes keep
bytes in the ring for life and the kernel's own stream ops go through
storage accessors (`_pipeAvail`/`_pipeTake`/`_pipePut` — also `_traceLine`,
pipe fstat, `_selectScan`). Mode flips then move NO data, and the ladder's
timing does the mutual exclusion: promotion fires on a holder REMOVAL (the
closer/exiter is parked in that very RPC), demotion fires on spawn
inheritance (the ONLY event that adds a holder — and the spawner is parked).
A straggler fast op that loaded FAST just before a flip commits into an end
that stayed single-holder, and the kernel exercises a ring role only while
that end's sole holder is parked in the RPC being served. Net: at most one
producer and one consumer per ring at any instant, zero locks, and a stale
mode read is never wrong — the kernel serves brokered ops on a FAST pipe
from the same ring, just slower.

**2. Promotion is removal-triggered, never create-triggered.** Promoting at
`pipe()` (both ends in the creator: trivially SPSC) would burn the one-way
ladder — the very spawns that build the pipeline would demote it before the
data flows. So the hush shape promotes exactly when steady state begins:
parent pipes, spawns writer and reader (fd-actions close their surplus
ends), then closes its own copies — the second close leaves one holder per
end and flips FAST. Deliberate consequence, blessed up front: a self-pipe
(both ends in one process for life) never promotes. Nothing is lost — one
process is one thread; there is no cross-worker hop to save.

**3. The lost-wakeup handshake.** The kernel raises PR_RWAIT/PR_WWAIT
BEFORE the readiness rescan inside every park (FS_WAIT, FS_SELECT, and the
brokered piperead/pipewrite parks), records the raised words on the waiter,
and clears them in `_cancelWaiter` — the single choke point every wake path
(serve, EINTR, timeout, SIGKILL) already funnels through. The fast peer
commits its ring indices, THEN loads the flag, and rings PIPE_KICK only if
it's up. Flag-then-rescan vs commit-then-check cross under SC atomics: one
side always notices, so a wake can be redundant (harmless — `_pipeNotify`
is idempotent) but never lost. This is the 0168 kick lesson made
structural; `_streamRead`/`_streamWrite` also re-scan the ring right after
raising the flag to cover the commit that landed in between.

**4. EOF/EPIPE without RPCs (almost).** Close and exit are control plane —
always brokered — so the kernel latches PRF_WGONE/PRF_RGONE in the ring at
the last unref of an end. A fast reader hits empty+WGONE and returns 0
locally; a fast writer hits RGONE and needs its SIGPIPE — delivered by
PIPE_KICK{epipe:1} (the kernel `_deliver`s before responding, so the
pending bit is up when the write's import returns — exactly the brokered
EPIPE+signal ordering). One RPC on a terminal error path.

**5. strace and select needed no fallback machinery.** The trace pipe's
kernel write-end ref registers as pseudo-holder pid 0 — attached BEFORE the
spawn fd-actions run (moved in this item; an action-close could otherwise
fire the promotion check pre-attach and transiently promote), so traced
pipes never promote and every byte stays in the decoded trace. select/
FS_WAIT read ring occupancy directly in `_selectScan` — multiplexing works
at full speed on FAST pipes, no demotion needed (the item had listed it as
a possible trigger).

## Numbers

- bench_fs.js pipe leg (16MB writer|reader, reader times first-byte→EOF):
  **271.6 → 442.8 MB/s** (1.6×).
- test_spsc_e2e 8MB pipeline: **FS_READ=0, FS_WRITE=4** (the result
  printfs; a brokered run needs ~280 data RPCs at the 60000-byte chunk
  cap), wake traffic FS_WAIT=125 + PIPE_KICK=123.

The wake count is the recorded follow-up: in full-ring lockstep (producer
faster than consumer) each ~64K drain kicks the parked writer once. A
low-water mark — PR_WWAIT carrying a byte threshold instead of a boolean,
virtio EVENT_IDX style — would batch those roughly 2-4×, but it changes
WHEN a blocked writer resumes vs today (a reader that stops draining
mid-stream without closing would strand a writer today's semantics would
have resumed), so it needs its own written correctness story. Not landed.

## Gates

- New: test_pipes_spsc.js (48 legs, fake workers over the real SAB
  protocol), test_spsc_e2e.js (real C: zero-RPC counter, SIGPIPE identity,
  mid-stream demotion byte-identical). Registered in tests/kernel/run.js.
- Full kernel suite, browser sweep (25/0), flake gate — green (this item
  touches blocking/wake paths; the 0168 lesson says gate hard).
- test_pipes.js/test_pipes_e2e.js pass UNCHANGED — the unringed path is
  byte-identical, and the ringed path holds their semantics (test_pipes_e2e
  in fact runs promoted now: its parent|child legs go FAST and its
  `no OFDs survive the halt` leg vouches for the holder bookkeeping).
