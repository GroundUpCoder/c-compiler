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
shell-port acceptance gate — **PASSED** (`todos/done/0005`): busybox hush
runs as /bin/sh with zero kernel workarounds.

**Ptys are implemented** (`todos/done/0020`, brokered mode only): the
"pty pairs wait for a consumer" note below is retired — the consumer is
the WM's terminal app (`/bin/term`). `PTY_CREATE` (0x0106) returns a
master/slave fd pair; the SLAVE IS A FULL `Tty` instance (line
discipline, termios, ISIG fg-pgroup signal routing, and the deferred-read
machinery reused verbatim — read waiters moved from a kernel-global queue
to per-Tty `waiters` since many ttys now exist). The slave→master
direction is one pipe-shaped buffer (echo + OPOST/ONLCR-processed slave
writes; whole-or-block so an expansion never splits and the writer's
count stays pre-processed; `_streamRead`/`_pipeNotify` reused for master
reads/select). Master writes feed `tty.input()`. Termios/pgrp RPCs are
fd-aware (`_ttyForFd`: the fd resolves through the caller's fd table to
the tty it names; fd-less callers and ring mode fall back to the attached
tty). `TIOCSWINSZ` (0x0105) → winsize words + SIGWINCH. Spawn attaches
`pcb.tty` from the child's post-actions fd 0 (a slave fd 0 means the
child lives on that pty: ttySab/TIOCGWINSZ, control chars, SIGTTIN all
follow; first attach claims fgPgid — the terminal app spawns its shell
as a pgroup leader). Lifecycle: master close → SIGHUP to the pty's fg
pgroup, slave reads EOF, slave writes EIO (not EPIPE — pty semantics);
last slave ref gone (including via SIGKILL: kernel-owned fds) → master
reads EOF after drain. libc: `openpty()` in `<pty.h>` (`__openpty`),
`TIOCSWINSZ` in `<sys/ioctl.h>`; RemoteFS `openpty`/`setWinsize`.
Tests: `tests/kernel/test_pty.js` (SAB protocol), `test_pty_e2e.js`
(real C), `test_term_e2e.js` (the terminal app acceptance).

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
- `setpgid`, `getpgid`, `setsid`, `getsid` (0x000A, todos/0043 — pgrep
  wanted it), plus honoring the already-plumbed `POSIX_SPAWN_SETPGROUP`.

### /proc — the synthetic procfs (todos/0043, landed 2026-07-09)

`ProcFS` (kernel.js) renders the LIVE process table as a read-only volume
implementing exactly the fs-op surface MountFS routes to — no BlockFS
backing, no on-disk format, nothing for fsck. Embedders add
`'/proc': new ProcFS()` to their MountFS table; the Kernel constructor
scans the mounts and binds itself. Files are **Linux formats** (proc(5)),
so busybox ps/top/pgrep/pkill/uptime/free parse them unmodified:
`/proc/<pid>/{stat,status,cmdline,comm}` (zombies listed until reaped,
like Linux) + `uptime`, `loadavg`, `meminfo`, `stat`, `version`. Content
snapshots at open. Real: pids/ppid/pgid/sid, state (R / S=parked-in-RPC /
T / Z), comm+cmdline from spawn argv (pcb.argv/path/startMs carry them),
start_time and uptime from the kernel clock (`kernel._bootMs`), loadavg's
running/total + last-pid. Synthetic by design: utime/stime 0 (workers run
on their own OS threads — top's %CPU is boring), VmSize/VmRSS nominal
constants, meminfo a fixed plausible table (MemTotal must stay nonzero —
top divides by it). No `/proc/self`: fs ops carry a path, not a caller
pid. Writes: EROFS (mutators) / EACCES (write-mode opens);
`moduleKey` stays null so spawn never Module-caches from /proc.
Tests: `tests/kernel/test_procfs.js` (formats, snapshot, zombies, RPC
transport, GETSID), `test_os_boot.js` (busybox procps acceptance).

## The spawn path: compiled-Module cache (todos/0037, landed 2026-07-09; generalized to rw volumes by #188, 2026-07-30)

Every spawn used to re-parse + re-compile the binary in the process worker
(`new WebAssembly.Module(bytes)`) — each `ls` in a pipeline paid a full
compile of the multicall coreutils. Now the kernel compiles each binary
once and ships the `WebAssembly.Module` in the spawn message: Modules
structured-clone across workers (browser and `worker_threads`), sharing
the engine's compiled code; *Instances* don't clone — each process still
instantiates its own memory/imports. The shared Module is also what makes
warm spawns warm on JSC: the engine's JIT state follows the Module object,
so a bytes-path binary re-runs its init interpreted-cold on EVERY spawn
(the ~200 ms/spawn Safari cliff 0385 measured — the reason #188 exists).

- **Key**: the fs's `moduleKey(path)` (host.js; the 0037 `immutableKey`
  generalized). The owning volume after full symlink resolution (so
  `/bin/ls` → `/usr/bin/ls`) decides the kind:
  - **read-only volume**: `mountPrefix:ino` — contents can't change for
    the mount's lifetime, so immutability subsumes validation and there is
    no invalidation to get wrong (the 0037 policy, key-for-key); the inode
    dedupes the 75 coreutils applet symlinks into ONE entry.
  - **writable volume** (#188): `mountPrefix:ino:size:mtime` — a
    **validated** key, every term read through the store at each spawn. A
    rewritten binary (`cc -o a.out`, a gucman upgrade) derives a DIFFERENT
    key, so a stale Module can never be hit. The validation floor is the
    store's timestamp resolution (ms on v4) — unreachable in-OS, where
    every write→spawn→rewrite step is its own process costing well over a
    tick. One entry per spawned path: the kernel remembers the key a path
    last spawned under (`_modulePathKey`) and deletes the old entry when
    the derivation moves, so recompiles replace instead of leaking a dead
    Module per `cc -o`.
  - **synthetic volume** (ProcFS): no `moduleKey` hook → null → never
    cached.
- **Exclusions**: ss-flavored modules (they recompile from bytes with
  `importedStringConstants` in `runSsModule`), engine-rejected bytes (the
  worker owns the error report), tiers where Modules don't structured-clone
  (one-shot `structuredClone` probe), and kernels without an fs.
- **Transport**: `procSpec.module` (exactly one of `image`/`module` is
  non-null — a cache hit drops the multi-MB bytes clone too);
  `runModule({module})` skips its compile. Cache values are Promises, so
  racing spawns of one binary share a single compile.
- **Stats**: `kernel.moduleCacheStats()` → `{entries, hits, misses}`.
- Tests: `tests/kernel/test_module_cache.js` (policy over fake workers +
  a real worker_threads clone e2e + the in-OS recompile loop),
  `test_mounts.js` (moduleKey).

## The spawn path: shebang exec (todos/0065, landed 2026-07-10)

`_spawnBytes` peeks the loaded image before the WASM compile: bytes
starting `#!` re-dispatch to the interpreter line (`_spawnShebang`)
instead — `./foo` on a `#!/bin/sh` script, or a desktop double-click on
one, just works (the 0066 launcher primitive). Semantics follow
execve(2): interpreter path + at most ONE optional argument (the rest of
the line verbatim, no word splitting; 256-byte line budget à la
BINPRM_BUF_SIZE), re-spawned as `[interp, optarg?, scriptPath,
...origArgv[1:]]` — the script path replaces the caller's argv[0]; envp/
cwd/fd-actions/pgroup flags carry over unchanged. A relative interpreter
resolves against the child's cwd. Interpreter chains are allowed to
depth 4; past that (cycles) → `ENOEXEC` (the libc has no ELOOP). The
shebang check runs BEFORE `_moduleFor`, so scripts never touch the
module cache; non-`#!` bytes take the compile path exactly as before
(wasm's `\0asm` magic can't collide). hush has no ENOEXEC-fallback in
this build, so a rejected exec is a clean `can't execute` + exit 2.
Tests: `test_kernel.js` (parse/argv/depth legs over fake workers),
`test_os_boot.js` (hush acceptance: `./foo`, `#!/bin/sh -e`, cycle).

## strace — per-pid syscall-RPC trace (todos/0046, landed 2026-07-10)

The kernel brokers every syscall, so tracing is formatting, not
mechanism. `__spawn_spec` grew a `trace` field (spec-grows-by-field,
OS.md): a pipe WRITE-end fd in the *parent's* table, read by host.js
only under spawn flags bit1 (`__SPAWN_TRACE` — pre-growth binaries can't
set it by accident; bit2 `__SPAWN_TRACE_CHILDREN` = descendants inherit
the pipe, strace `-f`, every line `[pid N]`-prefixed). At spawn the
kernel takes its own ref on the write end, so the tracer's read end hits
EOF exactly at tracee teardown; the traced child gets CLOSE fd-actions
for both pipe ends from /bin/strace so it never holds them.

Per RPC: `_dispatchRpc` formats the request EAGERLY into
`pcb.trace.cur` (RAW payloads alias the kernel page — nothing may hold
them past the dispatch turn), and the line lands when `_respond`/
`_respondRaw` runs — deferred RPCs (parked reads, WAIT) trace at
completion, an RPC outstanding at death traces as `= <unfinished>`.
The decode table IS the `OP` map (`OP_NAMES`) — a new opcode traces by
construction. Extra lines: `--- SIGxxx ---` at `_deliver`, `+++ exited
with N +++` / `+++ killed by SIGxxx +++` at `_exitProcess`. The kernel
never blocks on the trace pipe: past-cap lines drop and the exit marker
reports the count. Flag off = one falsy check per dispatch/respond.

`/bin/strace [-f] [-o FILE] cmd args...` (`os/strace.c`) is plumbing:
pipe(2), `__spawn` with `trace`+flags, copy trace→stderr (or FILE),
waitpid, propagate status (128+sig for a signaled child). Tests:
`tests/kernel/test_strace.js` (protocol semantics over fake workers),
`test_strace_e2e.js` (the real binary in-OS).

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
0x00xx process   SPAWN WAIT KILL EXIT SETPGID GETPGID SETSID SIGDISP SIGMASK GETSID
                 SETITIMER GETITIMER (todos/0044 — ITIMER_REAL only, ms wire)
0x01xx tty       TCGETATTR TCSETATTR TCSETPGRP TCGETPGRP (all fd-aware
                 since 0020: the fd resolves to the tty it names) +
                 TIOCSWINSZ PTY_CREATE (0020 ptys; TIOCGWINSZ stays
                 a SAB read — no RPC for hot paths)
0x02xx pipes     PIPE_CREATE PIPE_REF PIPE_CLOSE PIPE_WAIT PIPE_NOTIFY
0x03xx misc      COMPILE (the existing /bin/cc hook); CLIP_SET/CLIP_GET
                 (todos/0090): ONE kernel-held clipboard slot {fmt, bytes}
                 — cross-process, survives the writer exiting (Win95
                 semantics: one slot, no history). fmt 1 = UTF-8 text;
                 the tag is there so CF_BITMAP/file lists (0092) can ride
                 later. Chunked through the 64KB page: SET is RAW
                 [u32 fmt][u32 last][u32 off][bytes...] staged per-pcb,
                 committed on last (a dying writer never tears the slot);
                 GET is JSON {fmt, off} -> RAW [i32 total][chunk], total
                 -1 = empty/format mismatch. Consumed via host.js
                 createClipboard (__clip_set/__clip_get imports) under
                 SDL_SetClipboardText/SDL_GetClipboardText; no kernel =
                 a process-local slot, the two-transports pattern.
                 Host bridge (ticket #79/0265): opts.onClipboard fires at
                 every SET commit (the slot's change signal — the choke IS
                 the event, no poll) and embedder Kernel.clipSet/clipGet
                 feed/read the slot from outside the process world WITHOUT
                 firing the hook (the bidirectional bridge's loop guard);
                 os.html mirrors fmt-1 text both ways via the async
                 Clipboard API (focus-triggered host reads).
0x04xx fs        the brokered filesystem (fd/data-plane amendment below).
                 FS_WATCH_OPEN 0x0422 (ticket #75) is file watching as a
                 new OFD kind: {path, mask, flags} -> a PATH-KEYED watch
                 fd — one watch per fd, close is removal. Every runtime
                 mutation flows through the _fsRpc choke with the path as
                 a string, so watches key on the lexically-canonical path
                 (events carry names; a rename is ONE record with both
                 names; an editor's tmp+rename-over save lands
                 FSW_CLOSE_WRITE on the watched path and the watch
                 SURVIVES — the inotify per-inode trap is structurally
                 absent). The settled write (FSW_CLOSE_WRITE) fires at a
                 dirty open-file-description's LAST release or a
                 rename-onto; FSW_MODIFY (per-write chatter) is opt-in.
                 Readable via the normal FS_READ (packed fsw_event
                 records, os/fswatch.h MUST MATCH kernel.js's FSW table;
                 EAGAIN when dry — WAIT-first contract), readiness via
                 the ordinary _selectScan branch (FS_SELECT/FS_WAIT — no
                 new blocking mechanism). Overflow = clear + latch one
                 FSW_OVERFLOW (consumer rescans); the kernel never blocks
                 a mutating RPC on a slow watcher. flags reserved
                 (FSWF_RECURSIVE spec'd as a watch-path prefix compare;
                 EINVAL until the first consumer wires it)
0x05xx sockets   SOCK_SOCKET/BIND/LISTEN/ACCEPT/CONNECT/PAIR/SHUTDOWN —
                 AF_UNIX control plane (todos/0008; data plane rides
                 FS_READ/FS_WRITE/FS_CLOSE/FS_SELECT, see below)
0x1xxx WM        SURFACE_CREATE/DESTROY/SET_TITLE/CONFIGURE (todos/WM.md;
                 present is deliberately NOT an RPC — pure SAB flip/seq,
                 mailbox; 0x1004 reserved should damage tracking ever want
                 one; CONFIGURE = the client's resize ack, todos/0019)
0x2xxx audio     AUDIO_OPEN/AUDIO_CLOSE (todos/0017; WM.md "Audio mixing" —
                 PCM rides the source-ring SABs and the one page-owned
                 output ring, never RPCs); AUDIO_GAIN (todos/0048): master
                 output gain in percent 0..200, gain<0 queries — applied in
                 audioPump before the clamp, system-wide by design (the
                 control panel's volume slider, via host.js __audio_gain)
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

### Interval timers (todos/0044, landed 2026-07-09)

`alarm`/`ualarm`/`setitimer`/`getitimer(ITIMER_REAL)` → SIGALRM: ONE
kernel-side real-time timer per process (`pcb.itimer`, a `setTimeout`),
expiry posts SIGALRM through `_deliver` — disposition mirror, blocking,
and the DFL-terminate action all behave like any other signal, and
delivery stays cooperative (safe points; the compute-loop caveat above
applies to SIGALRM too). Wire ABI is milliseconds over SETITIMER/GETITIMER
(0x000B/0x000C); the libc owns timeval↔ms conversion and rounds nonzero
sub-ms UP so an armed timer never converts to "disarmed". `it_interval`
reloads from "now" at each expiry (setTimeout latency never accumulates a
SIGALRM backlog — one SIGPEND bit is all the SAB represents anyway).
Wall-clock: a STOPPED process's timer keeps running (POSIX), the pending
bit delivers after SIGCONT. Not inherited across spawn; cleared at exit.
`ITIMER_VIRTUAL`/`ITIMER_PROF` → EINVAL, documented — workers run on their
own OS threads, so there is no per-process CPU accounting to back them.
Without a kernel, `__setitimer`/`__getitimer` are ENOSYS stubs (alarm
returns 0 and the timer never fires — POSIX alarm has no error return).
Tests: `test_kernel.js` (SAB-protocol legs), `test_itimer_e2e.js` (the
classic alarm-EINTRs-a-blocked-read idiom, interval reload, cancellation,
ualarm, DFL termination — real C under a live kernel).

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
  back out the UI bridge. Leaving canonical mode mid-line flushes the
  un-terminated edit buffer to the readers (Linux n_tty semantics; 0171 —
  stranding it split any typed line that straddled a shell's cooked window
  and its line editor's raw switch), and `TCSAFLUSH` discards queued input
  in BOTH transports (ring and brokered cooked queue).
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
- `TIOCGWINSZ` stays a SAB read (`SI_COLS/ROWS` today), no RPC. Per-process:
  the SAB handed to a worker is its ATTACHED tty's (fd 0 at spawn — a pty
  slave means the pty's SAB), so a later `open()` of a different tty would
  read the wrong winsize — accepted v1 limit, nothing opens ttys by path yet.
- ~~One tty in v1 ... pty pairs wait until something needs them~~ — pty
  pairs landed with their consumer (`todos/done/0020`, the WM's terminal
  app; see the Status paragraph at the top for the shape). Still waiting
  for a need: `/dev/tty`, tty nodes in the fs namespace, sessions beyond
  the PCB fields.

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

## AF_UNIX sockets (implemented, todos/done/0008)

Sockets are the pipe machinery, twice. A connection is a PAIR of pipe-shaped
directions (`{buf, cap, rOpen, wOpen, readWaiters, writeWaiters}` — the
exact pipe fields); a connected 'socket' OFD holds `rx`/`tx` pointers into
the pair, crossed between the two ends. `_streamRead`/`_streamWrite` (the
factored-out pipe read/write bodies) serve both kinds, waiters register
under the pipe op names, and `_pipeNotify`/`_cancelWaiter`/select needed
only kind-dispatch additions. What's genuinely new:

- **Rendezvous**: `bind` creates a real S_IFSOCK node in BlockFS (generic
  `mknod` — no format change; `open()` on one is ENXIO) and registers the
  resolved path in a kernel map. `connect` resolves through the fs (so
  unlink → ENOENT, non-socket → ECONNREFUSED, symlinks work), then looks up
  a LISTENING OFD (else ECONNREFUSED). Rebind-after-unlink replaces the map
  entry; the old listener drains dead.
- **connect never blocks** (v1): a connection within the backlog is queued
  with usable buffers — client writes land before accept. Over-backlog is
  ECONNREFUSED, and the socket stays fresh for retry. A parked `accept` is
  served directly by the arriving connect (and is EINTR-interruptible like
  every deferred RPC).
- **shutdown** is connection-global (close is per-reference): SHUT_WR marks
  the tx direction writer-gone (peer EOF, own writes EPIPE), SHUT_RD the rx
  reader-gone (peer writes EPIPE).
- **socketpair** is two crossed conn OFDs, no rendezvous.
- **libc**: `<sys/socket.h>`/`<sys/un.h>` marshal sockaddr_un to plain-path
  `__sock_*` imports; send/recv are write/read (flags: MSG_NOSIGNAL
  accepted but SIGPIPE still fires; the rest EOPNOTSUPP); AF_UNIX +
  SOCK_STREAM only, validated libc-side (EAFNOSUPPORT/EPROTONOSUPPORT).
  poll/select ride `FS_SELECT` (listener ready ⇔ pending connection; conn
  ready ⇔ data or peer-gone).
- Brokered mode only, like PIPE_CREATE — plain BlockFS answers ENOSYS
  (standalone pages have no second process to call).

Deliberately NOT in v1 (recorded so nobody trips on them): SOCK_DGRAM /
SEQPACKET, the abstract namespace (EOPNOTSUPP), SCM_RIGHTS fd passing,
O_NONBLOCK socket I/O, MSG_PEEK, blocking-until-accept connect. AF_INET is
a separate future item (needs a WebSocket/WebTransport relay — OS.md
Phase 4).

### Kernel-owned endpoints (todos/0014)

`sockServe(path, onConnect)` makes the KERNEL a native socket peer: it
plants the S_IFSOCK node and registers the path; a process `connect()`
rendezvouses there ahead of `_sockBinds` and yields a kernel-side `peer`
object instead of queueing on a listener. Same crossed pipe-pair as any
connection — the client blocks/selects/EOFs through unchanged machinery —
but the kernel never parks: arriving bytes fire `peer.onData` via a
`drain` hook in `_pipeNotify`, peer-gone fires `peer.onClose` once, and
`peer.send()` ignores the direction cap (trusted system peers; megabyte
replies buffer whole, the client reads in chunks). First user: the WM
protocol server on `/run/wm.sock` (framed spec: the `WMP` block in
kernel.js; MUST MATCH `os/wm_proto.h` + `tests/kernel/test_wm_policy.js`).
Since todos/0168 `peer.send()` also KICKS the client's input ring
(`_wmKick`): a client parked in `__sdl_pump_wait` (SDL_WaitEvent) wakes
promptly on kernel-peer data instead of sleeping out its park chunk past
a WMP event (`tests/kernel/test_sockwake_e2e.js`). The kick pushes a
TYPE-0 RING RECORD (all-zero; drainInput counts-and-skips it), not a
bare `Atomics.notify` — a notify on an unchanged word is LOST if it
lands between the parker's last ring check and its `Atomics.wait` entry,
and 0169's frame-idle post at pumpWait entry widened that window enough
for wm.c to sleep out EV_CREATED for a full 1s chunk
(test_wm_service_e2e's placement legs caught it). With the record,
WPOS — the futex word — changes, so the parker either drains a non-empty
ring at entry or its wait resolves. Since todos/0178 the kick serves the
raw-futex tier only: a client parked in the unified WAIT (or a plain
select) is woken by its RPC completion — `peer.send()` captures the
waiter kind before notifying and skips the kick for fd-parked clients,
so wm.c (a WAIT parker since 0178; its pre-park select and the
lost-wakeup era are retired) gets exactly one wake per event.

`Kernel.service(spec)` spawns kernel-owned service processes (the /bin/wm
autostart): parentless (ppid 0), own session, auto-reaped on exit —
`_exitProcess` reaps ppid-0 zombies since no one will ever wait on them.

### What may leave the kernel — the single-writer rule (2026-07-14)

The expensive part of a syscall in this system is the cross-WORKER hop
into the single-lane kernel event loop (head-of-line behind compiles/fs),
NOT the wasm→JS import — host.js is process-local and imports cost
nanoseconds. Our cost profile is a paravirtualized guest's (VM-exit-
shaped), and the industry answer there is virtio's: data planes and
high-frequency signals in shared memory with SUPPRESSED doorbells;
control plane through the server. The kernel's single-threadedness is
the correctness architecture (zero locks; the BlockFS read-through/
dual-instance-fuzzer history shows what shared mutation costs), so the
bright line for moving work out of the RPC path is:

**Single-writer or immutable ⇒ eligible to leave the kernel. Multi-writer
⇒ never.**

Sanctioned forms (queue items in parens):
- **Publish, don't serve** — seqlock vDSO page for kernel-written,
  process-read state; the `KP_*` words are the existing ad-hoc version
  (todos/0179, landed 2026-07-14): a 12-word tail block on the kernel page
  (`KP_VD_*`, layout comment in kernel.js) behind ONE seqlock word — the
  kernel bumps odd → stores → bumps even at spawn/SETPGID/SETSID/reparent/
  wmSetScreen; `KernelClient._vdsoRead` retries on odd or moved seq and
  falls back to the RPC (still the source of truth) after a bounded spin.
  Zero-RPC now: getpgid(0)/getpgrp/getsid(0)/self-pid variants, getppid
  (LIVE — tracks orphan reparenting, which the spawn-time static never
  did), uptimeMs (published boot instant), screen dims. Foreign-pid
  queries still RPC. libc grew setsid() alongside (the RPC existed since
  Phase 1; nothing declared it C-side). Tests: `test_vdso.js` (the wedge →
  fallback + fan-out legs), `test_vdso_e2e.js` (an RPC-op counter proves
  zero GETPGID/GETSID across the mutations).
- **Immutable data serves itself** — the sealed /usr volume read
  process-side by host.js's own BlockFS reader (todos/0180, landed
  2026-07-14): the embedder copies the baked image into ONE SAB
  (`BLOCK_FS.storeToSab`) and hands it to `Kernel({roImage: {prefix:
  '/usr', sab}})`; every spawn forwards it and the worker mounts it
  locally (`SabByteStore` + `createV4 readonly` — getBytes copies out
  since TextDecoder rejects SAB views). RemoteFS serves absolute paths
  lexically under the prefix in-process — zero RPCs for the chattiest
  startup traffic (`strace cat /usr/share/os-release` is now just
  FS_WRITE + EXIT); measured 496→1345 MB/s reads, 71k→602k open+read+stat
  ops/s (bench_fs.js RO leg). Correctness rules (full list in the
  RemoteFS header comment): cross-volume symlink escapes (`/usr/local` →
  `/var/local`) abort the local walk via the MountFS `__mountEscape`
  hooks and retry brokered; write-intent opens and all mutators stay
  brokered (the kernel owns EROFS-after-the-walk, todos/0040); relative
  paths stay brokered (the kernel owns the cwd); local errors are final
  (the sealed volume is complete). Local fds live at `RO_FD_BASE`
  (0x100000) and cross into the kernel table only by PROMOTION — a
  temporary brokered O_RDONLY twin at the same offset — at dup2-to-low-fd
  and spawn DUP2 file-actions (hush's `cmd < /usr/...` vfork journal:
  pv_open3 really opens in the parent, so the journaled dup2 names a
  local fd). Documented limits: a local fd not named in a spawn action is
  effectively close-on-exec; select/WAIT can't name one (the number
  exceeds FD_SETSIZE — regular files are always ready anyway). Tests:
  `test_rofs.js` (fast-path mechanics vs a fake RPC recorder),
  `test_rofs_e2e.js` (real C, zero-fs-RPC acceptance + mixed-workload
  identity + the promotion feeding a child's stdin).
- **SPSC data planes** — one-producer/one-consumer rings (input ring,
  audio rings, framebuffers; pipes since todos/0181, landed 2026-07-14):
  kernel only for wakeups and arbitration when the SPSC precondition
  breaks. Pipes: `RemoteFS.pipe()` allocates a 256K ring SAB and posts it
  ahead of PIPE_CREATE (the audio-sab handshake); the ring is the pipe's
  buffer IN EVERY MODE (the kernel's own stream ops read the same ring
  via the `_pipeAvail/_pipeTake/_pipePut` accessors — deliberately NO
  demotion drain and no locks: a drain would race a mid-flight fast
  reader into double-delivery), and the kernel-owned PR_MODE word walks a
  one-way ladder: LATENT at create → FAST when a holder REMOVAL leaves
  one process per end (the hush pipeline promotes at the parent's
  post-spawn closes; self-pipes never promote — a create-time promotion
  would be demoted by the very spawns that build the pipeline, burning
  the ladder; documented limit) → DEMOTED when spawn inheritance adds a
  second holder (the ONLY holder-adding event). Every flip happens while
  the only process that could fast-op the flipped role is parked in the
  flipping RPC — that is the whole correctness story: at most one
  producer + one consumer touch a ring at any instant, and a stale mode
  read is never wrong, only slower (the kernel serves brokered ops on a
  FAST pipe from the same ring). FAST ends memcpy + commit locally (zero
  data RPCs: the 8MB e2e pipeline runs FS_READ=0/FS_WRITE=4 vs ~280
  brokered; bench 272→443 MB/s) and block via the 0178 WAIT naming the
  fd; the kernel raises PR_RWAIT/PR_WWAIT BEFORE its readiness rescan
  (cleared at `_cancelWaiter`, the one wake choke point) and a fast
  commit that reads the flag rings the PIPE_KICK doorbell — flag-then-
  rescan vs commit-then-check cross under SC atomics, so a wake can be
  redundant but never lost (the 0168 lesson, structural). Close/exit stay
  brokered and latch PRF_RGONE/WGONE in the ring: fast EOF is local,
  fast EPIPE rides PIPE_KICK{epipe:1} so the kernel deals the writer its
  SIGPIPE. procSpec.pipeRings ships the SAB to children at their
  post-action fds (the PR_MODE word, not process-local knowledge, gates
  fast ops); strace's write-end ref is a kernel pseudo-holder (pid 0,
  attached BEFORE spawn fd-actions) so traced pipes never promote and
  every byte stays trace-visible; select()/FS_WAIT needed no fallback —
  `_selectScan` reads ring occupancy directly. Layout: the PR_* comment
  block in kernel.js. Tests: `test_pipes_spsc.js` (mechanics, no wasm),
  `test_spsc_e2e.js` (RPC-op counter, SIGPIPE identity, mid-stream
  demotion byte-identical).
- **Waits**: two tiers by rule — raw SAB futex for single-source waits
  (vsync, sleeps, the input ring); the kernel WAIT RPC (todos/0178) is
  the ONLY place a process may sleep on multiple sources. Nobody
  hand-rolls a multiplexer (the 0168 kick + pre-park-select races are
  the cautionary tale).

The general form — userland executing mutating ops against shared kernel
structures — is an SMP kernel with locks in every table. Rejected;
re-litigate only with a written design that prices the whole correctness
story.

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

## HTTP transport (0x06xx; implemented, todos/0172; fd-shaped, todos/0417)

Processes get HTTP(S) through the kernel, backed by the **embedder's
`fetch`** (the browser kernel-worker global; Node ≥18's global under
boot.js). The kernel owns the network; processes reach it via three 0x06xx
RPCs plus the ordinary fd layer. TLS comes free from the fetch stack. This
is deliberately **not a socket layer** — the browser cannot do raw TCP, so
a socket-shaped API would be a lie; fetch-shaped is forced by the platform.
First consumer: the libcurl veneer (todos/0173); the primitive is also the
substrate for any future networked port (git's HTTP transport, an SSE
agent client).

The wire format is a **private contract** between kernel.js and host.js
(both in-repo, version-locked) — refactorable at will; only the semantics
leak, so those are what's pinned:

- **A transfer IS an open file description** (kind `http`, the FS_WATCH
  precedent — todos/0264). `HTTP_BODY` stages an optional request body
  (RAW `[u32 off][bytes...]`, contiguous like `CLIP_SET`); `HTTP_OPEN`
  (JSON `{method, url, headers[], headersMs, idleMs}`) consumes it, kicks
  off the fetch, and returns `{fd}` **at once** (non-blocking). The fd
  joins `FS_SELECT`/`FS_WAIT` beside pipes, watches and the input ring —
  any number of transfers multiplex through ONE wait. `FS_CLOSE` releases
  it; the LAST release aborts the fetch (`_ofdUnref` → `_httpDestroy`),
  so process teardown is just `_exitProcess`'s ordinary fd sweep — no
  dedicated transfer sweep exists. 0x0604 (`HTTP_READ`) and 0x0605
  (`HTTP_CLOSE`) are retired, never reused.
- **Readable iff a CONSUMABLE is pending** (`_selectScan`'s mandatory
  `http` branch): the status arrived AND no `HTTP_STATUS` call consumed it
  yet; body bytes are queued; the stream ended cleanly; or the transfer
  failed. The `statusConsumed` bit is load-bearing — headers-arrived is a
  PERMANENT condition, and without the bit a caller that consumed the
  status and waits for the first body byte spins (wait → read → EAGAIN →
  wait). The `done`/`error` legs stay permanent on purpose: a pipe at EOF
  is also readable forever, and 0 bytes (or the error) is the honest
  answer.
- **`HTTP_STATUS` (JSON `{fd}`) is non-blocking** and consumes the status:
  EAGAIN before headers, `{status, headers}` after (a flattened
  `name: value\n` blob; order/casing are whatever fetch yields — NOT
  wire-faithful, documented). **The body drains through `FS_READ`, which
  NEVER parks on an http fd**: bytes when queued, 0 at clean EOF, the
  error when failed, EAGAIN when dry — http fds are inherently
  non-blocking like watch fds. The reason is load-bearing: `__wait` does
  not name the ready fd (waitMulti returns only `why`), so a woken caller
  finds the ready transfer by trying, and try-read-until-EAGAIN is that
  discipline. Consumer contract (the fswatch shape): WAIT on the fd; on a
  wake consume the status if you have not, then read until EAGAIN, then
  re-wait. A consumer that refuses to consume its pending status spins —
  the caller's bug, named in host.js's `createHttp` doc and the compiler
  prelude.
- **Two kernel deadlines bound every transfer** (todos/0417): a HEADERS
  deadline (response headers must arrive within it; default
  `HTTP_HEADERS_MS` 30s, `headersMs` overrides, never disableable) and an
  IDLE deadline (the body must deliver a byte within it; default
  `HTTP_IDLE_MS` 120s, `idleMs` overrides, `idleMs < 0` disables — an SSE
  stream is legitimately silent). The idle clock runs only while the
  kernel is actually waiting on the network — a backpressure pause stops
  it. Expiry aborts the fetch and fails the transfer with **`ETIMEDOUT`**
  (distinguishable from a connect error's EIO and from clean EOF); the
  error is a consumable, so a parked waiter wakes and reads it. NB
  `CURLOPT_TIMEOUT` does NOT map here: it is a whole-operation cap, which
  neither deadline expresses — the veneer enforces it on its own wall
  clock through `__wait`'s timeout (`CURLOPT_CONNECTTIMEOUT` → the
  headers deadline).
- **Streaming body with backpressure.** The body queues kernel-side as a
  chunk list (`xfer.chunks`, `xfer.bytes`); the async fetch reader **pauses**
  (stops calling `reader.read()`) once `xfer.bytes >= HTTP_BUF_CAP` (256K)
  and resumes when an `FS_READ` drains below it. Bounded kernel memory
  regardless of network-vs-consumer speed — the same discipline as pipes,
  and proven live in `test_http_e2e.js` (512K body over the real stack).
- **EOF vs error are distinct.** A clean stream end is an empty `FS_READ`;
  a connect failure surfaces on `HTTP_STATUS` (before headers), a
  mid-stream drop on `FS_READ` (after some bytes) — both carry the error
  string for `curl_easy_strerror` fidelity (`RemoteFS.read` logs it; the
  ticket-#78 visibility rule).
- **Needs both halves.** `fetch: null` at construction disables network
  entirely, and a no-fs kernel has no fd table for a transfer to live in —
  either way `HTTP_OPEN` → ENOSYS (standalone pages stay offline).
- **The embedder's fetch may be a wrapper** (ticket #349, NETWORK.md
  Tier 2.5: the OS embedders pass os-common's `createNetFetch`, which
  reroutes through the localhost bridge when the `net` cfgstore setting
  is on — OFF tail-calls the bound global fetch untouched). A rejecting
  wrapper may pin a POSIX errno NAME on the rejection as a string
  `err.errno` — `_httpStart` honours it (the bridge wrapper's
  configured-but-unreachable ENETUNREACH; ruling in NETWORK.md Tier 2.5).
  ENOSYS above stays the NO-CAPABILITY answer; Node system errors carry
  numeric `.errno` and keep the documented EIO mapping.
- **No policy in v1.** Any process may fetch any URL (the browser flavor is
  already CORS-constrained by the platform). The kernel choke point is
  where per-process policy would land later — a reason FOR brokering, not
  v1 scope.

Request bodies are whole-buffer in v1; streaming uploads (fetch
`duplex:'half'`, Chromium-only) and WebSockets (todos/0440) would be NEW
OFD/op kinds added alongside, not changes to these. host.js's `createHttp`
surfaces the C primitive (`__http_open/__http_status`; body via `read(2)`,
teardown via `close(2)`); the veneer maps `curl_easy_perform` onto open →
wait/status (feeds HEADERFUNCTION) → wait/read loop (feeds WRITEFUNCTION)
→ close. Tests: `test_http.js` (fake worker + fake fetch, every path
deterministic — readiness legs, both deadlines, multiplexing, close-abort)
+ `test_http_e2e.js` (real C, Node fetch, local server — one `__wait` over
two transfers and over a transfer ⊕ pipe, the statusConsumed park, both
deadlines, server-visible close-abort).

## WM extension (designed: `todos/WM.md`, 2026-07-07; WM client landed, todos/0014)

Per `todos/OS.md` Phase 3, the compositor rides this same control plane:
`0x1xxx` opcodes for SURFACE_CREATE / SURFACE_PRESENT / input routing, with
surface pixel transport on per-surface SABs (rings pattern again) or
GPU-side bitmap handoff — the full design (backend × transport axes,
kernel-worker compositing, WM-as-client over AF_UNIX) lives in
`todos/WM.md`. The analogy is direct — focused surface : input routing ::
foreground pgroup : tty routing — and the kernel already owns both sides of
it. Nothing in v1 needed rework for this; that's why the opcode space, the
per-process page, and the doorbell are designed process-generic rather than
terminal-specific. With 0014, WM POLICY moved out to `/bin/wm` over the
kernel-owned `/run/wm.sock` endpoint (see "Kernel-owned endpoints" above);
`/bin/wmctl` is just another protocol client — no new opcodes were needed.
0068 added the one owner-initiated surface op since: `SURFACE_RESIZE`
(0x1007, SDL_SetWindowSize) — a process resizing its OWN window (Win32
apps size to content), reusing the 0019 WINDOW_RESIZED → SURFACE_CONFIGURE
renegotiation and deliberately not gated on the resizable bit (that bit
protects fixed-size apps from the WM, not from themselves).

## The ksvc service seam — the kernel's C half (2026-07-22, todos/0275)

ksvc is the kernel's C half: capabilities the kernel needs that are best
written in C land as new `__export`s on ONE growable blob
(`os/ksvc/ksvc.c` → `/usr/lib/ksvc.wasm`, built at bake time by our
compiler like any manifest `project` entry), loaded once per boot by the
embedder via `OS_KSVC.load(kfs)` (`os/ksvc.js`) and reached synchronously
through `kernel.textService`-style handles. First capability: label TEXT
(FreeType + fontchain.h) — compositor.js `labelFor` and the headless
`wmScreenshotScreen`/`_blitLabel` render titles, the close `'x'` and
Exposé captions from the SAME blob, so the two composites agree on text
byte-for-byte. Rules:

- **No process, no pcb, no RPC** — same-thread sync calls only; blob
  memory is the interchange (staging via `ksvc_buf`, results as
  pointer+header with documented lifetime: valid until the next call).
- **The import env is explicit and minimal** (os/ksvc.js): read-only fs
  over `kfs` (write-intent opens are EROFS'd before reaching the fs),
  fd 1/2 `write` forwarded to the boot log, a `%s`-grade vsnprintf
  mini-formatter, loud named traps on everything else. It grows
  import-by-import with capabilities, never speculatively — a new blob
  import the env lacks throws AT INSTANTIATION, naming the import.
- **`ksvc_abi` gates JS↔blob pairing**; breaking ABI changes bump it in
  the same commit as the wrapper.
- **Load failure at OS boot is a boot error** (kernel-worker `boot-error`,
  boot.js nonzero exit), never a degraded desktop — the Canvas2D label
  path is deleted, not gated. A bare `Kernel` without `opts.textService`
  (non-OS embedders, unit tests — no fs to read a font from) composites
  textless chrome: capability absence, not a fallback renderer.

Design + ABI details: `todos/0275-kernel-text-service-design.md`.

## The vsync broadcast (2026-07-10, todos/0100)

Process workers are NESTED workers (kernel-worker spawns them), and
Chromium's `requestAnimationFrame` throws `NotSupportedError` there — so
SDL frame loops historically paced off a host.js `setTimeout` fallback,
wall-clock and unsynchronized with the compositor that samples their
presents. But the kernel worker is first-level and already runs the one
real frame clock (the compositor rAF, todos/0055). 0100 exports it:

- Four tail words on the kernel page (see the layout comment in kernel.js —
  the payload cap stops 64 bytes short of the page end since todos/0179
  grew the tail to 16 words: these four vsync words plus the 12-word
  seqlock vDSO block below them): `KP_VSYNC_EN`, set once at
  spawn when the kernel was built with `Kernel({vsync: true})`;
  `KP_VSYNC_SEQ`, a tick counter; and — since todos/0169 (the on-demand
  compositor, IDLE-POWER piece B) — `KP_VSYNC_ARMED`, a vsync-waiter count
  the process side adds to BEFORE parking on the seq word and subtracts on
  resolve, and `KP_COMP_PARKED`, the compositor-parked flag the process
  side re-reads AFTER publishing ARMED or a present's `WMSH_SEQ` bump,
  posting `{type:'want-frame'}` when set. ARMED/PARKED are a Dekker pair:
  the compositor stores PARKED on every pcb page FIRST, then re-reads every
  ARMED/wantFrame/seq (seq-cst atomics — a lost waiter or lost present is
  impossible). Kernel-side, `pcb.wantFrame` pins the compositor armed: set
  by the want-frame doorbell, cleared ONLY by `{type:'frame-idle'}`
  (host.js's pumpWait entry, gated on a present since the last idle) and by
  process exit. `compSetParked()`/`compKeepAlive()`/`wmOnDamage()` are the
  kernel half of the protocol; every `_wmVersion` bump routes through
  `_bumpWm()` → the damage hook. Spawn stamps KP_COMP_PARKED on the new
  page when parked (the KP_VSYNC_EN precedent).
- `kernel.vsyncTick()` — called by the embedder from its frame clock (the
  compositor's `draw()`, before anything can early-return) — bumps + notifies
  the word for every live pcb.
- `KernelClient.vsyncWait()` parks on the word (`Atomics.waitAsync`),
  tracking the last-delivered seq so ticks that land mid-frame-callback
  resolve immediately (rAF catch-up semantics). host.js's surface backend
  exposes it through the spawnHooks seam as the backend's
  `requestAnimationFrame` — BOTH flavors (the browser flavor since
  todos/0167, IDLE-POWER Stage 1); the frame-loop driver needs no change.
- Headless embedders (boot.js, kernel tests) never pass `vsync`, so the
  flag stays clear and processes keep the deadline-setTimeout pacer — the
  only possible tier where no vsync exists. Two pacing tiers, one seam.

Lifecycle is deliberately **stop-when-the-clock-stops**: a hidden tab
stops rAF, so every SDL app parks at its next frame boundary — an honest
pause with zero pause code. Consequences: cooperative signal delivery to
a parked frame loop defers until the next tick (SIGKILL is unaffected —
worker termination); an app that calls SDL_Quit right before the clock
stops finishes its exit handshake on the next tick. A ctlpanel toggle to
switch the kernel's tick source to a `setInterval` heartbeat
(keep-running-when-hidden) is queued follow-up work.

## The fd/data-plane amendment (2026-07-06, todos/0009)

The original settled decision — "control plane only; fs data plane stays
in-process" — was validated for a world of ONE process (plus an embedder's
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
as they are; the brokered path is the OS's. (Since todos/0026 the OS's
kernel-side fs object is a host.js MountFS over two BlockFS volumes —
`/` system, `/root` user; same method surface, so the kernel is oblivious.) The in-process tty ring stays
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
- Interactive job control (`test_jobctl_tty_e2e.js`, via boot.js
  --tty-out + hush): Ctrl-Z→jobs→fg roundtrip where the resumed reader
  CONSUMES new input, `cat &` SIGTTIN-stop, `kill %1` on a stopped job.
  Serve-time eligibility in `_ttyNotify` (stopped waiters consume nothing;
  late-backgrounded waiters get SIGTTIN) exists because this test caught
  a stopped `cat` stealing the shell's input
  (`logs/2026-07-07/jobctl-tty-e2e.md`).
- Pipes: cross-worker blocking read woken by write, EOF on close, EPIPE +
  SIGPIPE, full-pipe writer blocking.
- Sockets (0008): the same protocol-level suite (`test_sockets.js` — state
  errors, rendezvous lifecycle incl. rebind-after-unlink and listener-close
  fan-out, backlog, deferred accept, EINTR, shutdown, socketpair, dup
  refcounts, SIGKILL-while-parked, OFD-leak baseline) plus a real
  client/server C pair (`test_sockets_e2e.js` — parked accept woken by
  connect, poll/select, stage bitmasks in exit codes).
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
5. **Acceptance: the shell port** — PASSED (todos/done/0005): busybox hush
   landed on this kernel with ZERO kernel workarounds (the port's patches
   are all shell-side: the vfork journaling shim + libc gaps it exposed —
   `_exit`, real `fcntl(F_DUPFD)`, setpgid wrappers, the tty-fd gate).
   `popen()`/`system()` lit up as written. Pipelines, `$( )`, here-docs,
   job control, interactive line editing all ride Phases 1–4 unchanged.
6. **AF_UNIX sockets** (todos/done/0008): the 0x05xx control plane over the
   pipe machinery — see "AF_UNIX sockets" above. First consumer of the
   claim that new OFD kinds are cheap post-0009; it held (the data plane
   needed only kind-dispatch branches).

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
