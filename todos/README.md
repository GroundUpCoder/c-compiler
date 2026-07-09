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

1. **The Win32 desktop platform** (design: `WIN32.md`, 2026-07-09 — the
   primary UI toolkit; **supersedes microui/MVU**, which are dropped):
   `0057` gdi32 (CPU→shm drawing) → `0058` user32 (windowing + standard
   controls + the HWND agent tree) → `0059` kernel32 subset over POSIX
   (file/mem/time/process/dir; grows on demand) → `0060` OSS Win32/GDI
   ports (ReactOS applets + corpus; a compile-test harness whose
   missing-symbol log drives 0057–0059). Apps (`0048` reframed):
   winmine/sol/notepad/calc arrive as real ReactOS C ports.
2. Drawing / compositor track (parallel): `0061` **Cairo** — modern C 2D
   vector API with a real corpus (adopt, don't invent); `0062` zero-copy
   present (`direct` transport; pixels never touch RAM except on
   `wmctl shot`); `0063` Aero effects (alpha/shadows/thumbnails/blur/
   animation on the 0055 pass).
3. (unnumbered) a real-world WebGPU C app port — candidates via `WEBGPU.md`
4. `0041` `__gcstr` string constants — importedStringConstants `"#"` in
   the main compiler (wc W1; independently useful to C)
5. `0042` wc fork bring-up — `wc.js`, the v1 language (side project)
6. `0046` strace (kernel-POSIX batch remainder)
7. Networking (design: `NETWORK.md`): `0052` loopback AF_INET → `0053`
   HTTP-for-C (curl easy facade over kernel fetch)
8. Tail: `0049` wallpaper; `0050` pdpmake + busybox patch/ed; `0054`
   AF_INET relay transport; `0051` halt/reboot

(The pointer-lock HUMAN check was deferred by BOTH sweep rounds — it is
a MUST for WM sweep round 3, whenever that gets a number.)

(`0055` WebGPU compositor landed 2026-07-09: os/compositor.js is one
WebGPU render pass per rAF — shm seq-gated writeTexture, gpu
copyExternalImageToTexture, chrome flat quads + cached label textures —
with NO Canvas2D fallback; no worker WebGPU at boot is a loud
`boot-nogpu` guard screen. `logs/2026-07-09/webgpu-compositor.md`.)

(`0043` procfs + the process tools landed 2026-07-09: synthetic /proc as
a MountFS volume rendered from the kernel process table, busybox
ps/top/pgrep/pkill/uptime/free as coreutils batch 4, libc getsid, image
v32 — `logs/2026-07-09/procfs.md`. killall/killall5 un-guarding is a
noted cheap follow-up in `vendor/busybox/README.md`.)

(The desktop-shell round 0028–0033 landed 2026-07-08 — design in
`WM.md` "The desktop shell", verified-but-unfixed items on its
"Known issues" standing list. `0040` read-only system image landed
2026-07-08: tools/mkimage.js-baked sealed blob RO at /usr, writable
root at /, systemd-style /etc, swap-the-blob upgrades — decisions in
`DISK-IMAGE.md`. `0039` WM sweep round 2 landed 2026-07-09: 0038
re-verified under storm, one kernel fix — the focus fall skips pinned
furniture — and the known-issues list re-dated;
`logs/2026-07-09/wm-bug-sweep-2.md`.)

(Dropped from the queue entirely (2026-07-09): `0006` threads + atomics —
processes are the parallelism unit; no consumer exists and the complexity
tax is permanent. The todo file was removed as clutter; the rationale +
re-trigger condition live in `logs/2026-07-07/threads-atomics-deferral.md`.
Not planned; re-open only if a concrete port hard-requires pthreads.)

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
(`logs/2026-07-08/wm-z-layers.md`);
`0035` **spawn-capable applets** — find/xargs/awk/tar/gzip/gunzip/zcat/
less/diff in the multicall, which now links the vfork-on-__spawn shim
(hand-rolled spawn()/spawn_and_wait() over pv_*; bare-exec emulation
makes `env cmd` real); tar -z proves both shim paths (spawn gzip on
create, re-exec `gunzip -cf -` on extract); surfaced the
switch-decl-before-first-case codegen bug (fixed test-first) + libc
sched.h; /bin is 75 multicall names, image v30
(`logs/2026-07-09/spawn-applets.md`);
`0045` **two-tab boot guard** — a Web Lock named after the OPFS image
pair, taken in kernel-worker.js BEFORE any mount and held for the tab's
lifetime: the losing tab gets a guard screen + Retry (the lock frees
when the winner closes; no steal in v1), single-tab boots unchanged
(`logs/2026-07-09/two-tab-boot-guard.md`);
`0036` **the REPLs seeded** — /bin/lua, /bin/micropython (minimal port:
REPL only), /bin/sqlite3 as image.json `project` entries, image v31;
piped use EOF-exits, interactive use proven over a kernel pty
(`test_repl_pty_e2e.js`); sqlite3's journal fsync exposed the brokered
fsync crash — fixed test-first as a dispatched fs method + FS_FSYNC RPC
(`logs/2026-07-09/seed-repls.md`);
`0037` **compiled-Module cache on spawn** — the kernel compiles each
READ-ONLY-volume binary once (fs `immutableKey`: prefix:ino after full
symlink resolution — 0040's RO /usr makes invalidation a non-problem)
and structured-clones the `WebAssembly.Module` in the spawn message;
hits skip loadImage + the byte clone; ss/rw/engine-rejected stay on the
bytes path; measured parity headless (V8's engine cache had already
deduped compiles — the win is the engine-agnostic guarantee + zero
per-spawn fs work + `moduleCacheStats()` observability)
(`logs/2026-07-09/module-cache.md`).
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
- `NETWORK.md` — the networking tier model (2026-07-09): loopback
  AF_INET in-kernel, curl-easy HTTP over fetch, getaddrinfo-over-DoH,
  the pluggable localhost websockify relay (→ 0052/0053/0054).
- `KERNEL.md` — the process control plane design (kernel.js): kernel page,
  doorbell, signals, tty, the fd/data-plane amendment, pipes, AF_UNIX
  sockets, settled-decisions table. All phases implemented
  (0001/0002/0003/0009/0008 in done/); 0x1xxx is the WM opcode space,
  0x2xxx the audio mixer's (0017).
- `WM.md` — **the compositor/WM design** (0007, 2026-07-07): backend ×
  transport axes, per-process WebGPU devices, kernel-worker compositing,
  surface protocol, WM-as-client over AF_UNIX, agent control channel,
  headless tiers, spike appendix (→ 0012), implementation plan.
- `WIN32.md` — **the primary UI toolkit** (2026-07-09): Win32 (user32
  windowing + gdi32 drawing + a kernel32 subset) over the surface protocol
  + POSIX kernel (→ 0057–0060). Chosen because the HWND tree makes agent-
  drivability structural; supersedes microui/MVU. Includes the windowing-
  vs-drawing (Win7/DWM) split and the POSIX-coexistence model.
- `TOOLKIT.md` — **superseded by `WIN32.md`** (2026-07-09): the former
  Elm/MVU direction (0047/0056), now dropped; kept as a redirect + history.
- `CONFORMANCE-REMAINING.md` — verified-but-unfixed compiler/host findings.
- `SDL3.md`, `SDL3-MIGRATION.md`, `WEBGPU.md` — runtime API surface plans.
- `DOM.md` — C-to-DOM bytecode + diffing renderer idea; its declaration
  encoding is reused by `TOOLKIT.md`'s vtree (browser-DOM as a possible
  alternate backend later).
- `WASM_GC.md`, `EXTERNREF.md` — wasm GC / externref features.
- `SS-INTEROP.md` — running self-service (`.ss`) modules in this runtime
  (proposed 2026-07-09): the flavor-agnostic `runModule`, and ss-as-a-
  loadable-library that C `dlopen`s — GC/externref shared ABI, no PIC. One
  slice landed (`host.js` core-env dispatch, `6b8e385`). ss-loads-into-C
  only; the reverse is a settled no.
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
