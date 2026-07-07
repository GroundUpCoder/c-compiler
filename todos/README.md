# todos/ — design docs + the work queue

Two kinds of files live here. Together with the dev log (`logs/`, see
`logs/README.md`) they answer: where are we, where are we going, and why.

## 1. The work queue: `NNNN-<slug>.md`

One numbered file per unit of work we have actually committed to doing.

- **Numbers are stable IDs**, four digits, allocated sequentially, never
  reused. Reference items as `todos/0001` in commits, dev logs, and other
  docs.
- **Number ≠ priority.** The *Next up* list below is the authoritative order
  of attack; keep it short and current.
- **Each item carries its own status header** (`Status:`, `Depends:`,
  `Design:`) followed by goal / plan / acceptance criteria. Items stay
  thin — detail belongs in the design doc they point at.
- **Done items move to `todos/done/`** (same filename), so
  `ls todos/*.md` is always the open queue. Land a dev-log entry when
  completing anything substantial.
- New work: allocate the next number, add a file, slot it into *Next up*.
  Ideas that aren't committed work yet stay in the topic docs below until
  promoted.

### Next up (order of attack)

1. `0014` /bin/wm policy client + wmctl — move WM policy out of the
   kernel onto the AF_UNIX protocol; taskbar; agent RPCs (`WM.md`
   "The WM client")
2. `0015` windowed vendor apps in-OS — doom/snake/gameboy + binary-asset
   image seeding (WM.md unit 7, the design's acceptance test; quake
   split to 0018)
3. `0016` SDL+WebGPU demo app windowed + Dawn tier-1 suite — first real
   `gpu`-transport consumer; a real-world WebGPU port follows later
   (unnumbered)
4. `0017` audio mixing — the kernel sound server (WM.md open question;
   consumers: doom, gameboy)
5. `0018` quake windowed — relative-mouse/pointer-lock surface flag +
   pak0.pak seeding
6. `0019` client resize (`SURFACE_CONFIGURE`)
7. `0020` wasm terminal + ptys — KERNEL.md's waiting consumer; xterm.js
   demotes to bootstrap chrome

(Deferred indefinitely: `0006` threads + atomics — processes are the
parallelism unit; no consumer exists and the complexity tax is permanent.
Rationale + re-trigger condition in the item and
`logs/2026-07-07/threads-atomics-deferral.md`. The item stays in `todos/`
with a `deferred` status; it is not part of the order of attack.)

(Done: `0001` signals/EINTR/exit handshake; `0002` tty + line discipline;
`0009` kernel-owned fd table + brokered fs; `0003` pipes + job control;
`0004` the os/ reference build; `0005` THE SHELL — busybox hush as
/bin/sh via the vfork-on-__spawn port: pipelines, $( ), redirects,
here-docs, job control, popen/system — the kernel design's acceptance
test, passed; `0010` busybox coreutils — 27 applets as one multicall
/bin/coreutils + /bin symlinks (`logs/2026-07-07/coreutils-multicall.md`);
`0011` busybox vi — the OS's editor, 28th multicall applet, driven e2e
through the kernel tty (`logs/2026-07-07/busybox-vi.md`);
`0008` AF_UNIX sockets — the 0x05xx control plane over the pipe machinery,
S_IFSOCK rendezvous in BlockFS, `<sys/socket.h>` in the libc
(`logs/2026-07-07/af-unix-sockets.md`);
`0007` WM/compositor design — landed as `todos/WM.md`
(`logs/2026-07-07/wm-design.md`);
`0012` WM platform spikes — five verdicts in WM.md's appendix;
`0013` **WM v1** — kernel surfaces + input rings + agent channel,
kernel-worker compositor, `createSurfaceSDL`, `/bin/winbox` windowed
in-OS, tested headless + real Chromium
(`logs/2026-07-07/wm-v1-implementation.md`).
**OS.md Phase 1 is complete; Phase 3 (windows) is walking.**)

(The compiler-conformance tail in `CONFORMANCE-REMAINING.md` and the SDL3/
WebGPU backlogs run alongside; promote specific chunks into numbered items
when they get scheduled.)

## 2. Design / topic docs: `NAME.md`

Long-lived design decisions and backlogs. Queue items reference them; they
don't duplicate them. Current map:

- `OS.md` — **the north star**: the wasm-native browser OS, the
  posix_spawn-not-fork decision, the reference-build (`os/`) layout, the
  phased roadmap the queue is drawn from.
- `KERNEL.md` — the process control plane design (kernel.js): kernel page,
  doorbell, signals, tty, the fd/data-plane amendment, pipes, AF_UNIX
  sockets, settled-decisions table. All phases implemented
  (0001/0002/0003/0009/0008 in done/); the 0x1xxx WM opcode space is the
  reserved remainder.
- `WM.md` — **the compositor/WM design** (0007, 2026-07-07): backend ×
  transport axes, per-process WebGPU devices, kernel-worker compositing,
  surface protocol, WM-as-client over AF_UNIX, agent control channel,
  headless tiers, spike appendix (→ 0012), implementation plan.
- `CONFORMANCE-REMAINING.md` — verified-but-unfixed compiler/host findings.
- `SDL3.md`, `SDL3-MIGRATION.md`, `WEBGPU.md` — runtime API surface plans.
- `DOM.md` — C-to-DOM bytecode + diffing renderer idea.
- `WASM_GC.md`, `EXTERNREF.md` — wasm GC / externref features.
- `GOTO-LABELS-AST-REFACTOR.md` — control-flow lowering refactor.
- `BLOCK_FS.md`, `MISC.md` — filesystem notes; grab-bag.

## Conventions

- Don't re-litigate settled decisions (marked in the design docs) without
  new evidence — record the *why* when deciding anything new.
- Keep this README's *Next up* list and the queue-item status headers in
  sync with reality; they are the "where are we" of the repo.
