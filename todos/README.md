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

1. `0039` WM bug sweep round 2 — the repeatable 0033 format; incl. the
   deferred pointer-lock HUMAN check and re-verifying 0038 under storm
2. `0035` spawn-capable applets — find/xargs/awk/tar/less; drop
   `PV_NO_INTERCEPT`, link the vfork shim into coreutils (0034's
   always-fail execvp in wasm_port.h marks the seam)
3. `0036` seed the REPLs — lua, micropython, sqlite3 into the image
   (measure sqlite's seed cost first)
4. `0037` wasm module cache — kernel-side compiled-Module cache on the
   spawn path (the sealed system blob's `/usr/share/os-release`
   VERSION_ID is the natural cache key since 0040; Modules clone,
   instances don't)
5. (unnumbered) a real-world WebGPU C app port — candidates via
   `WEBGPU.md`; the platform side landed with 0016
6. `0041` `__gcstr` string constants — importedStringConstants `"#"` in
   the main compiler (wc W1; independently useful to C)
7. `0042` wc fork bring-up — `wc.js`, the v1 language (side project:
   rides the main project, must never get in its way; design `WC.md`)

(The desktop-shell round 0028–0033 landed 2026-07-08 — design in
`WM.md` "The desktop shell", verified-but-unfixed items on its
"Known issues" standing list. `0040` read-only system image landed
2026-07-08: tools/mkimage.js-baked sealed blob RO at /usr, writable
root at /, systemd-style /etc, swap-the-blob upgrades — decisions in
`DISK-IMAGE.md`.)

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
(`logs/2026-07-07/wm-v1-implementation.md`);
`0014` **/bin/wm + wmctl** — WM policy out of the kernel: kernel-owned
AF_UNIX endpoints (`sockServe`), the framed WM protocol on /run/wm.sock,
taskbar, `Kernel.service()` autostart, kernel-chrome as the crashed-WM
fallback (`logs/2026-07-07/wm-policy-client.md`);
`0015` **windowed vendor apps** — doom/snake/gameboy in-OS with zero
source changes, image.json `bin` entries for binary game data (doom1.wad,
ROMs), WM.md unit 7's acceptance test passed
(`logs/2026-07-07/windowed-vendor-apps.md`);
`0016` **GPU apps windowed + the Dawn tier** — `/bin/gpubox` (direct
webgpu.h cube) through the `gpu` transport in the browser and the new
canvas-less Dawn present tail (readback → shm) headless; lazy optional
`webgpu` probe, `wgpuSurfacePresent` now a real host import, tier-1
tolerance-diff suite (`logs/2026-07-08/webgpu-demo-dawn-tier.md`);
`0017` **audio mixing** — the kernel sound server: per-process source
rings via AUDIO_OPEN (0x2xxx), kernel-side mixing (resample + sum +
clamp, pure math) into one page-owned output ring played by the existing
createAudioReceiver; doom/gameboy audible in-OS, drain-on-exit lifecycle
(`logs/2026-07-08/audio-mixer.md`);
`0019` **client resize** — SURFACE_CONFIGURE buffer renegotiation +
kernel-chrome frame resize drags, SDL window events + high-water surface
re-derive (`logs/2026-07-08/surface-resize.md`);
`0018` **quake windowed** — relative-mouse as SURFACE_SET_FLAGS bit1
round-tripping to pointer lock (kernel hit-tests the lock gesture; rel
ring records → SDL xrel/yrel), /bin/quake + the 18MB pak0.pak seeded
(`logs/2026-07-08/quake-relative-mouse.md`);
`0020` **wasm terminal + ptys** — kernel pty pairs (the slave IS a Tty:
line discipline reused verbatim; fd-aware termios; TIOCSWINSZ→SIGWINCH;
SIGHUP/EOF lifecycle) + `/bin/term` (SDL surface + freetype + escape
parser scoped to hush/vi) running hush interactive in a window, vi
inside, drag-resize reflow (`logs/2026-07-08/wasm-terminal-ptys.md`);
`0021` **SDL_WINDOW_RESIZABLE honored** — resizable = surface-flag bit2,
non-resizable frames are focus-only, RESIZE refusals, WMP record bit4
(`logs/2026-07-08/resizable-gating.md`);
`0022` **VT switching** — os.html shows exactly one of tty (VT1) /
desktop (VT2), Terminal/Desktop tab bar + Ctrl+Alt+F1/F2 alias, boot
lands on VT1;
the tty as maintenance mode under partial desktop failure, zero kernel
change (`logs/2026-07-08/vt-switching.md`);
`0023` **dynamic screen resolution** — the screen stops being a
boot-time 800×500 constant: full-viewport VT2 (1 CSS px = 1 screen px),
`wmSetScreen` re-callable → WMP EV_SCREEN + a kernel one-shot clamp
(no-WM fallback), /bin/wm re-lays the taskbar (destroy+recreate) and
re-clamps, image v17
(`logs/2026-07-08/dynamic-screen-resolution.md`);
`0024` **viewport scaling** — fixed-size windows scalable-not-
configurable: per-surface dst rect (`wmSetDst`/SET_DST/`wmctl scale`),
NN compositing both flavors, inverse-mapped input, frame drags →
EV_SCALE_REQ → wm.c's aspect-fit + integer-snap policy (kernel raw-box
fallback), record 80 bytes with dst dims, image v18
(`logs/2026-07-08/viewport-scaling.md`);
`0025` **maximize/restore** — title double-click (kernel-detected,
EV_TITLE_ACTIVATE) toggles wm.c policy dispatched on the resizable bit:
configure to the work area vs centered 0024 scale-to-fit (never
overflowing), saved-geometry restore, EV_SCREEN re-fit, `wmctl max` via
WMP ACTIVATE (same event path; R_ERR with no WM), image v19
(`logs/2026-07-08/maximize.md`);
`0027` **DOOM presents 640×400 raw** — the `WINDOW_SCALE 2` CPU
pre-scale dropped now that 0024 compositor scaling covers it, image v20
(`logs/2026-07-08/doom-native-present.md`);
`0026` **mount points: split system/user volumes** — host.js MountFS
(longest-prefix routing, EXDEV/EBUSY edges, full-namespace symlink
escape via `_mountOwns`), `/` system + `/root` user volumes in both
embedders, `boot.js --fresh-system`, reseed never touches /root, image
v21 (`logs/2026-07-08/mount-points.md`);
`0038` **WM known-issues fixes** — kernel z layers (WMP SET_LAYER /
`wmSetLayer` / `wmctl layer`, record word 11): wm.c pins the taskbar +
Start menu to the top layer and the desktop to the bottom one, every
z-order op stays within its layer — the taskbar is always-on-top and
nothing sinks under the desktop, image v27
(`logs/2026-07-08/wm-z-layers.md`).
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
  (0001/0002/0003/0009/0008 in done/); 0x1xxx is the WM opcode space,
  0x2xxx the audio mixer's (0017).
- `WM.md` — **the compositor/WM design** (0007, 2026-07-07): backend ×
  transport axes, per-process WebGPU devices, kernel-worker compositing,
  surface protocol, WM-as-client over AF_UNIX, agent control channel,
  headless tiers, spike appendix (→ 0012), implementation plan.
- `CONFORMANCE-REMAINING.md` — verified-but-unfixed compiler/host findings.
- `SDL3.md`, `SDL3-MIGRATION.md`, `WEBGPU.md` — runtime API surface plans.
- `DOM.md` — C-to-DOM bytecode + diffing renderer idea.
- `WASM_GC.md`, `EXTERNREF.md` — wasm GC / externref features.
- `GOTO-LABELS-AST-REFACTOR.md` — control-flow lowering refactor.
- `DISK-IMAGE.md` — the read-only system image & upgrade discipline
  (0040, LANDED 2026-07-08): mkimage-baked sealed RO volume at /usr,
  merged-usr, /usr/local, systemd-style /etc, swap-the-blob upgrades.
  Design decisions + the in-item decisions record.
- `BLOCK_FS.md`, `MISC.md` — filesystem notes; grab-bag.

## Conventions

- Don't re-litigate settled decisions (marked in the design docs) without
  new evidence — record the *why* when deciding anything new.
- Keep this README's *Next up* list and the queue-item status headers in
  sync with reality; they are the "where are we" of the repo.
