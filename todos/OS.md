# A WebAssembly-native OS in a browser tab

## Goal (repo north star)

A full-fledged, almost-POSIX environment with a GUI and window manager that is
**WebAssembly native**: every binary is a real wasm module produced by this
compiler, running well as wasm — not an emulation of some other machine. It
should feel like a complete OS living in a browser tab, with persistence.

The core is the compiler (`compiler.js`), which targets C89/99/11/23 standards
compliance plus the POSIX surface plus selected gcc/clang (and eventually msvc)
extensions. Everything else in the repo serves that goal: `host.js` is the
kernel-ish layer, BlockFS is the disk, vendored ports are the userland.

"Almost POSIX" is deliberate: `fork()` is the one POSIX primitive we do not
plan to implement faithfully (see the decision below). Everything else is fair
game.

## Non-goals

- **Not an emulator.** tinyemu booting Linux is a compiler stress test, not the
  product. The product is native wasm binaries against a native wasm kernel.
- **Not a Linux ABI.** We own the libc (it lives inside `compiler.js`), so we
  can shape the syscall surface to fit the substrate instead of translating a
  foreign one. Ports get patched at the source level, like any new Unix.
- **Not multi-user (for now).** Single root user; uid/gid plumbing exists in
  stubs (`getpwnam` returns root) and can grow later if ever needed.

## Decision: posix_spawn is the process primitive, not fork/exec

**Status: decided. Don't re-litigate without new evidence.**

The process model (already implemented — `host.js` `createSpawn`,
`compiler.js` `<spawn.h>`/`<unistd.h>`) is *owner-brokered spawn*: the host
(main thread) is the kernel; each `posix_spawn()` loads a named `.wasm` image
into a fresh worker with its own linear memory. fd inheritance is declarative
(`dup2`/`open`/`close` file actions), `waitpid`/`kill` block via
SAB + Atomics.wait, and `popen`/`system` are built on top. `fork`/`execve`
exist as always-failing stubs so configure-style probes fail cleanly.

Why not real fork? Every serious attempt to emulate fork on a substrate that
doesn't have it validates the choice:

- **WSL1** implemented fork via NT pico processes over the NT kernel's native
  copy-on-write address-space cloning (`NtCreateProcess` machinery from the old
  POSIX subsystem). It worked and was still the slowest, most painful part of
  WSL1 — fork-heavy workloads (shell scripts, `./configure`) crawled.
- **WSL2** is Microsoft's verdict on that experiment: stop translating, ship a
  real Linux kernel in a VM. We can't (and don't want to) take that exit — it's
  the "emulate another system" path this project explicitly rejects.
- **Cygwin** fakes fork on Win32 by spawning a fresh child and copying the
  parent's memory/handles into it. Notoriously slow and fragile.
- **WASIX/Wasmer** shows fork *is* possible in wasm — snapshot the linear
  memory, rewind the stack via asyncify into a new instance. But it's
  expensive, needs whole-program stack instrumentation, and breaks around
  external state (open GPU handles, DOM, host-side fd objects).

Unlike WSL1/Cygwin, we control userspace: the libc is ours and ports are
patched at source. `posix_spawn` + `popen` + `system` covers the overwhelming
majority of real software; the rest gets a small patch (this is exactly how
the shell port should handle subshells — see Phase 1).

**Possible future mitigations** (only if a port genuinely needs them):
1. *fork+exec idiom lowering*: a `fork()` immediately followed by `exec*()` in
   the child is semantically a spawn; a source-level or libc-level shim could
   cover the common idiom.
2. *Snapshot fork*: linear memory is trivially copyable; a real `fork()` for
   the rare program that computes in the child (shell subshells, daemons)
   could be built on memory snapshot + JSPI/stack-switching. Big project, low
   priority, and per-port patching is almost always cheaper.

## Where we are (2026-07)

| Pillar | State |
|---|---|
| Compiler | ~28k lines, C89/99/11/23 broadly solid; 694/694 unit tests; builds sqlite, doom, quake, lua, micropython, libgit2, freetype; tinyemu boots Linux. Residual QoI items in `CONFORMANCE-REMAINING.md`. |
| Persistence | Done. BlockFS (inodes, TLSF, symlinks, pipes, device nodes) on OPFS, with independent fsck + differential fuzzer + dual-instance coherence. |
| Processes | Done (spawn model above). No signals delivery, no job control. |
| Terminal | xterm.js vendored, bidirectional stdio works. No termios backing, no raw mode, no Ctrl-C delivery. |
| Shell | **Does not exist.** libc already points at `/bin/sh` (`popen`, `system`, `_PATH_BSHELL`) — the slot is reserved. |
| Threads | Not implemented. `_Atomic` parses but doesn't codegen; `pthread.h`/`threads.h` are stubs. |
| Graphics | SDL3 ~90% of the 2D surface on WebGPU; WebGPU bindings core-complete (`todos/SDL3.md`, `todos/WEBGPU.md`). Single fullscreen canvas only. |
| Window manager | **Does not exist.** No compositor, no multi-surface, no client protocol. |
| Networking | Stubs only. |
| Editor | CodeMirror vendored, not wired into the environment. |

## Roadmap

Sequencing principle: **shell before window manager.** The shell is the
keystone app — it forces spawn composition, pipes, signals, tty semantics and
job control to become real, and a good terminal environment already *feels*
like an OS. The WM then lands on proven process infrastructure.

### Phase 1 — Shell + the tty/signal layer it needs

The single highest-leverage project in the repo.

- **Port a real shell** (busybox ash or dash) to `/bin/sh`. Patch fork points:
  plain command execution becomes spawn; subshells/`$( )` either spawn the
  shell binary itself with the command text, or run in-process where safe.
  This also instantly unlocks the already-written `popen()`/`system()`.
- **Signals**: host-side delivery for the async-safe core — SIGINT/SIGTERM/
  SIGKILL/SIGCHLD, `signal`/`sigaction` dispatch, default actions
  (terminate/ignore). Delivery can check a SAB flag at safe points (libc
  syscall entry) rather than true preemption.
- **termios/tty**: back `tcgetattr`/`tcsetattr` for the xterm fd — raw vs
  canonical mode, echo, VINTR→SIGINT, `TIOCGWINSZ` + SIGWINCH. This is what
  makes line editors, `less`-style pagers, and REPLs behave.
- **Job control** (can trail the rest): process groups (`setpgid` — spawn attr
  plumbing for pgroups already exists), foreground/background, SIGTSTP/`fg`/
  `bg`. Stopping a wasm instance mid-run needs thought (worker suspension via
  Atomics.wait on a resume flag at safe points).
- **Coreutils**: a busybox-style multicall binary (ls, cat, cp, mv, rm, mkdir,
  grep, sed…) — mostly straight ports once the shell exists.
- Small enablers as they come up: `select`/`poll` over the fds we actually
  have (pipes, tty, files), `mmap` (at least MAP_ANON; file-backed can be
  read-copy at first).

Exit criteria: open the tab, land in a shell over BlockFS; pipelines, Ctrl-C,
an editor, and `cc hello.c && ./a.out` all work. That's already "an OS in a
tab" for terminal people.

### Phase 2 — Threads and atomics

The other large compiler+host joint effort. Needed for real ports (and later
for WM clients that assume pthreads).

- wasm shared memory + threads proposal: shared `WebAssembly.Memory`, worker
  pool as threads, `_Atomic` codegen onto wasm atomics, `_Thread_local` for
  real, futex-based `pthread_mutex`/`cond` via Atomics.wait/notify.
- Decide the SDL threading policy at the same time (`todos/SDL3.md` open
  question) — likely: main-thread-only rendering, worker threads for compute.
- Note the interaction with the spawn model: *processes* stay
  separate-memory/separate-worker; *threads* share one memory. The two are
  orthogonal and compose.

### Phase 3 — Compositor, window manager, GUI apps

Design doc needed before code (future `todos/WM.md`). Sketch of the likely
shape — Wayland-flavored, not X11-flavored, because our spawn model already
matches it:

- **Compositor in the host**: each GUI process renders into an offscreen
  surface (shared-memory framebuffer or WebGPU texture); the host composites
  surfaces onto the canvas and routes input to the focused surface. SDL3's
  present path already does the single-surface version of this.
- **Window manager as a client** (policy out of the kernel): a wasm app that
  speaks a small control protocol — enumerate/move/resize/focus/decorate.
  Could even be an SDL app itself.
- **Client protocol**: a per-process surface handle + event queue; SDL3's
  `SDL_CreateWindow` becomes "create a surface" instead of "own the canvas",
  so **every existing SDL vendor app (doom, quake, snake, gameboy) becomes a
  windowed app for free**. That's the acceptance test.
- **Toolkit** (later): either a C widget toolkit over SDL, or the `todos/DOM.md`
  bytecode route for HTML-native apps, or both. Terminal apps + SDL apps carry
  the environment a long way first.

### Phase 4 — Networking and the long tail

- Sockets: AF_INET emulation over WebSocket/WebTransport (needs a relay or
  same-origin services), plus an AF_UNIX that's purely local (trivial — pipes
  with names in BlockFS). AF_UNIX first: it unlocks IPC for the WM protocol
  and multiplexers without any relay infrastructure.
- `fetch()`-backed HTTP convenience API for ports that just want HTTP.
- Locale/wchar beyond the current minimal level, as ports demand.

## Open questions

- **Stopping/suspending a process** (SIGSTOP, job control): coop suspension at
  libc safe points vs worker termination+resnapshot. Coop is simpler and
  probably fine.
- **Signal delivery granularity**: safe-point polling misses pure-compute
  loops (`while(1);` won't die on Ctrl-C). Acceptable? Or compile-time option
  to insert polls in loop back-edges (cost?).
- **Shell choice**: busybox ash (drags in coreutils for free, heavier patch
  surface) vs dash (smaller, cleaner, shell only). Leaning busybox for the
  coreutils dividend.
- **Surface transport for the compositor**: shared-memory framebuffer
  (simple, works today, CPU blit) vs WebGPU texture sharing (fast, but
  cross-worker GPU resource sharing is awkward). Probably shm first.
- **Who owns the xterm tty** once there's a WM — terminal emulator as a
  wasm GUI app rendering its own text, or keep xterm.js as a privileged
  built-in surface? (Keeping xterm.js is pragmatic; a wasm terminal is purer.)
- **msvc extensions**: which ones are actually worth it (`__declspec`?
  `#pragma pack` already?) — driven by ports, not speculation.
