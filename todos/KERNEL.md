# kernel.js — the process control plane

Design doc for the kernel layer under `todos/OS.md` Phase 1. Read that first
for the north star and the posix_spawn-not-fork decision; this doc designs the
thing that decision implies: a real kernel — process table, signals, tty line
discipline, job control — as a first-class, in-repo component.

**Status: Phases 1–4 implemented** (`kernel.js` + `tests/kernel/`).
Phase 1: process table, kernel page, block-RPC, KernelClient,
spawn/wait/kill/compile parity; libc `kill()`/`killpg()`. Phase 2
(`todos/done/0001`): asynchronous signal delivery at libc safe points
(`__sig_dispatch` export + host env-import wrapping), EINTR with SA_RESTART
on waitpid, interruptible sleep/usleep/nanosleep, real `pause()`/
`sigsuspend()`, blocked-mask publication (`__on_sigmask`), SIGCHLD, and the
ordered exit handshake (OP.EXIT). Phase 3 (`todos/done/0002`): the Tty
kernel object — line discipline (canonical editing/echo/ICRNL), ISIG chars
→ fg-pgroup signals (Ctrl-C = SIGINT), full-struct termios over
`__tty_getattr`/`__tty_setattr` RPCs, `tcgetpgrp`/`tcsetpgrp`, SIGWINCH,
EOF, stdin-read/select EINTR (kernel rings the tty futex on signal posts).
v1 tty limits (documented in kernel.js): one tty, single-active-reader
consume path (ring mode only), empty-line VEOF is sticky. The fd/data-plane
amendment is implemented (`todos/done/0009`): kernel-owned per-process fd
tables → shared open file descriptions → one BlockFS in the kernel; 0x04xx
fs RPCs with raw read/write payloads (KP_RPC_KIND); RemoteFS reusing
toWasmEnv; brokered-mode tty reads as deferred RPCs; SIGKILL is
fsck-verified leak-free (the Phase-1 accepted leak retired). Benchmark:
~10µs/RPC — 559 MB/s write, 96.6K metadata ops/s brokered. Phase 4
(`todos/done/0003`): pipes as OFDs — `PIPE_CREATE` + kernel-side buffers
with wait queues (blocking read/write as deferred RPCs, EOF on last
write-end close, EPIPE + SIGPIPE, select readiness) — and job control:
STOPPED state, cooperative stop via `KP_FLAGS.STOP` parked at RPC-entry /
sigpoll safe points, SIGCONT resume regardless of disposition,
`WUNTRACED`/`WCONTINUED` (each transition reported once), SIGTTIN (EIO
when ignored/blocked) for background brokered tty readers. Phase 5 — the
shell port — is the acceptance gate (`todos/0005`).

## Why this exists

Today the repo defines the *seams* of a process model but not the kernel
itself:

- `spawnHooks` — `{spawn, wait, kill, sigdisp, compile}`, synchronous hooks
  passed to `runModule` (`host.js` `createSpawn`); without them,
  `createNullSpawn` makes everything ENOSYS.
- `pipeBroker` — `{pipeCreate, pipeRead, pipeWrite, pipeClose, pipeRef}`,
  optional owner-side pipe transport so one pipe's ends can live in different
  workers (`host.js` BlockFS ctor comment).
- The live-stdin SAB — ring + 8-word header (`SI_SEQ/AVAIL/WRITEPOS/READPOS/
  EOF/COLS/ROWS/TERMIOS`), futex on `SI_SEQ`; `select()` and blocking stdin
  reads park on it; `tcsetattr` publishes a 3-bit icanon/echo/opost mode word
  for the page's line discipline.
- `__on_sigdisp` — libc mirrors per-signal disposition (DFL/IGN/caught) to the
  owner so `kill()` can pick the right action. libc `signal`/`sigaction`/
  `raise` already do synchronous self-delivery in-process.
- `__spawn_spec.pgid` + `POSIX_SPAWN_SETPGROUP` — plumbed end-to-end, consumed
  by nothing.

The hooks' reference implementation lives OUTSIDE this repo (the c/ app's
owner worker); in-repo, only `tests/spawn/test_spawn_host.js` implements them.
Each of these seams grew independently: spawn has a block-RPC, stdin has a
ring, pipes have a broker, termios has a mode word. Four ad-hoc channels, no
process table, no async signal delivery, no job control — and every embedder
re-derives the owner side from scratch.

**kernel.js consolidates the owner side into one canonical, in-repo component
with one protocol.** Everything downstream (shell, job control, coreutils,
later the WM protocol) sits on it.

## Decision: a separate `kernel.js`, not more `host.js`

`host.js` is *per-process*: inlined into every emitted HTML page, loaded into
every process worker — it is libc's JS half. The kernel is *per-system*: it
runs exactly once, on the owner side. Different cardinality, different
deployment unit:

- Single-program outputs (`hello.html`, `doom.html`) keep working with no
  kernel at all — `createNullSpawn`/no-SAB stays the degenerate case, and
  those pages don't carry a process table they never use.
- The full-OS page loads both: `kernel.js` on the owner side, `host.js` in
  every process worker.
- External embedders (the c/ app) migrate from hand-rolled hooks to
  instantiating the kernel and wiring its UI bridge.

Same file discipline as the rest of the repo: one file, plain JS, no build
step, browser + Node (Node parity is what makes `tests/kernel/` possible).
`host.js` keeps everything process-side (BlockFS, fd table, syscall imports,
SDL/WebGPU); the boundary is **owner-side vs process-side**, not new-vs-old.

## Scope: control plane only

The kernel handles *control*: process lifecycle, signals, tty, process
groups, pipe rendezvous, (later) WM surfaces.

It does NOT sit in the data plane. Filesystem I/O stays in-process — each
worker's BlockFS runs directly over the shared byte store (the read-through
coherence invariant, see CLAUDE.md). Bulk stdout/stderr/audio keep their
existing SAB rings. This split is already the architecture and it's correct:
syscall-frequency work never crosses a broker; only rendezvous does.

```
        UI bridge (main thread: xterm, canvas, DOM)
              │  postMessage / rings
        ┌─────┴─────────────────────────────┐
        │  kernel.js (owner: main thread     │
        │  or dedicated worker)              │
        │  process table · signals · tty ·   │
        │  pgroups · pipe rendezvous         │
        └─┬─────────────┬─────────────┬─────┘
   kernel page SAB  kernel page SAB  kernel page SAB
        ┌─┴──────┐   ┌──┴─────┐   ┌──┴─────┐
        │worker: │   │worker: │   │worker: │      ← host.js + wasm each
        │ /bin/sh│   │ cat    │   │ cc     │
        └─┬──────┘   └──┬─────┘   └──┬─────┘
          └────────────┴────────────┴── shared byte store (BlockFS data plane)
```

The kernel module is written location-agnostic (message-driven; worker
creation is an injected capability, `createWorker(spec)`), but the reference
deployment is **a dedicated kernel worker** — decided, see the settled table:

- OPFS `SyncAccessHandle` is **worker-only**: any kernel that touches the
  BlockFS store directly (first-boot seeding, fsck-on-boot, the future orphan
  sweep) cannot run on the main thread.
- The main thread stays a dumb UI bridge (xterm, canvas, input events) —
  control-plane work is isolated from rendering jank and vice versa.
- A worker may block (Atomics.wait) for short critical waits if ever needed.
  This is NOT a license for the kernel to block routinely — it stays
  event-driven, since a parked kernel can't receive messages.
- Process workers are spawned by the kernel worker (nested workers —
  universal in current engines); the injected `createWorker` keeps the
  main-thread-relay variant and Node's `worker_threads` working unchanged.

## Process table

Per-process kernel state (PCB):

```
pid, ppid, pgid, sid
state        RUNNING | STOPPED | ZOMBIE
worker       handle (terminate capability)
kernelPage   the per-process SAB (below)
exit         { code, signal } once dead
children     Set<pid>
tty          controlling tty or null
sigdisp      per-signal DFL/IGN/CAUGHT mirror (from __on_sigdisp)
sigpending/sigblocked   mirrors of the SAB words (kernel is authoritative)
```

- **pids** are minted monotonically from 2. **pid 1 is init**: the first
  program the embedder starts (eventually `/sbin/init` or the shell directly).
  Orphans reparent to pid 1. If pid 1 exits, the kernel halts the system
  (embedder callback — the page decides what "halt" renders as).
- **Zombies**: an exited process keeps its PCB (state=ZOMBIE, exit status)
  until reaped by `wait`. Parent gets SIGCHLD on child exit/stop/continue.
- **wait family**: `waitpid(pid | -1 | 0 | -pgid)` with `WNOHANG`,
  `WUNTRACED`, `WCONTINUED`. Status encoding follows the existing
  `__spawn_wait` contract (exit code / termsig packing per POSIX macros
  already in `<sys/wait.h>`).
- `setpgid`, `getpgid`, `setsid`, plus honoring the already-plumbed
  `POSIX_SPAWN_SETPGROUP`.

## The kernel page (per-process SAB) and the unified protocol

One small SAB per process, created at spawn, shared kernel↔worker. Layout
(i32 words; one 4 KiB page is plenty):

```
[0] DOORBELL   seq counter; kernel bumps + Atomics.notify on ANY event
               for this process (signal posted, child changed state,
               pipe/tty became ready, RPC response ready, CONT)
[1] SIGPEND    pending-signal bitmask (kernel Atomics.or's; libc clears
               claimed bits with Atomics.and at dispatch)
[2] SIGBLOCK   blocked mask (libc writes via sigprocmask; kernel reads)
[3] FLAGS      bit0 STOP-requested; bit1 in-sigdispatch; …
[4] RPC_STATE  IDLE / REQUEST / DONE(+errno)
[5..]          RPC opcode + payload/response region
```

**One doorbell.** Every blocking operation in libc becomes the same loop:

```
for (;;) {
  if (condition satisfied)          return result;
  if (SIGPEND & ~SIGBLOCK)          → dispatch; return EINTR (or restart);
  seq = Atomics.load(DOORBELL);
  re-check condition;               // no lost wakeups
  Atomics.wait(DOORBELL, seq, timeout);
}
```

This is the single most important unification: today stdin waits on `SI_SEQ`,
spawn-wait parks on an app-private SAB, pipes can't wake cross-process
readers at all. With one doorbell per process, *anything* the kernel knows
about can interrupt *any* blocking call — which is exactly what EINTR
semantics require and what makes Ctrl-C actually work against a blocked
`read()`.

**RPC transport** formalizes what the spawn block-RPC already does: worker
writes request into the RPC region, `postMessage`s the kernel (a parked
worker can't be its own transport; the message also works when the kernel
can't block, i.e. main thread), then parks on the doorbell. Kernel writes the
response, sets DONE, bumps the doorbell. Node path identical via
`worker_threads` messaging.

**Opcode space** (versioned header; groups reserved):

```
0x00xx process   SPAWN WAIT KILL EXIT SETPGID GETPGID SETSID SIGDISP SIGMASK
0x01xx tty       TCGETATTR TCSETATTR TCSETPGRP TCGETPGRP (TIOCGWINSZ stays
                 a SAB read — no RPC for hot paths)
0x02xx pipes     PIPE_CREATE PIPE_REF PIPE_CLOSE PIPE_WAIT PIPE_NOTIFY
0x03xx misc      COMPILE (the existing /bin/cc hook)
0x1xxx reserved  WM surfaces (SURFACE_CREATE/PRESENT/…, see below)
```

`host.js`'s existing imports (`__spawn`, `__spawn_wait`, `__spawn_kill`,
`__compile`, `__on_sigdisp`, `__tcsetattr`, …) become thin wrappers over this
channel. The C-visible libc API does not change — programs recompile, ports
don't notice.

## Signals

Ownership split: **the kernel owns routing and default actions; the process
owns handlers.** libc already has the handler tables, `sigaction` flags, and
synchronous `raise()`; what's missing is asynchronous inbound delivery.

`kill(pid, sig)` in the kernel:

1. Route: pid > 0 → that process; pid 0 / -pgid → every member of the
   pgroup; permission model is trivial (single user).
2. Consult the disposition mirror:
   - **IGN** → drop (except KILL/STOP/CONT, which ignore dispositions).
   - **CAUGHT** → `Atomics.or(SIGPEND, bit)`, bump doorbell.
   - **DFL** → kernel applies the default action itself:
     - *terminate* class (HUP INT PIPE TERM USR1 USR2 ALRM …): orderly
       teardown as if the process exited with that termsig — the kernel
       requests exit via SIGPEND+doorbell and, if the process doesn't reach a
       safe point within a grace window, hard-terminates the worker.
     - *ignore* class (CHLD WINCH URG): drop.
     - *stop* class (STOP TSTP TTIN TTOU): set FLAGS.STOP, bump doorbell;
       worker parks at its next safe point; state=STOPPED; SIGCHLD+WUNTRACED
       to parent.
     - *continue* (CONT): clear STOP, bump doorbell; SIGCHLD+WCONTINUED.
3. **SIGKILL / SIGSTOP are uncatchable** and never consult the mirror.
   SIGKILL = `worker.terminate()` + kernel-side cleanup (below).

**Worker-side delivery** happens at *safe points*: entry to every libc
syscall wrapper (one `Atomics.load` of SIGPEND — cheap enough to be
unconditional) and inside every doorbell wait loop. Dispatch: claim bits with
`Atomics.and`, set the in-dispatch flag (no re-entry), call the wasm export
that runs the C handlers through the existing `__sig_a`/`__sig_h` tables,
clear the flag. Interrupted blocking calls return `EINTR` unless the action
has `SA_RESTART`.

**The compute-loop caveat, decided:** a pure loop (`while(1);`) never reaches
a safe point, so catchable signals won't interrupt it. Accepted for v1 —
SIGKILL still works (worker.terminate is preemption of last resort), which is
what a user's `kill -9` needs. Future option, explicitly out of scope for v1:
a `--signal-polls` compiler flag inserting a SIGPEND check at loop back-edges
(measurable cost; off by default; needs its own benchmark-driven design).

## TTY and line discipline

Today's ownership is inverted: the *page* implements echo/line-editing and
reads the process's 3-bit `SI_TERMIOS` wish. That can't express VINTR→SIGINT
(the page knows nothing about processes) and caps termios at three flags.

**The tty becomes a kernel object.** The UI bridge (xterm) forwards raw input
bytes/resizes to the kernel and renders output bytes; all policy moves into
the kernel's line discipline:

- Full termios state (`tcgetattr`/`tcsetattr` become RPCs — they're rare;
  today's canned-constants `__tcgetattr` and 3-bit `__tcsetattr` are
  replaced).
- Canonical mode: kernel-side line buffer with erase/kill/EOF handling and
  echo; raw mode: bytes pass straight through. Echo renders by sending bytes
  back out the UI bridge.
- **Control chars route as signals to the foreground pgroup**: VINTR→SIGINT,
  VQUIT→SIGQUIT, VSUSP→SIGTSTP. This is the payoff of tty-in-kernel: Ctrl-C
  finally means something.
- `tcsetpgrp`/`tcgetpgrp`; resize → winsize words + SIGWINCH to the fg
  pgroup.

**The tty SAB is the natural evolution of today's stdin SAB** — same ring +
header shape, extended: fg-pgid word, full termios block, and the input ring
now carries *post-line-discipline* bytes. It is shared by every process whose
fd 0/1/2 is the tty (fd inheritance already models this). Reads consume from
the shared ring under an Atomics lock — bytes go to whoever reads first,
which is POSIX behavior for pgroup members sharing a terminal.

- Background `read()` from the tty (implemented kernel-side in 0003, simpler
  than the libc-compares-pgid design: the brokered FS_READ already lands in
  the kernel, which IS the authority on fgPgid): not the fg pgroup → SIGTTIN
  to the reader's pgroup and EINTR, or EIO if SIGTTIN is ignored/blocked
  (POSIX). Ring-mode (standalone) reads stay un-gated. SIGTTOU only with
  TOSTOP set; **v1 leaves output un-gated** — per-process stdout rings keep
  draining to the UI bridge directly (kernel out of the data plane), so
  background jobs may interleave output like most real shells' default
  anyway.
- `TIOCGWINSZ` stays a SAB read (`SI_COLS/ROWS` today), no RPC.
- One tty in v1. Sessions exist in the PCB but `/dev/tty`, multiple ttys, and
  pty pairs wait until something needs them (the WM's terminal app will).

## Pipes and cross-process blocking (implemented, todos/done/0003)

Keep the existing split: in-instance JS pipes when no kernel is present
(single-program pages, via host.js's `pipeBroker` seam or in-memory
fallback), kernel pipes otherwise. Post-0009 the kernel side needed ONE new
opcode: `PIPE_CREATE` makes two OFDs over a kernel-side buffer, and
everything else — inheritance, fd_actions, read/write/close/dup, select —
is the same fd machinery files use. The design doc's PIPE_REF/CLOSE/WAIT/
NOTIFY opcodes were subsumed by OFD refcounts + FS_* RPCs + the doorbell.

- Pipe buffers live kernel-side (they are rendezvous, not bulk data; 64 KiB
  cap, PIPE_ATOMIC=512 writes never split). If profiling ever says
  otherwise, a per-pipe SAB ring is a drop-in upgrade behind the same
  opcodes.
- Blocked readers/writers are deferred RPCs on per-pipe wait queues; any
  state change (write, read, close of an end) serves the queues and rings
  the waiters' doorbells. This is what the pre-kernel broker couldn't do —
  a cross-worker blocking pipe read had no wake path at all.
- EPIPE + SIGPIPE to the writer when the read side is gone (through the
  normal signal path — SIGPIPE at DFL kills `yes | head` pipelines the way
  scripts expect; a handler sees EPIPE + the pending bit).

## Exit and teardown — an ordered handshake

`CONFORMANCE-REMAINING.md` already records the symptom class: stdout
truncated at exit, detached queued chunks. Cause: exit is informal. Fix it
structurally:

1. libc `exit()`: run atexit handlers, flush stdio buffers (in-process, into
   the rings/store as normal).
2. `EXIT` RPC with the status code. The kernel: drains/final-flushes the
   process's output rings to the UI bridge, releases kernel-side resources
   (pipe ends → wake peers, tty attachment), marks ZOMBIE, sends SIGCHLD,
   bumps the parent's doorbell, THEN terminates the worker.
3. `_exit()` skips step-1 flushing, same handshake otherwise.
4. Abnormal end (trap/unhandled throw in the worker): worker's error handler
   reports if it can; the kernel's worker-exit observer covers the rest as
   termsig SIGSEGV-equivalent.

Exit ordering becomes testable: "parent's waitpid returns only after the
child's final output is visible" is a `tests/kernel/` assertion, not a race.

## Hard-kill resource cleanup (decision)

SIGKILL terminates a worker that gets no chance to close fds. Kernel-side
resources (pipes, tty, PCB) are bookkept and reclaimed fine. The gap is
process-side BlockFS state: open-refcounts are in-memory per-instance
(CLAUDE.md), so an unlinked-but-still-open inode in a killed process leaks
its blocks (nlink 0, nobody left to do the deferred free).

**Decision: accept the leak in v1.** It's bounded (only unlink-while-open
files, only on hard kill), `fsck.js` already detects exactly this class
(unreachable used blocks), and the honest fixes are all heavier: a kernel
shadow of every open fd would put the kernel in the open/close hot path;
an on-disk orphan list (ext4-style) is a BlockFS format change worth doing
only alongside other format work. Future mitigation, when wanted: orphan
list + boot-time sweep. Recorded here so nobody "fixes" it casually with a
broker round-trip per open().

## WM extension (reserved, not designed here)

Per `todos/OS.md` Phase 3, the compositor rides this same control plane:
`0x1xxx` opcodes for SURFACE_CREATE / SURFACE_PRESENT / input routing, with
surface pixel transport on per-surface SABs (rings pattern again). The
analogy is direct — focused surface : input routing :: foreground pgroup :
tty routing — and the kernel already owns both sides of it. Nothing in v1
should need rework for this; that's why the opcode space, the per-process
page, and the doorbell are designed process-generic rather than
terminal-specific.

## The fd/data-plane amendment (2026-07-06, todos/0009)

The original settled decision — "control plane only; fs data plane stays
in-process" — was validated for a world of ONE process (plus the netguc
dual-instance case, which is two instances cooperating in one thread,
serialized by the event loop). True multi-process breaks it three ways:

1. **OPFS handle exclusivity**: `createSyncAccessHandle()` locks the file;
   N process workers can't each open the store. The escape hatch
   (`mode: "readwrite-unsafe"`) is Chromium-only territory.
2. **True parallelism**: BlockFS metadata ops are multi-step RMW; the
   read-through invariant fixes staleness, not interleaving. Correctness
   would need a global cross-worker fs lock.
3. **SIGKILL tears ops**: worker.terminate() mid-metadata-op (or while
   holding that lock) corrupts or deadlocks the store.

Keeping the old rule for the OS would cost a locking protocol + crash
recovery + a portability gamble, and still leave the POSIX warts (no shared
open-file descriptions/offsets across spawn, cross-process
unlink-while-open freeing early, the SIGKILL fd leak, fd_action
translation). Emscripten reached the same conclusion for the same substrate
(WasmFS's OPFS backend proxies fs ops to one dedicated worker).

**Amended decision:** for the OS, the kernel owns a proper two-level fd
structure — per-process fd tables → system-wide open file descriptions
(offset, flags, refcount) → the ONE BlockFS instance, held by the kernel
worker (which is also why the kernel lives in a worker: SyncAccessHandle).
Process fs syscalls are RPCs on the existing kernel-page transport (raw-byte
payloads for read/write; JSON elsewhere). What this buys, in one move:
shared offsets on inherited fds, trivially correct fd_actions (the kernel
IS the parent's fd table), global unlink-while-open refcounts, no fd/inode
leak on SIGKILL, kill-proof metadata (the kernel completes every op), one
readiness source for select/poll across files/pipes/tty, and the Phase-1
"private fs per process" placeholder finally becomes a real shared
filesystem. The price is syscall latency (postMessage + park + SAB copy;
stdio buffering amortizes it, `Atomics.waitAsync` offers a pure-SAB upgrade
path) and kernel serialization — 0009 carries a benchmark gate so the cost
is measured, not assumed.

Scope note: this is two *transports* to one BlockFS implementation, not two
filesystems. Standalone single-program pages (doom.html, the Node CLI, the
unit-test harness) keep the in-process path and the live-stdin SAB exactly
as they are; the brokered path is the OS's. The in-process tty ring stays
for those pages; under the OS, tty reads become deferred kernel RPCs served
straight from the line discipline's cooked buffer.

## Testing (`tests/kernel/`)

The BlockFS suite is the model: example-based + adversarial, Node-only,
deterministic. Kernel + `host.js` workers run under `worker_threads` with a
`MemoryByteStore`; a scripted fake UI bridge feeds tty bytes.

- Lifecycle: spawn/exit status codes, zombie until reaped, SIGCHLD, orphan
  reparenting to pid 1, `waitpid(-pgid)`, WNOHANG/WUNTRACED/WCONTINUED.
- Signals: pending/blocked masks, delivery order, EINTR vs SA_RESTART on
  every blocking op (read, waitpid, sleep, select), SA_RESETHAND, uncatchable
  KILL, stop/cont round-trips, kill(-pgid) fan-out.
- TTY: canonical vs raw transitions, erase/kill/EOF editing, echo bytes,
  VINTR→SIGINT to fg pgroup only, SIGTTIN for background readers, tcsetpgrp
  handoff, SIGWINCH.
- Pipes: cross-worker blocking read woken by write, EOF on close, EPIPE +
  SIGPIPE, full-pipe writer blocking.
- Exit: output-complete-before-wait-returns ordering; hard-kill leak is
  *asserted* (fsck flags it) so the limitation stays visible and intentional.
- C-level: `tests/unit/` programs exercising signal(), pipe(), pgroups
  through the real libc against a live kernel.

## Implementation phases

1. **kernel.js skeleton**: process table + kernel page + RPC transport;
   re-implement today's spawn/wait/kill/compile semantics over it (parity —
   `tests/spawn/` keeps passing); Node + browser. DONE.
2. **Doorbell + signals + exit handshake**: SIGPEND/SIGBLOCK, safe-point
   dispatch in host.js's syscall layer, EINTR across all blocking ops,
   ordered teardown. (Fixes the exit-truncation bug class.) DONE
   (todos/done/0001).
3. **TTY object**: line discipline into the kernel, full termios, control-char
   signals, fg pgroup, SIGWINCH; UI bridge protocol for xterm pages. DONE
   (todos/done/0002).
4. **Job control + pipes**: setpgid/setsid/tcsetpgrp, stop/cont, SIGTTIN;
   pipe wait-queues + SIGPIPE. DONE (todos/done/0003; setpgid/getpgid RPCs
   exist kernel-side — the thin libc wrappers land with the shell port that
   needs them).
5. **Acceptance: the shell port** (`todos/OS.md` Phase 1) — busybox ash lands
   on this and `popen()`/`system()` light up. The shell is the integration
   test; if it needs a kernel workaround, the kernel design was wrong.

## Settled decisions (don't re-litigate without cause)

| Decision | Rationale |
|---|---|
| Separate `kernel.js`, owner-side; host.js stays process-side | Different cardinality (1/system vs 1/process); single-program pages stay lean; makes the kernel in-repo at all |
| Reference deployment: kernel in a dedicated worker; main thread is a dumb UI bridge | OPFS SyncAccessHandle is worker-only (seeding/fsck/orphan sweep need it); isolates control plane from rendering jank; module stays location-agnostic via injected createWorker |
| **AMENDED 2026-07-06**: for the OS, the kernel owns the fd table and serves the filesystem (see "The fd/data-plane amendment"); standalone single-program pages keep the in-process path | The original "fs stays in-process" rule predated true multi-process and doesn't survive it (OPFS handle exclusivity, parallel metadata races, kill-torn ops) |
| One doorbell futex per process; all blocking ops loop on it | Uniform EINTR; anything kernel-visible can interrupt any blocking call |
| Signal routing/defaults in kernel, handlers in process | Matches existing libc tables + `__on_sigdisp` mirror |
| Safe-point (syscall-entry) signal delivery; compute loops uncatchable in v1 | Zero preemption machinery; SIGKILL (terminate) is the backstop; `--signal-polls` is a future compiler flag |
| tty + line discipline are kernel objects; UI bridge is dumb | Only the kernel knows pgroups, so only it can turn VINTR into SIGINT |
| Pipe buffers + wait queues kernel-side | Rendezvous, not bulk; fixes the no-wake-path hole in the current broker |
| Exit is an ordered RPC handshake | Kills the stdout-truncation bug class structurally |
| Hard-kill BlockFS leak accepted in v1 (fsck-visible) | Honest fixes are format changes or hot-path brokering; not worth it yet |

## Open questions

- **Grace window** for DFL-terminate signals before hard worker.terminate —
  fixed (e.g. 2s)? Configurable? Immediate for non-interactive?
- **SIGCHLD coalescing**: POSIX allows coalescing pending same-signo signals
  (they're bits, not a queue). Fine for v1 (matches the bitmask design) —
  but confirm the shell's reaper loop is written for it (wait-until-ECHILD).
- **environ mutation**: `setenv` is currently read-only-ish; does the shell
  need kernel help for export semantics, or is it purely spawn-spec envp?
  (Likely the latter — note and verify during the port.)
- **Compile hook's future**: does `/bin/cc` stay a kernel RPC, or become a
  real spawned wasm once the compiler self-hosts into the image? (Cosmetic
  for this design; the opcode carries either.)
