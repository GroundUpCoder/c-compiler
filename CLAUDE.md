# C Compiler

`compiler.js` is the primary compiler in this repo — a C → WebAssembly compiler in a single file. All other files (host.js, serve.js, tools/, vendor/) are auxiliary.

**North star** (see `todos/OS.md`): a WebAssembly-native, almost-POSIX OS in a
browser tab — every binary a real wasm module from this compiler, with
persistence (BlockFS), a shell, and eventually a compositor/window manager.
"Almost" because `fork()` is deliberately replaced by the owner-brokered
`posix_spawn` model (decision + rationale in `todos/OS.md` — don't re-litigate).

## Portability

`compiler.js` MUST work in both browser and Node.js environments. Never use `process.env`, `process.stderr`, `process.exit`, `process.hrtime`, or any other Node.js-specific API without a `typeof process !== 'undefined'` guard and a browser-compatible fallback. No environment variables — use compiler options and CLI flags instead.

## TODOs & the work queue

Planned work lives in `todos/` (system doc: `todos/README.md`):

- **Work queue**: `todos/NNNN-<slug>.md` — one numbered item per committed
  unit of work (stable IDs, never reused; status header inside; done items
  move to `todos/done/`, so `ls todos/*.md` is the open queue).
- **Ordering manifest**: `todos/queue.json` is the authoritative order of
  attack + the hard/soft dependency split. Mutate it **only** through the CLI
  `node todos/queue.js` (single writer + validator): `add next --slug …` to
  start work, `done <ID>` to close it, `reorder`/`block` to adjust. **`node
  todos/queue.js check` must pass before committing a queue change** — a
  committed pre-commit hook (`todos/githooks/pre-commit`) enforces this once you
  run `git config core.hooksPath todos/githooks` per clone. Dep ids live ONLY in
  `queue.json` (open items carry no `Depends:` line — `check` rejects one;
  rationale goes in the item body), and there is no prose "Next up" list — view
  the order with `node todos/queue.js list` or the cc Todos tab. Full
  convention: `todos/README.md` §1 "Maintaining the queue".
- **Design/topic docs**: `todos/NAME.md` (OS.md, KERNEL.md, SDL3.md, …) —
  long-lived designs and backlogs that queue items reference for detail.

Check all three before starting new work; reference items as `todos/NNNN` in
commits and dev logs.

## Dev logs

`logs/YYYY-MM-DD/<topic>.md` is a **committed** engineering journal (folder per
local day, file per topic) capturing the *why* behind non-trivial work —
decisions, trade-offs, gotchas. Add an entry when landing anything
substantial, cross-linking `todos/NNNN` items. In-repo convention doc:
`logs/README.md`.

## Conformance tests (bug regression corpus)

`tests/unit/conformance/` holds one directory per fixed conformance bug:
minimal C repro + clang-verified `expected.stdout` (programs are ILP32-clean),
with `// BUG:` / `// C11:` / `// EXPECT:` header comments. `diag_*` dirs assert
a *required* diagnostic via `expected.compiler.exitcode` (no stderr golden —
the message wording is free to change). **Fix bugs test-first: add the failing
test here, commit it, then fix.** Verified-but-unfixed findings are tracked in
`todos/CONFORMANCE-REMAINING.md`.

Semantics decisions already made (don't re-litigate without cause):
- Enum constants in `(INT_MAX, UINT_MAX]` get type `unsigned int` (gcc
  extension, per the `unsigned_consteval` golden); outside 32 bits errors.
- All constant scalar conversions go through `ConstEval.convert` (C11 6.3.1,
  single implementation — PP, sema, inliner, codegen). Float→int folding
  declines out-of-range so `--trapping-float-conversions` keeps its runtime
  semantics; static-initializer emission saturates explicitly.

`tests/run-unit.js` enforces a per-test timeout (default 30s, `--timeout=MS`,
per-test `timeoutMs` in `config.json`) and replaces the killed worker, so
hang-class miscompiles fail fast instead of stalling the suite.

## Vendored projects

`vendor/` contains real-world C codebases already ported to this compiler — each has its own `bin.json`. **Check this list before proposing a "new" port; many obvious candidates are already done.** As of writing:

- **Games / engines**: `doom` (doomgeneric), `quake` (1996 software renderer), `gameboy` (Peanut-GB emulator; the default `.gb`/`.gbc` handler), `sameboy` (SameBoy v1.0.3 — cycle-accurate GB/GBC second core, embedded MIT boot ROMs; patch table in `vendor/sameboy/README.md`), `snake`
- **Interpreters / DBs**: `lua` (5.5), `micropython` (1.28), `sqlite` (3.53)
- **Systems**: `tinyemu` (RISC-V 32 emulator, can boot Linux), `busybox`
  (hush as the OS's /bin/sh — NOMMU config over the vfork-on-__spawn
  journaling shim — plus 81 coreutils applets (0010, the 0034 trivial
  batch, 0035's spawn-capable batch: find/xargs/awk/tar/gzip/gunzip/
  zcat/less/diff, and 0043's procps batch over the synthetic /proc:
  ps/top/pgrep/pkill/uptime/free), including vi as /bin/vi, as one multicall
  /bin/coreutils with /bin symlinks; since 0035 the multicall links the
  vfork shim too — find -exec, xargs, awk system()/getline-pipe, tar -z
  and env-exec all really spawn; patch table in
  `vendor/busybox/README.md`)
- **Libraries**: `zlib`, `libpng`, `freetype`, `libgit2` (@44c05e5, core only; builds + `git_index_open` smoke test runs — used as a large-codebase stress test, see `vendor/libgit2/README.md`)
- **Win32 port corpus (0060, compile-stage)**: `winmine`, `notepad`, `calc`
  (ReactOS @1a706d7, UNICODE builds vs the os/win32 veneer; per-dir READMEs
  pin commit + patch tables — only `L"…"`→`u"…"`). NOT seeded into the OS
  image; `tools/win32ports.js` compile-tests them and writes
  `os/win32/PORTS.md`, the 0059+ missing-symbol backlog (`--check` runs in
  the kernel suite). Solitaire is C++ → excluded.
- **Frontend infra (JS, not C)**: `xterm` (terminal widget), `codemirror` (editor widget)
- **Project-specific tools**: `disw` (WASM disassembler), `hello` (minimal smoke test)

## Toolchain

- **cmake**: always use the uv-managed install at `~/.local/bin/cmake`
  (`uv tool install cmake`). Do NOT use `/Applications/CMake.app` (shadows
  it on PATH) or any package-manager cmake. Invoke by full path:
  `~/.local/bin/cmake`.

## kernel.js (the process control plane) and its tests

`kernel.js` is the owner-side kernel (design: `todos/KERNEL.md`): process
table, per-process kernel-page SAB, block-RPC transport, spawn/wait/kill
routing. It is per-SYSTEM; `host.js` is per-PROCESS (loaded in every process
worker) — keep that boundary. `KernelClient.spawnHooks()` plugs into
host.js's existing `spawnHooks` seam, so host.js needs no kernel-specific
code. Signal delivery is cooperative: kernel.js posts SIGPEND bits on the
kernel page, host.js claims them at env-import safe points and calls the
wasm `__sig_dispatch` export (so pure-compute loops are uninterruptible by
design — SIGKILL still works). The tty (line discipline, termios, fg-pgroup
signal routing) is a kernel object; ptys (todos/0020) are pairs where the
SLAVE is a full Tty (line discipline reused verbatim, per-Tty read-waiter
queues) and slave→master is a pipe-shaped buffer (echo + ONLCR output;
whole-or-block writes) — termios/pgrp RPCs are fd-aware (`_ttyForFd`),
TIOCSWINSZ→SIGWINCH, master close→SIGHUP+slave EOF (writes EIO), spawn
attaches `pcb.tty` from the child's post-actions fd 0 (a slave there means
that pty's winsize SAB, control chars, SIGTTIN; first attach claims
fgPgid). With `Kernel({fs})` the kernel also owns
the fd layer — per-process fd tables → shared open file descriptions → ONE
kernel-side fs object (a BlockFS, or since todos/0026 the OS hands it a
MountFS over two volumes — the kernel treats it identically), with fs
syscalls as 0x04xx RPCs served to host.js's
RemoteFS (toWasmEnv reused over it); without opts.fs, processes get private
in-process fs (standalone pages keep that path forever — two transports,
one fs; see KERNEL.md "fd/data-plane amendment"). Spawn caches compiled
Modules (todos/0037): read-only-volume binaries (fs `immutableKey` —
prefix:ino after symlink resolution) compile once kernel-side and the
`WebAssembly.Module` structured-clones in the spawn message (`procSpec.
module`, bytes dropped); rw binaries (`cc -o a.out`), ss modules, and
no-fs kernels keep the bytes path — `kernel.moduleCacheStats()` counts.
Spawn honours `#!` (todos/0065, `_spawnShebang`): a text image starting
`#!` re-dispatches to its interpreter line (execve(2) semantics — one
optional arg, script path replaces argv[0], depth-4 chain cap →
ENOEXEC), checked BEFORE the module cache; `./foo` on a `#!/bin/sh`
script just runs.
Pipes are just
another OFD kind (PIPE_CREATE; kernel-side buffers + wait queues; blocking
read/write as deferred RPCs; EOF/EPIPE + SIGPIPE; select readiness). Job
control is cooperative like signals: STOP sets KP_FLAGS bit0 and the
process parks at its next safe point (RPC entry or sigpoll), SIGCONT
clears it; waitpid takes WUNTRACED/WCONTINUED; background brokered tty
readers get SIGTTIN (EIO if ignored/blocked). The kernel can be a native
AF_UNIX peer (`sockServe`) — first user is the WM protocol server on
/run/wm.sock (framed spec in the WMP block, MUST MATCH os/wm_proto.h),
serving /bin/wm (policy: placement, taskbar, minimize) and /bin/wmctl;
`Kernel.service()` spawns parentless auto-reaped service processes (the
wm autostart). The kernel is also the sound server (todos/0017, design in
WM.md "Audio mixing"): per-process source rings register via AUDIO_OPEN
(0x2xxx; SAB rides {type:'audio-sab'} before the RPC — the wm-sabs
handshake), `audioInit()` allocates the one page-owned f32/48k output
ring, `audioPump()` mixes (linear-interp resample, mono fan-out, sum,
clamp — pure deterministic math; the embedder schedules it, 20ms in
kernel-worker). Lifecycle: close/exit/SIGKILL mark streams dying → drain
dry → reclaim (paused/no-output drop at once — never wedge). Tests:
`node tests/kernel/run.js` — `test_kernel.js`/`test_tty.js`/`test_pipes.js`
drive the real SAB protocol against fake workers (deterministic, no
threads); the `*_e2e.js` files compile real C and run it in
`worker_threads`; `bench_fs.js` is the manual brokered-vs-inprocess
benchmark. The runner (todos/0081, engine `tests/lib/suite-runner.js`)
is parallel by default (`-j`, `--serial`, `--filter`, `--resume`,
`--fail-fast`, `--timeout`); per-file logs + an incrementally
checkpointed `summary.json` land in `build/test-kernel/`, so an
interrupted run keeps a usable partial verdict and `--resume` picks up
from it. When changing the kernel-page layout or opcodes, keep KERNEL.md's
layout comment and the tests in sync.

## os/ (the reference OS build)

`os/` is the bootable reference build (design: `todos/OS.md` "Reference
build"; landed via `todos/done/0004`): `os.html` (thin xterm UI bridge;
VTs per todos/0022 — the tty is VT1, the desktop VT2, exactly ONE visible
at a time via the Terminal/Desktop tab bar (Ctrl+Alt+F1/F2 as aliases),
boot streams on VT1 then a healthy `ready` auto-switches to VT2 — the
desktop is the default tab (todos/0070; a manual switch during boot wins,
boot-error/halt still force VT1), zero kernel change; browser tests must sit on VT2 for canvas pixels/
input and VT1 for shell typing — the `window.__osVtSwitch(n)` probe) →
`kernel-worker.js` (kernel.js + BlockFS-on-OPFS + compiler.js backing
/bin/cc) → `process-worker.js` per pid. One kernel per origin
(todos/0045): kernel-worker takes a Web Lock named after the OPFS image
pair BEFORE any mount and holds it for the tab's lifetime — a second
tab gets `boot-locked` → os.html's guard screen + Retry (`boot-retry`
re-enters; the lock frees when the winner closes; `__osState ===
'locked'` is the probe). `boot.js` is the headless twin — same
kernel/manifest under Node with the tty on stdio
(`echo 'ls /' | node os/boot.js`) — deliberately unguarded (a
flock-style guard is a noted-only follow-up in the 0045 item). The
browser compositor is ONE WebGPU render pass per rAF in the kernel
worker (todos/0055, `os/compositor.js`: shm surfaces seq-gated
`writeTexture` into cached GPUTextures, gpu surfaces
`copyExternalImageToTexture` per ImageBitmap, chrome as white-texture
flat quads, title/'x' text as cached label textures) with NO Canvas2D
fallback: kernel-worker probes adapter→device BEFORE the boot lock;
failure → `boot-nogpu` → os.html guard screen (`__osState === 'nogpu'`,
no retry). Boot thus REQUIRES worker WebGPU — every browser os test
launches Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`
(flagless headless gets no adapter); headless boot.js/kernel-suite never
construct a compositor and are unaffected. The OS store is a WRITABLE root
volume at `/` + a READ-ONLY baked system blob at `/usr` (todos/0040,
design `todos/DISK-IMAGE.md`; supersedes 0026's system-at-/ split),
host.js `MountFS` on top: `/bin` is a root-volume symlink → `/usr/bin`
(merged-usr), `/usr/local` a baked symlink → `/var/local` (the admin's
writable territory; `PATH=/usr/local/bin:/bin` everywhere), /etc is
systemd-style (user overrides only; vendor defaults under `/usr/share`;
an EMPTY /etc boots; factory reset = wipe /etc+/var). The blob is a
sealed BlockFS image (superblock SHA-256, fsck_v4-checked) baked by
`tools/mkimage.js` — or on demand: boot.js re-bakes when the blob's
`/usr/share/os-release` `VERSION_ID` < `image.json version`
(`--fresh-system` forces); the browser (OPFS `os-system.v5.img` /
`os-root.v5.img` — pre-flip v4 images orphaned) first tries fetching a
prebaked `os/os-system.img` (mkimage output, gitignored), else bakes
in-worker. A NEWER blob than the manifest is kept — upgrade = swap the
blob, rollback = keep the old one; user territory is never written by
an upgrade. `image.json` is split `system`/`user`: paths map to **C
sources compiled at bake time** by the cc driver in `os-common.js` (no
build step), vendor `project` builds, `bin` blobs (repo-relative game
data), raw `text`, and `link` symlinks; the `user` section (doom1.wad,
pak0.pak, Desktop links) seeds ONCE onto a freshly created root volume
(no version gate — `/etc/.image-version` is gone). Staleness (todos/
0082): every Node-side gate is version AND input-fresh — a blob at the
manifest version whose mtime is older than any bake input (compiler.js,
host.js, os/ tree, the manifest's vendor project/bin closure —
`newestBakeInput` in os-common.js) re-materializes; boot.js prefers
INSTALLING the prebaked fixture (file copy; `--fixture=`/`--no-fixture`/
`--stale-ok`), serve.js re-runs mkimage before listening, and the
kernel/browser suite runners prebake once up front
(`tests/lib/image-fixture.js`). Bakers stamp the blob's mtime with the
bake START time; mkimage publishes via atomic rename. Still bump
`image.json`'s `version` after editing seeded sources (`wm.c`, `cc.c`,
…): a PERSISTENT browser OPFS image only re-fetches on a version bump
(the in-browser gate can't stat inputs). Writes under /usr fail EROFS (host.js `readonly`
volume flag, decided AFTER the path walk so `/usr/local/...` escapes to
the rw volume). pid 1 is busybox hush (`/bin/sh`, baked from
`vendor/busybox/bin.json`); `protoshell.c` stays as `/bin/psh`; `/bin/wm`
autostarts as a kernel service (killing it falls back to kernel-chrome;
`wm &` respawns) and reads its Start menu from `/etc/menu` if that dir
exists, else `/usr/share/menu` (first-existing-dir wins). Windowed vendor apps are seeded in-OS (todos/0015):
`/bin/doom` (WAD at `/root/doom1.wad` — doomgeneric searches cwd only,
hush starts in /root), `/bin/gameboy` (ROMs under `/root/roms` — the ROM
files are gitignored, so their entries are `optional`: missing binary
assets log a skip instead of failing the boot; bare `gameboy` runs a
built-in test ROM), `/bin/snake` (tty game; needs two paced `q`s to quit
— its exit-prompt read loop spins on EOF), `/bin/quake` (todos/0018 —
pak0.pak + autoexec.cfg at `/root/id1`; requests relative mouse at
VID_Init: SURFACE_SET_FLAGS bit1 → kernel wanted-state → os.html pointer
lock, the lock gesture being a kernel-hit-tested client click; ESC
unlocks, click re-locks; `wmctl relmove` injects rel deltas headless).
The REPLs are seeded too (todos/0036): `/bin/lua`, `/bin/micropython`
(the minimal port — REPL only: argv ignored, no `open()`/import),
`/bin/sqlite3` — piped use exits cleanly on EOF, interactive use works
at the hush prompt and over ptys (`tests/kernel/test_repl_pty_e2e.js`);
sqlite3 file-backed DBs exposed the brokered-fsync crash fixed in 0036
(FS_FSYNC RPC, fsync as a dispatched fs method).
`/bin/term` (todos/0020, `os/term/`) is the wasm terminal: kernel pty +
freetype (vendored lib, font at `/etc/fonts/mono.ttf` with the baked
`/usr/share/fonts/mono.ttf` as fallback) + an escape
parser scoped to hush/vi; `term &` runs hush interactive in a window
(640x432 = 80x24), `term cmd...` runs that instead; drag-resize reflows
via TIOCSWINSZ, close = SIGHUP. Resize is gated on
`SDL_WINDOW_RESIZABLE` (todos/0021): host.js maps it to kernel
surface-flag bit2; without it `wmResize`/WMP RESIZE/`wmctl resize`
refuse (fixed-res doom/quake/gameboy can't be sheared; winbox/gpubox/
term declare it; WMP record bit4, `R` in `wmctl list`). Fixed-size
windows SCALE instead (todos/0024): a per-surface dst viewport —
`wmSetDst`/WMP SET_DST/`wmctl scale`, dst dims in the 80-byte record +
a DST list column, NN compositing in both flavors, input inverse-maps
(agent injection stays buffer-coords), frame drags rubber-band and emit
EV_SCALE_REQ answered by wm.c's aspect-fit integer-snap policy (no-WM
fallback: kernel applies the raw box); SET_DST on a resizable surface
refuses — scaled and configurable are exclusive modes. `winbox fixed`
(title "fixbox") is the fixed-size acceptance app. Maximize/restore
(todos/0025): the kernel detects a title-bar double-click (400ms + 4px
slop, event timestamps threaded from the page) and emits WMP
EV_TITLE_ACTIVATE — mechanism only; wm.c owns the maximized set + saved
geometry and dispatches on the resizable bit (work-area MOVE+RESIZE vs
centered aspect-fit SET_DST whose integer snap never overflows the work
area), re-fitting on EV_SCREEN; `wmctl max` sends WMP ACTIVATE → the
same event (R_ERR with no WM subscriber — no WM, no maximize). The screen is dynamic (todos/0023): on VT2 the desktop
canvas tracks the viewport (1 CSS px = 1 screen px, no DPR); os.html
sends `screen-resize`, the worker resizes the OffscreenCanvas +
`wmSetScreen` → WMP EV_SCREEN + a kernel one-shot position clamp (the
no-WM fallback); /bin/wm re-lays the taskbar (destroy+recreate) and
re-clamps — browser tests must derive screen-edge geometry from the
LIVE canvas rect (`window.__osScreen` probe), never 800×500 constants.
The desktop shell (todos/0028–0033, 2026-07-08): wm.c owns a Start
button + menu popup (entries from seeded `/etc/menu`; children get own
pgroup, PATH=/bin HOME=/root, cwd /root, WNOHANG-reaped) and a
fullscreen bottom-of-z desktop layer (icon grid from `/root/Desktop`,
dbl-click launches — own timestamp check, NOT e.button.clicks which
accumulates across windows; `wmctl dblclick` injects both clicks on
one connection), all in the one wm process dispatched by windowID;
menu + desktop launch through ONE `activate(path)` (todos/0066):
a file that is runnable after symlink resolution — `\0asm` or `#!`,
told by peeking the first bytes — spawns directly (launchers are
ordinary `#!/bin/sh` scripts; the old first-line-argv menu format
is gone, menu/snake became a real script); anything else opens
through the openwith associations (todos/0072, `os/openwith.h` —
ONE header-only resolver shared by wm.c, fileman and `/bin/open`):
store = first existing of `~/.config/openwith`, `/etc/openwith`,
`/usr/share/openwith` (whole-file, no merge; `KEY<ws>COMMAND` lines,
KEY = lowercase extension or `default.gui`/`default.term`; path
appended as one arg; bare words resolve via /usr/local/bin:/bin),
baked seed: gb/gbc → `/bin/gameboy`, `default.gui → /bin/notepad`,
`default.term → vi`; `open --set KEY CMD` and fileman's "With"
picker ("Always" checkbox) write `~/.config/openwith` with the
effective table carried forward; the
kernel title bar has [min][max][close] boxes (min = wmMinimize direct,
max = EV_TITLE_ACTIVATE, each box only if it fits the title — 32px
windows stay draggable); the taskbar has a right-aligned HH.MM clock,
launch-order-stable buttons (memmove compaction), and overflow shrink
left of the clock; Ctrl+Alt+Tab (Alt+Tab on macOS) is intercepted at
wmKey ONLY with a WM subscribed → WMP EV_CYCLE 0x8B / CYCLE 0x19 /
`wmctl cycle` (wm.c walks LRU stamps forward, previous-window on
Shift; minimized skipped) — no subscriber, the key passes through.
Z layers (todos/0038): per-surface layer -1/0/+1 (WMP SET_LAYER 0x1A /
kernel-JS `wmSetLayer` / `wmctl layer`; record word 11, T/B chars in
`wmctl list` FLAGS), every z-order op stable-sort-normalized within
its layer — wm.c pins taskbar+menu to +1 and the desktop to -1, so
the bar is always-on-top and nothing sinks under the desktop; the
no-WM fallback never sets layers.
Map-on-placement (todos/0069): with a WM subscribed, SURFACE_CREATE
makes the surface UNMAPPED — skipped by compositor + hit test (still
listed/focusable/injectable/SHOT-able) — until the WM's first
geometry/stacking op on the sid (MOVE/RESIZE/SET_DST/SET_LAYER/
RESTACK; wm.c's EV_CREATED MOVE is the map ack, zero wm.c change), so
windows never flash at the cascade default; foreign borderless maps
at create (wm.c ignores those), subscriber-owned borderless (the
start menu) waits for its self-park; WM_MAP_TIMEOUT_MS (200ms) and
last-subscriber-gone map everything pending — no-WM boots are
byte-identical to pre-0069.
Aero effects (todos/0063, WM.md "Aero effects"): per-pixel alpha via
`SDL_WINDOW_TRANSPARENT` → kernel flag bit3 → WMP_F_ALPHA 32 (`A` in
the now-7-char `wmctl list` FLAGS; headless composite blends an exact
integer src-over, `winbox alpha` = "alphabox" acceptance app); drop
shadows (14px reach + 3px drop — browser-test TEAL samples near frames
must clear it) + radius-7 rounded frame corners as a per-quad SDF in
the one compositor pass; Aero Peek (kernel `wmThumbnail`/WMP THUMB
0x32, deterministic box filter → `wmctl thumb`; wm.c hover popup,
driven headless by `wmctl hover`); 200ms minimize/restore fly
animations (transient kernel records, browser-visual only); glass =
WMP GLASS 0x1B/`wmctl glass` backdrop-blur tier (browser-only —
headless composite/goldens never read it, off = byte-identical
pre-0063 pass).
Verified-but-unfixed items live in WM.md "Known issues"
(pointer-lock needs a per-round human check).
/proc is a synthetic kernel-rendered volume (todos/0043: `ProcFS` in
kernel.js, auto-bound by the Kernel ctor via the mount table; Linux
formats — busybox ps/top/pgrep/pkill/uptime/free are seeded coreutils
applets over it; per-process CPU time reads 0 by design; libc grew
getsid over a new GETSID RPC).
strace (todos/0046): the kernel traces any pcb whose spawn spec named a
trace pipe — `__spawn_spec.trace` is a pipe WRITE-end fd in the parent,
host-read only under spawn flags bit1 (`__SPAWN_TRACE`; bit2 = follow
descendants, lines get `[pid N]` prefixes); every RPC appends one
decoded line (the decode table IS kernel.js's OP map), the kernel holds
its own write-end ref so the tracer's EOF is exactly tracee teardown,
and a full pipe drops lines + reports the count at exit (the kernel
never blocks). `/bin/strace [-f] [-o FILE] cmd args...` (os/strace.c)
is just the plumbing: pipe, spawn pre-traced, copy to stderr, propagate
exit status (128+sig on a signaled child).
SDL frame pacing is the kernel's clock (todos/0100): nested workers get
no working rAF, so `Kernel({vsync: true})` (kernel-worker only)
advertises the compositor rAF via two kernel-page TAIL words —
`vsyncTick()` bumps+notifies every live pcb per composite,
`KernelClient.vsyncWait` parks on it with rAF catch-up semantics, and
host.js's surface backend slots that in as its `requestAnimationFrame`.
Tab hidden = no ticks = SDL apps park (honest pause, by design;
cooperative signals defer to the next tick, SIGKILL unaffected). No
vsync source (boot.js, standalone) → the deadline-setTimeout pacer
tier in host.js's frame-loop driver (fixed 0100: the old fixed
`setTimeout(16)`-after-callback pacer silently halved presented fps —
sameboy GBC showed 60 emulated/33 presented).
The Start menu is Win95-classic (todos/0078): the baked menu tree has
Games/Accessories/Demos GROUP subdirectories (cascading flyout columns,
one borderless window per column titled "startmenu"/"startmenu2"/…;
`/etc/menu` subdirs cascade the same), a fixed section below a separator
(SETTINGS → /bin/ctlpanel, RUN… → the "startrun" sh -c dialog; Shut
Down waits on 0051), the sidebar band, and keyboard nav (arrows/Enter/
type-ahead/Esc — only the ROOT column ever holds focus; flyouts hand it
back at their create echo, the peek precedent). Ctrl+Esc toggles it via
WMP EV_MENU 0x8C / MENU 0x1C / `wmctl menu` — the EV_CYCLE pattern
exactly (subscriber-gated, keyup swallowed).
Desktop icons are selectable & movable (todos/0077, wm.c-only): click/
ctrl-click/shift-range/marquee build a 64-bit selection set (navy label
strips; marquee intersects TILES, ctrl adds), drag moves the whole set
grid-snapped all-or-nothing with positions persisted in
`/root/Desktop/.icons` (`col row name`; absent entries auto-flow — a
virgin Desktop keeps the 0029 layout), arrows/Enter/Esc/Ctrl+A drive it
from the keyboard (Enter on a multi-selection is a deliberate no-op —
the multi-launch guard); a desktop left-click sends WMP_FOCUS on the
desktop sid (kernel's borderless exemption stands; policy asks) and
modifiers are tracked by KEYSYM from key events since pointer records
carry no mod word; wmctl grew keydown/keyup/down/up/drag for headless
gestures; right-button routing landed with 0091 (below).
The system clipboard (todos/0090) is ONE kernel-held slot ({fmt, bytes};
fmt 1 = UTF-8 text, tagged so 0092's file lists can ride later) behind
the CLIP_SET/CLIP_GET RPCs — cross-process, survives the writer exiting
(Win95: one slot, no history). The C surface is the real SDL3 clipboard
API (`SDL_SetClipboardText`/`SDL_GetClipboardText`/`SDL_HasClipboardText`/
`SDL_ClearClipboardData` in __SDL.c over host.js `createClipboard`'s
`__clip_set`/`__clip_get` imports; usable without SDL_Init; no kernel →
a process-local slot with the same semantics). Consumers: user32's
clipboard API + EDIT WM_COPY/CUT/PASTE (^C/^X/^V/^A) ride it (the 0048
`$HOME/.clipboard` file is gone), term grew drag-selection (screen-coord
cell range, inverted render) with Ctrl+Shift+C copy / Ctrl+Shift+V paste
(\n→CR on the wire; plain ^C stays SIGINT), and `/bin/clip` (os/clip.c)
is the shell bridge — `cmd | clip` sets, `clip -o` prints (exit 1 when
empty; also the test probe). Host-browser clipboard integration is
deliberately NOT wired (SDL3.md). Tests:
`tests/kernel/test_clipboard_e2e.js` + the os-shell.mjs notepad leg.
Right-click context menus (todos/0091): wm.c raises a two-window popup
(root "ctxmenu" + at most ONE "ctxmenu2" flyout — the v1 depth cap) from
fixed item lists with SEP/GRAY/SUB flags — empty desktop (New ▸ Folder/
Text File with the Win95 uniquifier, Sort by ▸ Name = forget `.icons`,
Refresh, Display → `ctlpanel Display`; ctlpanel grew applet-by-name
argv), icon (selects-alone-unless-in-set, Open via activate(); 0092 file
ops grow here), taskbar button (Restore/Minimize/Maximize/Close over the
existing chrome ops, inapplicable rows grayed — gray rows never fire and
leave the menu open; Start strip + empty bar reserved for 0101, title
bars for 0102). Start-menu furniture rules apply (top layer, root holds
focus, focus-leave/outside-click/Esc/EV_SCREEN dismiss, arrows/Right/
Left/Enter, one popup at a time — the EV_FOCUS dismissal of the START
menu is now also gated on its root echo, or menu_toggle's ctx_dismiss
focus-fall kills the menu it just opened). user32's EDIT grew the
standard WM_CONTEXTMENU menu (Undo/Cut/Copy/Paste/Delete/Select All,
state-gated per popup; Undo always grayed — no undo buffer, 0048 scope)
over the 0068 TrackPopupMenu primitive, which grew modal keyboard nav
(Up/Down/Enter/Esc, the rest swallowed) + right-down-outside close;
popup items stay agent targets, which is how tests drive them. Tests:
`tests/kernel/test_ctxmenu_e2e.js` + `tests/browser/os-ctxmenu.mjs`
(gotchas: `wmctl list` is z-ordered — pick windows by sid; `wmctl tree`
lists menu BARS before the `popupmenu` section; browser legs must
quiesce ~1.5s after the VT2 settle or a late EV_SCREEN dismisses the
popup under test).
File manager operations (todos/0092): the ONE file-ops core is
`os/fileops.h` (header-only, the openwith.h precedent — shared by
BOTH fileman and wm.c): recursive `fo_copy` (symlinks copy AS links —
a Desktop launcher copies like a shortcut; refuses dir-into-itself),
`fo_move` (rename(2) + EXDEV copy-delete, refuses an existing dest =
EEXIST, no silent overwrite), recursive `fo_delete`, the "Copy of"/
"Copy (N) of" paste uniquifier + the "New Folder N" new-dest one, and
the CLIPBOARD FILE LIST — a format-2 payload on the ONE 0090 kernel
slot ("cut\n"/"copy\n" header + one absolute path per line; fmt 1 text
still last-write-wins across formats), so cut/copy/paste crosses
processes (fileman↔fileman↔desktop). shell32 re-exports it as the
VENEER-LOCAL `SHFile*`/`SHClip*` helpers (NOT real SHFileOperation —
no corpus consumer for the double-NUL struct). fileman.c grew the
right-click menu (Open/Open With[dir-gray]/Cut/Copy/Rename/Delete/
Properties on a row; Paste[clip-gated]/New Folder/Refresh on the pane)
over TrackPopupMenu, F2/Del/^C/^X/^V via a runtime accelerator table
(GetFocus()==listbox gated so the path EDIT keeps its text chords),
a rename dialog (the "Open with" picker pattern; Enter/Esc route from
the message loop, EEXIST keeps it open), delete confirm (MB_YESNO) +
Properties (stat facts) MessageBoxes, and EROFS surfaced as
strerror(errno). wm.c's icon menu grew Cut/Copy (the selection set),
the desktop menu grew Paste (both over fileops.h). NEW user32 surface:
`AppendMenuA`, `CreateAcceleratorTableA`+ACCEL/FVIRTKEY, `LB_ITEMFROMPOINT`,
and AQ_CLICK now prefers an ENABLED match (`agent_find_ex`) so
modal-over-modal — an error box over the rename dialog — is drivable
(a disabled same-labelled button no longer shadows the live one).
Delete is PERMANENT until the Recycle Bin (0093) reroutes it; multi-
select/details = 0106, desktop-icon rename = 0103, DnD = recorded
non-goal. Tests: `tests/kernel/test_fileman_ops_e2e.js` +
`tests/browser/os-fileman.mjs`.
Image version is **v53**.
The Win32 veneer (todos/WIN32.md) lives in `os/win32/` as an app-side
lib.json library: 0057 landed gdi32 — `windows.h` + `gdi32.c`, a CPU
rasterizer over the surface/bitmap RGBA buffers (DCs incl. memory DCs,
objects + stock + leak counters, all 16 ROP2s, shapes with GDI
right/bottom-exclusive and LineTo-endpoint semantics, freetype text
sharing term's font, BitBlt/StretchBlt/PatBlt, GetDIBits/SetDIBits
B<->R swizzle, IntersectClipRect). 0058 landed user32 (`user32.c`):
window classes + the HWND tree (top-level HWND ↔ SDL window/kernel
surface; child controls drawn IN-PROCESS into the top-level's surface,
Wine-style — a child DC is the surface span offset to its client
origin via the `win32_internal.h` `__gdi_dc_wrap` seam, which replaced
0057's `__gdi_bind_hwnd` scaffold), the CLASSIC blocking message loop
(GetMessage parks in host.js's `__sdl_pump_wait` import, which drains
the input ring in place and Atomics.waits on IR_WPOS — kernel.js
notifies it in `_wmPushEvent`; WM_PAINT only when the queue is dry,
WM_QUIT last), input routing (hit-test/capture/focus; SDL3 keysyms are
modifier-applied so TranslateMessage→WM_CHAR is table-free), the
standard controls (BUTTON incl. check/radio/groupbox, STATIC, EDIT
single+multiline, LISTBOX, SCROLLBAR with Windows notify-only
semantics) and MessageBox as a real modal (own surface, owner
disabled). The agent tree records OS.md's agent-target pillar: every
user32 process serves `os/wm_agent.h`'s protocol on
/run/win32/agent.<pid>.sock from the GetMessage idle loop — `wmctl
tree` dumps every window (class/id/rect/live text), `wmctl click
"OK"` presses BY LABEL ('&' stripped; "CLASS:n" addresses text-less
controls), gettext/settext round-trip WM_GETTEXT/WM_SETTEXT — no
pixel coordinates. `/bin/gdidemo` (Petzold GDI scene + `selftest`,
now a real message-loop app) and `/bin/ctldemo` (controls +
MessageBox) are the acceptance apps; tests
`tests/kernel/test_gdi32_e2e.js` + `test_user32_e2e.js` +
`tests/browser/os-gdi.mjs` + `os-user32.mjs`. 0060 landed the port
corpus + harness: vendored ReactOS winmine/notepad/calc compile
UNICODE against the veneer (headers grew the A/W split — implemented
entries are ANSI generic names, veneer sources `#undef UNICODE`, W
variants declared with generic→W maps under UNICODE; WCHAR is 2-byte
UTF-16 via `u"…"`/TEXT-paste, NOT libc's 4-byte wchar_t; 16-bit wide
CRT = the `_tcs*` names as real symbols) — `node tools/win32ports.js`
regenerates `os/win32/PORTS.md`, the authoritative 0059+ demand log
(top of the table: W message pump, registry, LoadString/LoadImage
resources, menus, dialogs, GetSystemMetrics); `--check` is
`tests/kernel/test_win32_ports.js`. 0059 landed kernel32 over POSIX
(`kernel32.c` + `advapi32.c` + `crt16.c` in lib.json — all app-side, no
kernel change): handle table (HANDLE↔fd, magic-tagged), CreateFile→open,
FindFirstFile→opendir+wildcard, file mapping as read-copy views
(write-back on unmap), Global/Local/Heap as ONE headered malloc,
CreateProcess→the `__spawn` spec (cmdline tokenizer, PATH search,
STARTF_USESTDHANDLES→fd-actions — DUP2's `fd` is the CHILD fd, `arg` the
source), module identity via /proc/<pid>/cmdline, registry = a text hive
at `$HOME/.win32reg` (tmp+rename write-through; GetProfileIntW maps
win.ini onto it), the 16-bit wide CRT (`_tcs*`/strsafe/wsprintfW over
one wide formatter that renders numerics via narrow snprintf), and
loud-failure stubs (CreateThread/LoadLibrary →
ERROR_CALL_NOT_IMPLEMENTED — single-threaded static-link world). NB
kernel32 is W-NATIVE (no ANSI generics — the corpus is UNICODE-only;
windows.h section note is canonical). `/bin/k32demo` (UNICODE build, 87
self-checks incl. POSIX-twin identity + a redirected spawn) is the
acceptance app; `tests/kernel/test_kernel32_e2e.js` adds
registry-persistence-across-boots. 0068 landed the user32/resource
tail — **winmine is seeded as `/bin/winmine` and playable**: resources
ride a SIDECAR pack `<binary>.res` (the PE-resource-section analog)
compiled by `tools/win32rc.js` from the app's .rc (STRINGTABLE/MENU/
DIALOGEX/ACCELERATORS/BITMAP subset; the WRES format there MUST MATCH
user32.c's `res_*` loader; found via argv0 at first Load* — zero link
coupling) and committed per-port (`vendor/winmine/winmine.res`, seeded
next to the binary). user32 grew the W entry points (per-window A/W
mark; WM_SET/GETTEXT translate at the send_msg choke — NB
MAKEINTRESOURCE detection can't be `< 0x10000` here: the wasm STACK is
the low 64KB, so `is_intres` also requires the value to sit at-or-below
a fresh local's address), menus (HMENU tree; user32 draws the BAR in
the top 20px of the surface at every present, client area offset under
it; popups draw in-surface and clip; items are agent targets — `wmctl
tree` lists them, `wmctl click "Beginner"` posts the WM_COMMAND),
accelerators, DialogBoxParamW over RT_DIALOG templates ("#32770" hosts
both MessageBox and template dialogs), SetTimer/WM_TIMER (queue-dry
delivery), RedrawWindow/AdjustWindowRect (menu height only — chrome is
the kernel's), GetSystemMetrics + a synthetic monitor, and top-level
MoveWindow → the new `SDL_SetWindowSize` → kernel `SURFACE_RESIZE`
(0x1007, the one owner-initiated surface op: NOT gated on the
resizable bit — that bit protects apps from the WM, not from
themselves; reuses the 0019 renegotiation). gdi32 grew W text
wrappers; `shell32.c` (ShellAboutW) + `winmm.c` (PlaySoundW success
stub) are new veneer slices; `os/win32/wwinmain.c` is the wWinMain CRT
entry shim UNICODE GUI ports list in bin.json `sources`. Icons/cursors
are stub handles; the .ico/.wav assets are deliberately not vendored.
After 0068: notepad 27, calc 15 (comdlg32/clipboard/printing +
TrackPopupMenu/keyboard-layout). `tests/kernel/test_winmine_e2e.js` is
the acceptance test (geometry, menus, dialogs, WM_TIMER, cell-reveal
pixels, registry persistence across boots).
`/bin/gpubox` (todos/0016) is
the GPU demo — direct webgpu.h rendering: browser = per-process WebGPU
device + ImageBitmap handoff; headless = the optional Dawn tier (the
`webgpu` devDependency in the root package.json, LAZILY probed by host.js
— never hard-imported, stock Node stays tier 0; present = texture
readback→shm SAB, so `wmctl shot` works identically to CPU apps). GPU
apps must quit via SDL_Quit(), not exit()-in-frame-callback — the runtime
drains pending Dawn work before the EXIT handshake (WM.md spike-S3
caveat). Audio (todos/0017): doom/gameboy sound mixes kernel-side into
one output ring; os.html loads host.js ONLY for `createAudioReceiver`
and resumes the AudioContext on the first user gesture (autoplay
policy); `boot.js` stays silent by design (no `audioInit` — apps
self-pace against SDL_GetAudioStreamQueued, bounded memory). The tty's
`interactiveOut` opt makes fd 1/2
tty-kind (isatty true → hush goes interactive); piped runs stay
byte-clean. Tests: `tests/kernel/test_os_boot.js` +
`test_wm_service_e2e.js` + `test_os_apps_e2e.js` + `test_term_e2e.js`
(0020) + `test_gpubox_dawn_e2e.js` (headless, in the kernel suite; the
gpubox one skips without the webgpu pkg) +
`test_audio.js`/`test_audio_e2e.js` (0017) +
`test_pty.js`/`test_pty_e2e.js` (0020);
`tests/browser/os-boots.mjs` + `os-wm.mjs` (incl. the 0025
double-click maximize/restore leg on resizable winbox, the 0030
title-box legs, and the 0032 cycle-chord legs)
+ `os-doom.mjs` (now asserts the audio pipeline) + `os-gpubox.mjs`
+ `os-quake.mjs` (pointer-lock UX + the 0024 grip-scale leg)
+ `os-term.mjs` (0020) + `os-vt.mjs`
(0022; VT semantics incl. the kill-the-wm maintenance mode)
+ `os-screen.mjs` (0023; viewport-tracking screen, taskbar re-lay,
shrink re-clamp) + `os-scale.mjs` (0024; drag-to-scale, inverse-mapped
input, wmctl scale/unscale; + the 0025 fixed-size scale-to-fit
maximize leg) + `os-shell.mjs` (0028/0029/0031; Start menu, desktop
icons, clock — note: "empty desktop" pixel asserts must tolerate the
icon grid, and the desktop layer's teal equals the compositor
background teal) + `os-aero.mjs` (0063; exact src-over blend, shadow
falloff + corner clip, live Aero Peek popup, minimize-anim settle,
glass round-trip) (real Chromium, manual). The whole sweep is ONE
command since todos/0081: `node tests/browser/os-sweep.mjs`
(discovers `os-*.mjs`, serial by design — 0045 boot lock + contention;
`--filter`/`--resume`/`--fail-fast`; per-file logs + checkpointed
`summary.json` in `build/test-browser/`).

## BlockFS (host.js) and its tests

`host.js` contains **BlockFS** — a POSIX-ish filesystem backed by one byte store
(an OPFS `SyncAccessHandle` in the browser, a `MemoryByteStore` in tests). The
superblock + TLSF allocator + inode table + directories all live in the store.

**MountFS** (also host.js, todos/0026) is a mount table over N BlockFS volumes:
longest-prefix routing with prefix strip, its own fd/dir-handle namespaces,
cross-volume rename/link → `EXDEV`, mount points → `EBUSY`. Symlinks resolve in
the FULL namespace: MountFS wires `_mountPrefix`/`_mountOwns` hooks into each
volume; `_walkHops` resolves targets through them (in-volume → strip and keep
walking; foreign → throw `__mountEscape` with the full-namespace continuation,
which MountFS's dispatch loop catches, rewrites, and retries — parent-dir walks
are always a path prefix of their argument, so the rewrite is unambiguous).
Every BlockFS path op walks all components via `_walkPath` BEFORE mutating, so
an escape aborts with no partial state — keep that ordering when adding ops.
Each volume stays an independently fsck-able image; only the kernel embedders
(`Kernel({fs: mountfs})`) use MountFS — process-side RemoteFS and standalone
single-volume paths are untouched. Tests: `tests/blockfs/test_mounts.js` (walk
mechanics + fsck), `tests/kernel/test_mounts.js` (routing/EXDEV/EBUSY/escape
semantics + the 0040 readonly-/usr layout).

**Read-only volumes + sealed blobs** (host.js, todos/0040):
`createV4(store, {readonly: true})` mounts an EXISTING v4 image read-only —
every mutating op returns `EROFS` via `_setErr`, decided AFTER the path walk
(so a path escaping through a symlink to a writable volume retries on its
owner — that ordering is load-bearing for `/usr/local` → `/var/local`);
the store is wrapped in `ReadOnlyStore` as a throw-on-write backstop, and an
unformatted store throws instead of formatting. `sealVolume`/`verifySeal`
(async, WebCrypto): superblock flags bit 1 + SHA-256 of everything after the
superblock at offset 36 — `fsck_v4.js` re-checks it independently. Tests:
`tests/blockfs/test_readonly.js`.

**Invariant: the store is the single source of truth.** Any metadata that's
persisted in the superblock (inode-table extent/capacity, `nextInodeId`, pool
end, free lists) MUST be read THROUGH the store on each access, never cached on
the JS instance. Caching breaks coherence when **two live BlockFS instances run
over one store** (e.g. an embedder's concurrent headless runner + the workspace
owner): a stale cache hands out a used inode id or reads inodes at a relocated
offset → silent cross-file corruption. (This was a real bug — fixed by making
`InodeTable` extent/cap and `_nextInode` read-through.)

**Test suite** (`tests/blockfs/`, run `node tests/blockfs/run.js [--long]`):
- `test_tlsf.js`, `test_blockfs.js`, `test_e2e.js` — example-based unit/e2e.
- `test_posix.js` — POSIX semantics: unlink/rename-while-open lifetime (inodes
  carry an in-memory, per-instance open-refcount; freeing defers to last
  close), same-inode rename no-op, failed-rename rollback, hole zero-fill,
  TLSF v3 huge-size arithmetic, symlink nlink symmetry, pipe-end refcounts
  across dup/dup2/F_DUPFD. Note: the open-refcount is per-instance only —
  cross-instance unlink-while-open still frees early (documented limitation).
- `fsck.js` — an INDEPENDENT consistency checker (shares no code with host.js;
  re-declares the on-disk format with a version guard; reads the store raw). It
  walks the block map, free lists, inodes/extents, and the directory tree and
  cross-checks every invariant (no overlapping/double-claimed extents, no leaked
  used blocks, free-list ↔ physical-free agreement, dirents → live inodes, file
  `nlink` == dirent refcount, reachability). Detection only (no repair).
- `test_fsck.js` — proves fsck catches hand-crafted corruption (and clean images pass).
- `test_fuzz.js` — model-based differential fuzzer: random valid ops against
  BlockFS vs an in-memory reference model; after EVERY op it asserts a fresh
  instance matches the model, runs `fsck`, and (dual mode) checks two live
  instances over one store stay coherent. Deterministic per seed; prints the
  seed+op on failure. This combo catches the multi-instance-coherence class that
  the read-through invariant protects — verified to fail on the pre-fix host.js.

When adding/changing on-disk format or metadata, update `fsck.js`'s constants
(it guards on superblock VERSION) and make sure new persisted state is
read-through, or the fuzzer's dual mode will (correctly) flag it.
