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

**Agent-friendly by construction.** The environment must be as drivable by AI
agents as by humans, at every layer, without a separate automation bolt-on:

- **Headless-first**: the whole OS runs under Node (kernel.js + host.js +
  worker_threads) with no browser — `tests/kernel/` already boots it this
  way. The reference os/ build keeps a headless boot mode (tty on stdio) so
  an agent can drive the shell with pipes and exit codes.
- **The tty bridge is dumb bytes in/bytes out** — a scripted bridge (what the
  kernel tests use) IS the agent interface; xterm.js is just the human skin
  over the same protocol.
- **Screenshots without a display**: compositor surfaces use readable pixel
  transports (shm framebuffer first), so "screenshot surface X" is a kernel
  op that works headlessly — deterministic pixels for graphics testing.
  WebGPU content falls back to GPU readback or Playwright against the real
  page (always available as the outer loop).
- **Semantic window access**: the kernel routes all input and owns the
  surface list, so the WM protocol exposes an agent control channel — list
  windows/geometry, focus, send keys, click, screenshot — usable from
  outside (test harness) and inside the OS (a wmctl binary), like
  xdotool-as-a-syscall. Target look for the WM is Windows-95-ish window
  management (overlapping windows, decorations, taskbar) — which is also a
  good agent target: discrete widgets, deterministic layout.

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

**The native primitive is `__spawn(struct __spawn_spec *)`, not posix_spawn.**
The spec (path, argv, envp, **cwd**, declarative fd_actions, pgroup) is the
OS's real process-creation interface — deliberately CreateProcess-class
rather than POSIX-class (posix_spawn can't even set the child's cwd; ours
can). `posix_spawn`/`posix_spawnp`/`popen`/`system` are thin C facades over
it, and the spec rides as JSON over the kernel RPC, so it GROWS BY FIELD:
suspended spawn (CREATE_SUSPENDED — cheap now that job control has the
STOPPED state), rlimits, inheritance masks, and later WM surface binding
(Phase 3) extend the spec — never a parallel primitive, never a fork.
Port patches (the shell, anything vfork-shaped) should target `__spawn`'s
declarative model: child-side setup dances (dup2/close, setpgid) become
spec fields, which also kills their classic races (the kernel assigns
pgid atomically at spawn).

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
| Processes | Done — kernel.js Phases 1–4 (todos/done/0001–0003, 0009): async signal delivery, EINTR, tty line discipline + control-char signals, kernel-owned fd tables + brokered fs, pipes as OFDs + SIGPIPE, job control (stop/cont, WUNTRACED/WCONTINUED, SIGTTIN). |
| Terminal | Done for Phase 1 — the tty is a kernel object (termios, canonical/raw, echo, Ctrl-C→SIGINT, SIGWINCH); xterm.js is the dumb UI bridge (`os/os.html`). |
| Reference build | **Boots** (todos/done/0004): `os/os.html` in a tab over OPFS, `os/boot.js` headless on stdio; first boot self-seeds from `os/image.json` (C sources compiled by the kernel's cc driver); `cc hello.c && ./a.out` works in-OS. |
| Shell | **Done** (todos/done/0005): busybox 1.37.0 hush as `/bin/sh`, ported via the vfork-on-__spawn journaling shim (`vendor/busybox/`). Pipelines, `$( )`, redirects, here-docs, control flow, interactive mode with prompt/line editing, `popen()`/`system()` all live. |
| Coreutils | **Done** (todos/done/0010, +0011): 28 busybox applets (ls cat cp mv rm mkdir grep sed sort vi … kill) as ONE multicall `/bin/coreutils` + `/bin` symlinks — hand-rolled dispatch, not appletlib (`vendor/busybox/coreutils.json`, `port/multicall_main.c`). |
| Threads | **Deferred indefinitely** (todos/0006, 2026-07-07): processes are the parallelism unit. `_Atomic` is not accepted (`__STDC_NO_ATOMICS__` stays defined — fail loud, no shim); `pthread.h` absent; `threads.h` a one-line stub. |
| Graphics | SDL3 ~90% of the 2D surface on WebGPU; WebGPU bindings core-complete (`todos/SDL3.md`, `todos/WEBGPU.md`). Single fullscreen canvas only. |
| Window manager | **v1 LIVE, acceptance passed** (todos/0007 design + 0012/0013/0014/0015, 2026-07-07): kernel surfaces (shm + bitmap transports), input rings, Canvas2D compositor in the kernel worker, agent channel with headless screenshots; policy is a wasm client — `/bin/wm` (placement, taskbar, minimize) + `/bin/wmctl` over the kernel-owned AF_UNIX endpoint /run/wm.sock, autostarted via `Kernel.service()`, kernel-chrome as the crashed-WM fallback; **doom/snake/gameboy run windowed in-OS with zero source changes** (game data seeded via image.json `bin` entries; `tests/browser/os-wm.mjs` + `os-doom.mjs`); GPU apps via the `gpu` transport + the Dawn tier (0016); **audio live** (0017, 2026-07-08): the kernel sound server — per-process source rings mixed kernel-side into one page-owned output ring, doom/gameboy audible in-OS; **resize + resizable gating** (0019/0021), **quake windowed** with relative mouse/pointer lock (0018), **the wasm terminal `/bin/term` over kernel ptys** (0020), **VT switching** — tty=VT1 / desktop=VT2 tab bar (0022), **dynamic screen resolution** — full-viewport VT2, EV_SCREEN + position clamps (0023), **viewport scaling** — fixed-size windows scale via a per-surface dst rect, inverse-mapped input, drag → EV_SCALE_REQ → wm.c aspect-fit policy (0024), **maximize/restore** — title double-click → EV_TITLE_ACTIVATE → wm.c dispatches work-area configure vs centered scale-to-fit on the resizable bit, `wmctl max` (0025). Details: `todos/WM.md` status sections. |
| Networking | **AF_UNIX done** (todos/done/0008): socket/bind/listen/accept/connect/send/recv/socketpair/shutdown between processes, S_IFSOCK rendezvous nodes in BlockFS, poll/select integration — IPC for the WM protocol is unlocked. AF_INET (WebSocket/WebTransport relay) still absent. |
| Editor | **busybox vi is `/bin/vi`** (todos/done/0011) — full-screen editing in the terminal, e2e-tested through the kernel tty. CodeMirror stays vendored but unwired (a GUI editor is compositor-era work). |

## Reference build: `os/` in this repo

The OS ships as a self-contained reference page in this repo — external apps
(the c/ app) become consumers of the same parts, not keepers of the only
kernel.

**Multi-file source page, no build step** (the repo's discipline), served by
`serve.js` — which already sends the COOP/COEP headers that
SharedArrayBuffer requires. That requirement also settles an architectural
question: a truly standalone single-file `os.html` opened from `file://` can
never get SABs, so the served multi-file page IS the natural reference form.
A single-file packaging mode (inline everything + a pre-baked BlockFS image)
can come later as a distribution convenience; it is not the dev setup.

Layout and load graph:

```
os/os.html            thin boot shim (UI bridge): xterm + canvas + input
  ├─ vendor/xterm/…   terminal widget (main thread)
  └─ new Worker ──► kernel worker
        ├─ kernel.js      process table, signals, tty discipline (KERNEL.md)
        ├─ host.js        for BLOCK_FS (store access — SyncAccessHandle is
        │                 worker-only, which is WHY the kernel is a worker)
        ├─ compiler.js    backs the __compile hook → /bin/cc works in-browser
        └─ createWorker ──► process workers (one per pid)
              └─ host.js + the process's .wasm image
```

- `os.html` stays thin on purpose: everything with logic lives in
  kernel.js/host.js/os-common.js so it's testable under Node
  (`tests/kernel/`); the page is just DOM glue plus the `window.__osOut`/
  `__osState` agent probe. Process workers boot from `os/process-worker.js`
  (the browser twin of kernel.js's Node BOOT_SOURCE), created by the kernel
  worker's `createWorker` capability.
- **First boot** (implemented, todos/done/0004; split volumes
  todos/done/0026): the kernel worker mounts TWO BlockFS volumes on OPFS
  (`openWorkspace` × `os-system.v4.img` + `os-user.v4.img`) under a
  host.js **MountFS** — `/` system volume, `/root` user volume,
  longest-prefix routing, cross-volume rename/link → EXDEV, mount points
  EBUSY, symlinks resolved in the FULL namespace via the volume-side
  `_mountOwns` escape hook — and seeds per `os/image.json`, which maps
  paths to **C sources compiled at seed time by the kernel's own cc
  driver** (`os/os-common.js`), not pre-built wasm URLs: no build step,
  the repo discipline. `/etc/.image-version` (system volume) gates
  re-seeding (bump `image.json`'s `version` after editing seeded sources).
  Since the split, upgrade = reseed (or discard: `boot.js
  --fresh-system`) the system volume while `/root` survives untouched,
  and a pre-baked image blob (`tools/mkimage.js`, still a future
  distribution convenience) becomes trivially safe to ship as a follow-on.
- **Headless twin** (the agent-first requirement): `os/boot.js` boots the
  same kernel + manifest under plain Node — file-backed store, tty on
  stdio — so `echo 'ls /' | node os/boot.js` drives the OS with pipes and
  exit codes. `tests/kernel/test_os_boot.js` scripts it;
  `tests/browser/os-boots.mjs` drives the real page in headless Chromium.
- **pid 1**: eventually the shell. Until the busybox port lands, the
  ~230-line C *protoshell* (`os/protoshell.c`: builtins, spawn, `&&`,
  trailing `&`, foreground pgroup handoff via tcsetpgrp) is the boot
  program — it doubles as the live harness for kernel Phases 1–4.

## Roadmap

Sequencing principle: **shell before window manager.** The shell is the
keystone app — it forces spawn composition, pipes, signals, tty semantics and
job control to become real, and a good terminal environment already *feels*
like an OS. The WM then lands on proven process infrastructure.

### Phase 1 — Shell + the tty/signal layer it needs

The single highest-leverage project in the repo. **The substrate is DONE**
(kernel.js Phases 1–4, `todos/done/0001–0004` + `0009`; design in
`todos/KERNEL.md`); the shell port (`todos/0005`) is its acceptance test.

- ~~Port a real shell~~ DONE (0005): busybox hush in its NOMMU
  configuration — every fork-shaped site maps onto `__spawn` through the
  journaling vfork shim (`vendor/busybox/port/`); subshells/`$( )` re-exec
  `/bin/sh` with serialized state (upstream's own NOMMU machinery).
  `popen()`/`system()` lit up as predicted. The kernel needed NO
  workarounds — the acceptance criterion held.
- ~~Signals~~ DONE (0001): safe-point delivery, SIGPEND on the kernel page,
  EINTR/SA_RESTART, default actions, SIGCHLD, ordered exit handshake.
- ~~termios/tty~~ DONE (0002): kernel-object tty, full termios, canonical/
  raw + echo, VINTR→SIGINT to the fg pgroup, TIOCGWINSZ + SIGWINCH.
- ~~Job control~~ DONE (0003): pgroups, fg/bg via tcsetpgrp, stop/cont
  (cooperative park at safe points), WUNTRACED/WCONTINUED, SIGTTIN. Pipes
  as kernel OFDs with real blocking + SIGPIPE landed with it.
- ~~select over pipes/tty/files~~ DONE (0009/0003, kernel-side readiness).
- ~~Coreutils~~ DONE (0010): busybox multicall `/bin/coreutils` + symlinks
  (ls cat cp mv rm mkdir rmdir head tail wc sort pwd true false ln touch
  basename dirname grep egrep fgrep sed echo printf test `[` kill).
- Small enablers as they come up: `poll`, `mmap` (at least MAP_ANON;
  file-backed can be read-copy at first).

Exit criteria: open the tab, land in a shell over BlockFS; pipelines, Ctrl-C,
an editor, and `cc hello.c && ./a.out` all work. That's already "an OS in a
tab" for terminal people.

### Phase 2 — Threads and atomics — DEFERRED indefinitely (2026-07-07)

**Deferred; decision + full rationale in `todos/0006`.** Short form:
processes are the parallelism unit (posix_spawn already gives multi-core
parallelism); no vendored or planned port needs pthreads; the cost — a
second shared-memory instantiation model, real TLS, libc-wide thread-safety
obligations, per-thread syscall channels, signals × threads — is a permanent
tax out of proportion to any current benefit. Don't re-litigate without a
port that hard-requires pthreads. The sketch below is kept for that
eventuality.

- wasm shared memory + threads proposal: shared `WebAssembly.Memory`, worker
  pool as threads, `_Atomic` codegen onto wasm atomics, `_Thread_local` for
  real, futex-based `pthread_mutex`/`cond` via Atomics.wait/notify.
- Decide the SDL threading policy at the same time (`todos/SDL3.md` open
  question) — likely: main-thread-only rendering, worker threads for compute.
- Note the interaction with the spawn model: *processes* stay
  separate-memory/separate-worker; *threads* share one memory. The two are
  orthogonal and compose.

### Phase 3 — Compositor, window manager, GUI apps

**Designed (2026-07-07, todos/0007): `todos/WM.md`** — Wayland-flavored as
sketched below, with the axes made explicit (rendering backend × present
transport, per-process WebGPU devices, kernel-worker compositing, headless
tiers). Implementation queued from WM.md's plan (spikes first, todos/0012).
The original sketch, kept for context:

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

- ~~AF_UNIX~~ DONE (todos/done/0008): stream sockets as OFDs over the pipe
  machinery, S_IFSOCK rendezvous nodes in BlockFS, `<sys/socket.h>`/
  `<sys/un.h>` in the libc, poll/select integration. The "trivial — pipes
  with names in BlockFS" prediction held (design: `todos/KERNEL.md`
  "AF_UNIX sockets"). IPC for the WM protocol and multiplexers is unlocked.
- Sockets, remaining: AF_INET emulation over WebSocket/WebTransport (needs
  a relay or same-origin services); SOCK_DGRAM/SCM_RIGHTS/O_NONBLOCK if a
  port demands them (v1 non-goals, recorded in KERNEL.md).
- `fetch()`-backed HTTP convenience API for ports that just want HTTP.
- Locale/wchar beyond the current minimal level, as ports demand.

## Open questions

- ~~Stopping/suspending a process~~ DECIDED + DONE (0003): cooperative
  suspension at safe points (KP_FLAGS.STOP, parked in the kernel client at
  RPC entry / sigpoll); SIGKILL (worker.terminate) is the backstop.
- ~~Signal delivery granularity~~ DECIDED (0001): safe-point polling;
  pure-compute loops are uninterruptible by design in v1, SIGKILL still
  works; `--signal-polls` (loop back-edge checks) recorded as a future
  compiler flag if a port demands it.
- ~~Shell choice~~ DECIDED + DONE (0005): busybox hush. The NOMMU
  reasoning held up exactly — ash's Kconfig gates on `!NOMMU` (hard fork
  dependency) while hush's vfork+re-exec-self machinery mapped onto
  `__spawn` with three patched call sites and a journaling shim
  (`vendor/busybox/README.md` has the full patch table).
- ~~Surface transport for the compositor~~ DECIDED (0007, `todos/WM.md`):
  transport is a per-surface property invisible to apps — GPU-side bitmap
  handoff in the browser (the dma-buf analog), SAB framebuffer for
  headless/CPU-present, per-window DOM canvas reserved as the zero-copy
  escape hatch. Apps render with their own real per-worker WebGPU device;
  no GPU virtualization.
- ~~Who owns the xterm tty~~ DECIDED for v1 (0007, `todos/WM.md`):
  xterm.js stays as a privileged DOM-kind surface positioned by the
  kernel's scene list; a wasm terminal app (SDL + pty + freetype) is the
  recorded v2.
- **msvc extensions**: which ones are actually worth it (`__declspec`?
  `#pragma pack` already?) — driven by ports, not speculation.
