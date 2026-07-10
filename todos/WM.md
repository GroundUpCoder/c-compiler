# WM.md — compositor + window manager design

- **Status**: designed 2026-07-07 (todos/0007); **v1 IMPLEMENTED the same
  day** (todos/0012 spikes + todos/0013 — see "Implementation status v1"
  below for what shipped and where it deviates); **/bin/wm + wmctl landed**
  (todos/done/0014, status section below); **the acceptance test passed**
  (todos/done/0015 — doom/snake/gameboy windowed in-OS with zero source
  changes; quake awaits the relative-mouse flag, todos/0018); **GPU apps +
  the Dawn tier landed** (todos/done/0016, 2026-07-08 — /bin/gpubox through
  the `gpu` transport in the browser and the Dawn readback→shm present tail
  headless; tier-1 suite in the kernel run; status section below);
  **audio mixing landed** (todos/done/0017, 2026-07-08 — the kernel sound
  server: per-process source rings mixed kernel-side into one page-owned
  output ring; doom/gameboy audible in-OS; design section below);
  **client resize landed** (todos/done/0019, 2026-07-08 — SURFACE_CONFIGURE
  buffer renegotiation + kernel-chrome frame resize drags; status section
  below); **relative mouse / quake landed** (todos/done/0018, 2026-07-08 —
  SURFACE_SET_FLAGS bit1 round-tripping to pointer lock, rel input-ring
  records, /bin/quake + pak0.pak seeded; status section below);
  **resizable gating landed** (todos/done/0021, 2026-07-08 —
  SDL_WINDOW_RESIZABLE honored end to end: surface-flag bit2 gates drag
  zones and every RESIZE path; see the bullet under "Implementation
  status — client resize"); **VT switching landed** (todos/done/0022,
  2026-07-08 — tty=VT1 / desktop=VT2, exactly one visible; see the
  screen/VT section below). The
  acceptance test now holds for ALL four vendor apps. The outer-geometry
  queue is complete: 0023 (dynamic screen resolution), 0024 (scaling
  fixed-size clients) and 0025 (maximize) all landed 2026-07-08.
  **The desktop-shell round is queued 2026-07-08** (0028 start menu,
  0029 desktop icons, 0030 title-bar min/max boxes, 0031 taskbar polish,
  0032 window cycling, 0033 bug sweep — design in "The desktop shell"
  below).
- **Related**: `OS.md` Phase 3 (goals, agent-friendly requirements),
  `KERNEL.md` (kernel page, doorbell, 0x1xxx opcode reservation, AF_UNIX),
  `SDL3.md`/`WEBGPU.md` (the rendering runtime this retargets),
  `logs/2026-07-07/wm-design.md` (the design conversation, incl. measured
  kernel-overhead numbers).

## Goal and acceptance test

Overlapping windows on the os/ page, Win95-ish management (decorations,
taskbar, focus), driven by a WM that is itself a wasm client — with the
kernel owning surfaces, input routing, and pixels. **Acceptance test:
`SDL_CreateWindow` retargets to "create a surface", so every existing SDL
vendor app (doom, quake, snake, gameboy) becomes a windowed app with zero
source changes.** And per OS.md "agent-friendly by construction": window
enumeration, synthetic input, and screenshots are kernel ops that work
headlessly. **PASSED 2026-07-07** (todos/done/0015) for doom, snake and
gameboy — seeded in-OS via image.json `bin` game-data entries, verified
headless (`tests/kernel/test_os_apps_e2e.js`: histogram-checked
`wmctl shot` frames) and in Chromium (`tests/browser/os-doom.mjs`); **quake
joined 2026-07-08** (todos/done/0018 — the relative-mouse/pointer-lock
flag; status section below), completing the set.

## Fundamentals — the substrate mapping

Apps on a real OS do not draw on the screen. They render into buffers they
own, using their own GPU context, and hand finished frames to a compositor
that owns the display. The web platform has every piece of the modern
(Wayland/DRM) stack under different names:

| Real OS (Wayland/DRM) | This substrate |
|---|---|
| per-process GPU context (`/dev/dri` render node, DRM scheduler arbitrates) | `navigator.gpu.requestDevice()` in each process worker — the **browser's GPU process is the multiplexing kernel driver**, already shipping |
| dma-buf (GPU buffer handed to compositor, imported as texture, no readback) | `OffscreenCanvas.transferToImageBitmap()` → postMessage-transfer → `copyExternalImageToTexture` (GPU-side in Chromium) |
| wl_shm (software clients render into shared memory) | `SharedArrayBuffer` framebuffer — the same primitive as the kernel page / console ring / audio ring |
| direct scanout / overlay planes | a per-window DOM `<canvas>` composited by the browser (reserved, see `direct` transport) |
| compositor's scanout buffer | the kernel worker's master `OffscreenCanvas`, transferred from os.html at boot |
| software GL driver (Mesa llvmpipe / SwiftShader) | Dawn under Node (`webgpu` npm package) — a real WebGPU implementation on CPU; **we never write a rasterizer** |

## Invariants (the load-bearing decisions)

1. **Apps have exactly one interface: SDL3 / `webgpu.h`.** No port ever sees
   surfaces, transports, or backends. host.js and the kernel negotiate
   everything below that line.
2. **Per-process rendering is direct WebGPU on the process's own real
   device.** Every draw call, texture, and compute pass hits the worker's
   device with zero kernel involvement. The kernel never sees a draw call —
   only finished frames at present time. **GPU virtualization (one
   kernel-owned device proxied to processes) is rejected**: the browser's
   GPU process already is that multiplexer; re-serializing `webgpu.h` over
   worker RPC would be a second wire layer for negative benefit.
3. **There is always exactly one buffer: the swapchain image** — same as
   every OS (Vulkan swapchain, DXGI). The design adds no intermediate
   buffers to GPU apps; "present" means handing that frame over.
4. **Kernel pixel authority by default.** The kernel composites, so it can
   screenshot any surface, own z-order/hit-testing, and drive the headless
   twin. The one cost: frames cross to the kernel worker (one GPU copy per
   frame in the browser). The `direct` transport is the recorded zero-copy
   escape hatch, not the base.
5. **Mechanism in the kernel, policy in the WM client** (a wasm binary
   speaking a protocol over AF_UNIX — dogfooding todos/0008).
6. **Control plane over RPC, data plane over SABs/rings** (KERNEL.md
   discipline; the ~10µs RPC toll never lands on a per-frame or per-pixel
   path).

## The two axes: rendering backend × present transport

These are orthogonal, and conflating them was the main design wrong-turn to
avoid (see the dev log). *Backend* = who executes the app's rendering calls.
*Transport* = how finished pixels reach the compositor.

**Backends** (host.js is the driver loader; apps can't tell):

| Environment | `webgpu.h` backend | pixels |
|---|---|---|
| Browser | real `navigator.gpu`, one device per process worker | real, GPU |
| Node + `webgpu` pkg (Dawn) | Dawn — real WebGPU on CPU/Metal/Vulkan | real |
| Stock Node | null backend (exists today: handles returned, draws no-op) | none |

The SDL renderer (including `SDL_UpdateWindowSurface`) is already
implemented **on top of** `webgpu.h` — there is exactly one rendering
interface per environment and it is WebGPU. No software SDL rasterizer will
be written (decision, 2026-07-07): with Dawn available, a second renderer
implementation is pure maintenance tax.

**Transports** (a per-surface property host.js selects; invisible to apps):

| transport | present means | extra cost vs today | composites | kernel reads pixels? |
|---|---|---|---|---|
| `gpu` (browser default) | `transferToImageBitmap()` → transfer to kernel → `copyExternalImageToTexture` | 1 GPU→GPU copy/frame | kernel | yes (composited-texture readback) |
| `shm` (headless + CPU-present apps) | memcpy into the surface SAB, flip | CPU copy (what `UpdateWindowSurface` already pays today) | kernel | yes, bit-exact |
| `direct` (reserved) | native canvas present on a per-window DOM canvas | zero | browser | no |

Under Dawn there is no canvas: host.js's surface-texture seam hands the app
a plain `GPUTexture`, and present = `copyTextureToBuffer` readback into the
shm SAB — the kernel compositor cannot tell Dawn output from a CPU app.
If WebGPU ever ships cross-agent texture sharing, `gpu`'s present becomes a
zero-copy import at the same protocol point; nothing above changes.

## Surface protocol (kernel side)

`0x1xxx` opcodes (reserved in KERNEL.md; final numbering at implementation):

```
SURFACE_CREATE   (w, h, flags, title) → surface id (+ SAB for shm transport)
SURFACE_DESTROY  (id)
SURFACE_PRESENT  (id, frameSeq)        shm: flip notify; gpu: rides the
                                       bitmap's own postMessage (transfer)
SURFACE_SET_TITLE(id, title)
SURFACE_SET_FLAGS(id, flags)           flag-word update (todos/0018; 0x1006):
                                       bit0 borderless, bit1 relative-mouse,
                                       bit2 resizable (todos/0021)
SURFACE_CONFIGURE(id, w, h)            the client's resize ACK (todos/0019;
                                       new fb SAB rides the wm-sabs channel)
```

**shm SAB layout** (per surface): a 64-byte header — magic/version, w, h,
format (RGBA8), flip index (Atomics), frameSeq, damage rect (reserved) —
followed by two framebuffers (`w*h*4` each). **Mailbox semantics**: producer
writes the back buffer, flips, never blocks; newest frame wins; compositor
samples the front buffer at its own rAF cadence. No tearing, no
backpressure coupling between app frame rate and compositor.

**gpu transport lifetime discipline**: the kernel imports each arriving
bitmap then `close()`s it; if frames arrive faster than rAF, drop-oldest
(close unconsumed bitmaps immediately) — GPU memory must not balloon behind
a slow compositor.

**Input**: one input ring per process (fixed-size records, the console-ring
pattern), events tagged with the surface/window id — matching SDL's single
per-process event queue. host.js drains the ring into the wasm event queue
(`__sdl_push_*`); `SDL_WaitEvent` parks on the process doorbell like every
other blocking op.

**Lifecycle**: process exit/SIGKILL → kernel reclaims its surfaces (same
bookkeeping as pipes/OFDs), scene updates, WM notified. WM crash → kernel
keeps compositing raw surfaces (system stays usable), WM is respawnable.

## Compositor

Lives **in the kernel worker**. os.html transfers one master
OffscreenCanvas at boot (it stays the thin DOM bridge: input capture +
xterm). Per rAF (workers have rAF), the kernel walks its scene list —
the single source of truth for geometry/z/visibility/focus — and draws one
WebGPU render pass: z-ordered textured quads (shm surfaces upload via
`writeTexture`, gpu surfaces sample their imported textures), then window
chrome, then the cursor sprite (kernel-drawn cursor: deterministic,
headless-consistent).

Cost envelope: a full 1080p screen of windows is ~16MB of GPU-internal
traffic per frame ≈ 1GB/s at 60fps against hundreds of GB/s available; the
quad count is single-digit. Damage-rect optimization is deliberately
deferred.

*(Status: LANDED — `todos/done/0055`, 2026-07-09. os/compositor.js renders
this pass as the ONLY compositor: shm surfaces seq-gated into cached
per-surface GPUTextures via `writeTexture`, gpu surfaces imported once per
ImageBitmap via `copyExternalImageToTexture`, chrome as flat quads over a
1×1 white texture, title text + the close 'x' as cached label textures,
nearest sampling at the dst viewport. No Canvas2D fallback — WebGPU
missing in the kernel worker is a loud `boot-nogpu` guard
(kernel-worker.js probe + os.html screen). The kernel-drawn cursor sprite
is still not-yet (native browser cursor — see the deviations list). WebGPU
is the native rendering interface of the platform end to end: apps render
through `webgpu.h`, the compositor composites with it. Decision log
`logs/2026-07-09/webgpu-mvu-direction.md`, dev log
`logs/2026-07-09/webgpu-compositor.md`.)*

**Headless twin**: same scene list, no blit target. Screenshot of a surface
= copy bytes out of its SAB; screenshot of the screen = a ~40-line CPU
row-blit compositing the scene in z-order. PNG encoding lives in the test
harness. This is why shm is the headless workhorse: zero dependencies,
bit-exact goldens.

## Input routing

os.html captures DOM events raw and forwards them to the kernel (the
existing `sdlEvents` translation tables in host.js are reused, relocated to
feed rings instead of postMessage-to-one-app). The kernel hit-tests against
the scene list: client-area events → coordinate-transform → the owning
process's input ring; non-client (chrome) events → the WM protocol (drag
move, close button); everything keyboard → the focused surface. The analogy
is KERNEL.md's own: **focused surface : input routing :: foreground
pgroup : tty routing.** Focus policy (click-to-focus etc.) belongs to the
WM; the kernel just applies it. Pointer capture during WM drags is
kernel-enforced; relative-mouse mode (quake) is a surface flag that
round-trips to the UI bridge for pointer lock *(landed — todos/done/0018;
status section below)*.

## The WM client

`/bin/wm`, a wasm binary seeded via image.json, speaking a small framed
protocol over an **AF_UNIX socket** to a kernel-owned endpoint (the kernel
already natively owns socket peers). Events: surface created/destroyed/
title-changed/focus-changed. Commands: move, restack, focus, minimize,
request-close. The WM draws its own taskbar/desktop as ordinary shm
surfaces.

**Decorations — staged (decision)**:
- **v1: kernel-drawn chrome** with fixed Win95-ish metrics (title bar,
  close/minimize buttons as flat rects + baked bitmap font). Deterministic,
  cheap, and the kernel already needs non-client hit-testing geometry. The
  WM still owns all *policy* (placement, focus, stacking) via the socket.
- **v2: WM frame surfaces** (X11-reparenting-style): the WM renders
  decoration frames as its own surfaces and the kernel composites client
  surfaces inside them — full pixel-level Win95 fidelity, drawing moves out
  of the kernel. The v1 chrome path stays as the WM-crashed fallback.

**Resize: not in v1 (decision).** Client resize is the classically fiddly
part of every windowing protocol (buffer renegotiation, in-flight frames),
and every current GUI vendor app is fixed-size. v1 windows move, stack,
focus, minimize. `SURFACE_CONFIGURE` is reserved so resize lands additively.
*(It did — todos/done/0019; see "Implementation status — client resize"
below.)*

## The terminal (v2 LANDED, todos/done/0020: /bin/term, the pure path)

**The wasm terminal exists**: `/bin/term` (os/term/) is an ordinary SDL
surface app — kernel pty master + freetype cell-grid rendering + an
escape-sequence state machine scoped to what hush lineedit and busybox vi
actually emit under TERM=xterm-256color (CUP/CUU..CUB/CHA/VPA, ED/EL,
IL/DL/ICH/DCH/ECH, SU/SD, DECSTBM, SGR incl. 256→16 mapping, alt screen
?1049, ?25/?7/?1, DSR-6/DA replies, OSC title → SDL_SetWindowTitle). It
spawns its session (default `/bin/sh`, or `term cmd args...`) on the pty
slave as a pgroup leader; WINDOW_RESIZED → grid realloc + TIOCSWINSZ →
SIGWINCH reflow; closing the window HUPs the session (master close). Being
shm + pure CPU rendering, its screenshots are bit-exact headless — the
acceptance suite (`tests/kernel/test_term_e2e.js`, browser `os-term.mjs`)
asserts rendered text by pixels and drives vi inside it. Pty design:
KERNEL.md (status paragraph + the tty section).

xterm.js remains the BOOTSTRAP chrome — the system console pane beside the
desktop canvas (maintenance mode when the desktop is broken; see the VT
item, todos/0022). The old v1 idea of tracking xterm as a scene-positioned
`dom`-kind surface with clip-path cutouts is retired — the pure path made
it unnecessary.

## Agent control channel (OS.md hard requirement)

One op set, defined once, exposed twice:

- enumerate windows → id/title/geometry/z/focus/pid
- focus(id); synthetic key/pointer input **targeted at a window id**
  (injected into the same rings as real input, post-hit-test)
- screenshot(surface id | whole screen) — shm: SAB copy; gpu: kernel
  composited-texture readback; terminal: text serialization

Outside: the kernel's JS API (test harness, Node agents — no browser
needed). Inside: the same ops as RPCs/socket protocol, wrapped by a
`wmctl` binary (xdotool-as-a-syscall). `tests/kernel/` drives fake and real
surfaces through the real registry, input routing, and screenshots under
stock Node.

## Headless testing tiers

| tier | needs | covers |
|---|---|---|
| 0: stock Node (the floor, CI default) | nothing | everything but shader execution: protocol, lifecycle, input, WM, shm pixels (CPU-present test apps), screenshots — bit-exact |
| 1: Node + `webgpu` pkg (Dawn) | `pnpm add -D webgpu` (prebuilt Dawn, `dawn-gpu/node-webgpu`, active as of 2026-03) | real `webgpu.h` apps headless; readback→shm present tail; **tolerance-diff** assertions (GPU output is per-platform stable, not cross-platform bit-exact) |
| 2: Playwright + Chromium | browser | the real page: `gpu` transport, bitmap handoff, pointer lock, xterm layer |

Tier 1 is the repo's first package.json: devDependencies only,
`node_modules` gitignored, **nothing in compiler.js/host.js/kernel.js/os/
ever imports it** (host.js probes injected `navigator.gpu` → optional
`require('webgpu')` → null backend). The suite skips cleanly when absent —
same spirit as the manual Chromium tests. Core stays zero-dep, no build
step.

## Measured kernel overhead (context for transport choices)

`tests/kernel/bench_fs.js`, 2026-07-07, this machine — brokered (kernel
RPC) vs in-process BlockFS: write 8K 548 vs 1112 MB/s; read 8K 462 vs
1159 MB/s; metadata ~100k vs ~705k ops/s ⇒ **~10µs per RPC round-trip**.
Also note: the kernel worker is single-threaded, so syscall service is a
*system-wide* ~100k ops/s ceiling shared by all processes. Consequences for
this design: presents and input ride SABs/rings (per-frame, not per-call,
and never per-pixel RPCs); compute and GPU draw calls pay nothing.

## Open questions (tracked, not blocking)

- ~~**Audio mixing**~~ — designed + landed (todos/0017); see "Audio mixing —
  the kernel sound server" below.
- **`direct` transport promotion** — light it up when a fullscreen app
  measurably wants the copy back; needs the two-hop OffscreenCanvas
  transfer spike.
- ~~**wasm terminal app**~~ — landed with the pty layer (todos/done/0020);
  see "The terminal" above.
- **Damage rects / partial present** — optimization, after correctness.
- **Cross-agent WebGPU sharing** — if the spec ships it, `gpu` present
  becomes zero-copy at the same seam.
- ~~**Screen geometry / VTs / scaling fixed-size clients**~~ — designed
  below ("Screen, VTs, and scaling fixed-size clients"); VT switching
  LANDED (todos/done/0022), dynamic screen resolution LANDED
  (todos/done/0023), viewport scaling LANDED (todos/done/0024),
  maximize LANDED (todos/done/0025). The block is complete.
- **The desktop shell** — start menu, desktop icons, title-bar
  min/max boxes, taskbar polish, window cycling: designed below ("The
  desktop shell"), queued as todos/0028–0033.

## Screen, VTs, and scaling fixed-size clients (design, 2026-07-08)

Where the desktop's outer geometry stands. All four pieces LANDED:
VT switching (todos/done/0022), dynamic screen resolution
(todos/done/0023), scaling fixed-size clients (todos/done/0024),
maximize (todos/done/0025 — nearly pure policy by then, dispatching on
0021's resizable flag for both branches: configure vs 0024
scale-to-fit).

**Today** (post-0023): on VT2 the screen tracks the browser viewport
(the #desktop pane; 1 CSS px = 1 screen px, DPR deliberately ignored);
VT1 resizes still only re-fit xterm, and headless stays at the kernel
default until an embedder calls `wmSetScreen`.

**VT switching (todos/done/0022 — LANDED 2026-07-08)** — the Linux
console metaphor: the xterm tty is VT1, the desktop VT2; the page shows
exactly one (`body[data-vt]` CSS), switched with the Terminal/Desktop
tab bar (the primary, discoverable affordance) or Ctrl+Alt+F1/F2 (+
Ctrl+Alt+1/2) aliases on a window-capture listener; boot lands on VT1. The point is availability under
partial failure, not layout: VT1's path is kernel worker + xterm only —
no compositor, no wm, no GPU — so it stays fully usable while the
desktop is broken or merely suspect. It remains the escape
hatch/bootstrap chrome even after 0020 puts the everyday terminal in a
window (halt/boot-error force VT1). Pure UI-bridge work, zero kernel
change; the kernel keeps compositing while hidden (frames are mailbox —
bounded cost). Pointer lock is exited on leaving VT2 (requests gated to
VT2) and re-arms per 0018 on the next client click; VT2→VT1 releases
synthetic Ctrl/Alt keyups into the focused surface (stuck-modifier
fixup). Acceptance: `tests/browser/os-vt.mjs` (incl. kill-the-wm
maintenance mode); dev log `logs/2026-07-08/vt-switching.md`.

**Dynamic screen resolution (todos/done/0023 — LANDED 2026-07-08)** —
the RandR / wl_output shape: the display owner sets the mode, everyone
else gets an event. os.html measures the #desktop pane on VT2 entry +
debounced window resizes → `{type:'screen-resize'}` → the kernel worker
resizes the OffscreenCanvas (a transferred canvas can't be resized from
the page) and re-calls `wmSetScreen`, which now emits WMP **EV_SCREEN
{w,h}** (0x87) to subscribers and one-shot-clamps non-borderless window
positions (drag-clamp bounds) so the NO-WM fallback stays usable after
a shrink. /bin/wm on EV_SCREEN: re-lays the taskbar by destroy +
recreate (no client-initiated resize, by 0019's design), restores the
focus the create stole, and re-clamps windows with its taskbar-aware
policy (clamp, never re-cascade). SUBSCRIBE's reply dims are now just
the initial mode. Acceptance: `tests/browser/os-screen.mjs`, EV_SCREEN
legs in `test_wm_policy.js`; dev log
`logs/2026-07-08/dynamic-screen-resolution.md`.

**Maximize (todos/done/0025 — LANDED 2026-07-08**; rides 0021's flag).
Real-OS shape (Windows work area, EWMH
`_NET_WM_STATE_MAXIMIZED`/`_NET_WORKAREA`, xdg_toplevel.set_maximized):
double-click title toggles; the WM sends MOVE + RESIZE to the work area
(screen minus taskbar); restore returns to saved geometry. Fixed-size
windows get the scale-to-fit below instead — same gesture, dispatched
on the flag (Windows greys the maximize box; we're friendlier): a
centered aspect-fit SET_DST whose integer snap is suppressed when it
would overflow the work area. Mechanism/policy split: the kernel only
detects the double-click (WM_DBLCLICK_MS 400 + 4px slop, event
timestamps threaded from the page so worker latency doesn't eat the
gesture) and emits **EV_TITLE_ACTIVATE 0x8A**; wm.c owns the maximized
set + saved geometry and re-fits on EV_SCREEN. `wmctl max SID` sends
**ACTIVATE 0x18**, which the kernel turns into the SAME event — one
policy path; R_ERR with no subscriber (no WM = no maximize, unlike
kernel-implemented minimize). A wm restart forgets maximize state
(restarting the WM tidies the desktop, as with placement). Acceptance:
maximize legs in `tests/browser/os-wm.mjs` (resizable) +
`os-scale.mjs` (fixed-size), test_wm/test_wm_policy/
test_wm_service_e2e; dev log `logs/2026-07-08/maximize.md`.

**Scaling fixed-size clients (todos/done/0024 — LANDED 2026-07-08)**.
The converged real-OS answer decouples buffer size from window size and
lets the compositor map one to the other: Wayland `wp_viewport` (client
buffer at native res, compositor scales to a dst rect), DWM DPI
virtualization (non-DPI-aware apps bitmap-stretched, app never knows),
SDL3's own logical presentation. Ours: a per-surface **dstW×dstH** in
the scene (default = buffer), one op set exposed everywhere —
`wmSetDst` / WMP `SET_DST` (+ `EV_SCALED` echo) / `wmctl scale`; the
window record grew to 80 bytes carrying dst dims. Non-resizable
surfaces are scalable-not-configurable; SET_DST on a RESIZABLE surface
is refused (exclusive modes — 0025's maximize dispatches on the same
bit). Browser compositor: per-surface scratch-canvas cache →
`drawImage` src→dst, smoothing off. Headless composite: nearest-
neighbor loop (integer scales replicate exactly). Hit-testing/chrome/
clamps run on dst dims; client-bound pointer records inverse-map
through the scale (`wmInjectPointer` stays buffer-coords by design).
Frame drags on fixed-size surfaces rubber-band and emit **EV_SCALE_REQ**
at release; /bin/wm answers with an aspect-fit, integer-snapped (±15%)
SET_DST; with no WM the kernel applies the raw box. DOOM/quake/gameboy
scale with zero source changes. Acceptance:
`tests/browser/os-scale.mjs` (+ the inverted os-quake grip leg), 0024
legs in test_wm/test_wm_policy/test_wm_service_e2e; dev log
`logs/2026-07-08/viewport-scaling.md`.

## The desktop shell (design, 2026-07-08 — queued: todos/0028–0033)

What turns the WM from window plumbing into a desktop: launcher, desktop
icons, the missing title-bar boxes, taskbar polish, window cycling — plus
a repeatable bug-sweep format now that the surface area is big enough to
dogfood. Verified substrate facts this design leans on (checked against
the code, not assumed):

- **wm.c can own many windows.** The shm flavor supports N surfaces per
  process; input-ring records carry the surface id, host.js maps it to
  the per-window handle at drain (host.js `drainInput`), and the SDL
  event structs expose it — `e.button.windowID` etc. are filled on every
  push (compiler.js runtime). Taskbar + menu + desktop layer live in the
  one wm process, dispatched per event by windowID.
- **WMP RESTACK place=1 already means "send to bottom"**, and borderless
  surfaces receive client clicks but never steal focus — the taskbar's
  own mechanics, reused verbatim by the desktop layer. (Since
  todos/0038 the desktop pin is SET_LAYER -1 — a real pin, not a
  one-shot restack.)
- **A click that hits no surface is invisible to the WM** (the kernel
  hit-test returns `'desktop'` to the embedder only, no WMP event). The
  desktop LAYER fixes this as a side effect: once a fullscreen wm
  surface sits at the bottom of z, every "desktop" click is an ordinary
  client click on it. No protocol addition needed.
- **opendir/readdir and posix_spawn are available to seeded apps**
  (protoshell.c is the in-repo pattern for both); wm.c just doesn't
  include those headers yet.

**Start menu (todos/0028).** A ~50px Start button at the taskbar's left
(window buttons shift right); click creates a borderless menu surface
above it, destroyed on selection or dismiss. Entries come from
**/etc/menu** (seeded via image.json): a symlink is exec'd directly, a
one-line text file is an argv line (covers tty apps: `term snake`) —
name = filename, plain sort. Selection → `posix_spawn` (PATH=/bin,
cwd=/root — doom finds its WAD by cwd). *(The first-line-argv format was
retired by todos/0066: launching is one `activate()` — symlinks and
runnable files (wasm magic / `#!` scripts, todos/0065) spawn, everything
else opens in the viewer; launcher entries are ordinary `#!/bin/sh`
scripts now.)* Dismiss: menu-surface click
outside an entry, EV_FOCUS change, taskbar click; desktop clicks join
at 0029 (until then a desktop click doesn't dismiss — accepted gap).
Open question to resolve in-item: **child stdio** — the wm is a
parentless service, so spawned apps get no fd 0/1/2; verify writes to a
missing fd are harmless (doom printf's at startup) or give children
/dev/null-ish fds via spawn file actions.

**Desktop icons (todos/0029).** A fullscreen borderless wm surface,
pinned to the bottom z layer at create (SET_LAYER since todos/0038;
originally a one-shot RESTACK), teal fill (it covers the compositor's
background wherever it sits) + an icon grid from
`readdir("/root/Desktop")` (seeded: symlinks to doom/quake/gameboy/
term). Double-click (SDL event timestamps, the 0025 threading):
symlink → spawn its target; other regular file → `term vi <file>`
*(since todos/0066: the shared `activate()` — runnable files spawn too)*.
Recreate on EV_SCREEN like the taskbar; re-read the folder on a coarse
frame-tick timer (~1s — one readdir RPC/s, no watch API exists or is
needed). Minimize already reveals it; nothing kernel-side changes.

**Title-bar buttons (todos/0030).** Today the bar has ONE box (close).
Add minimize and maximize boxes left of it — Win95 order
[min][max][close], the close box's 16px metrics. The mechanism/policy
split follows 0025 exactly: the **minimize box calls kernel
`wmMinimize` directly** (kernel-implemented, works with no WM — the
precedent is minimize being kernel mechanism already); the **maximize
box emits EV_TITLE_ACTIVATE** — the double-click's event, so wm.c's
existing toggle handles it unchanged (no WM → same R_ERR/no-op as
`wmctl max`). Hit zones in `wmPointer`'s title branch; boxes drawn in
both flavors (os/compositor.js + the headless composite), glyphs as
flat rects in the chrome style.

**Taskbar polish (todos/0031).** A right-aligned clock (`time()` + the
5×7 font, minute granularity); **stable button order** (the `wins[]`
swap-remove — wm.c `wins[i] = wins[--nwins]` — reshuffles buttons on
any close; keep launch order like Win95); **button overflow** (shrink
button widths once they'd run past the clock, rather than off screen).

**Window cycling (todos/0032).** The one shell piece needing new kernel
mechanism: every key goes to the focused surface and there is no grab.
Add a kernel-recognized chord at the key-routing seam (`wmKey`) that
emits **WMP EV_CYCLE** (next free event id, direction word for
shift-reversal) instead of delivering the key; wm.c cycles focus
through non-minimized surfaces in z-order. **No subscriber → no
interception**: the chord passes through to the focused app like any
other key (decision, 2026-07-08 — the kernel never silently eats
keystrokes, and cycling is purely WM policy per the maximize
precedent; maintenance mode is covered by mouse click-to-focus and
VT1). Chord choice is
browser-constrained: OS-level Alt-Tab never reaches the page on
Windows/Linux — pick a deliverable chord (the Ctrl+Alt family, aligning
with the VT chords; decide in-item) and document it in the tab-bar
tooltip per the discoverability rule. `wmctl cycle` is the agent
exposure (same path as the chord, per "one op set, exposed twice").

**Bug sweep (todos/0033, repeatable format).** One session: drive the
whole browser suite in real Chromium, then free-form dogfood storms
(open-everything, drag/scale/maximize storms, `kill -9` storms, wm
kill/respawn, VT flips mid-drag) against the standing known-issue list
(pointer-lock UX needs a human check — Playwright can't grant it;
os-gpubox adapter flake; Dawn + SIGKILL process abort; cross-instance
unlink-while-open). Findings become minimal repro tests FIRST
(conformance-corpus discipline), fixes land as separate commits.
Subsequent sweeps allocate new numbers when scheduled — round 3 is
`todos/0064` (the pointer-lock HUMAN check, deferred by rounds 1 AND 2,
is its non-negotiable MUST).

## Known issues (standing list; round 1 = 2026-07-08 todos/done/0033, round 2 = 2026-07-09 todos/done/0039)

Verified-but-unfixed, each with a repro. Re-check every sweep; entries
graduate to queue items when a fix is scheduled.

- ~~**The taskbar is not always-on-top.**~~ **FIXED in todos/0038**
  (2026-07-08) by kernel z layers, **RETIRED after round 2**: held under
  the 0039 layer storm (29 op-by-op invariant snapshots) and a browser
  4-window pile-on with clicks through the overlap. Regression legs in
  test_wm_policy.js / test_wm_service_e2e.js / os-wm.mjs.
- ~~**The focus fall landed on pinned furniture.**~~ **FOUND + FIXED in
  round 2 (todos/0039)**: after 0038 the destroy/minimize focus fall
  (topmost non-minimized surface) parked keyboard focus on the
  always-top taskbar. `_wmFocusFall` now prefers the topmost
  normal-layer window; furniture only takes the fall when nothing else
  remains. Legs in test_wm_policy.js / test_wm_service_e2e.js.
- **Pointer-lock UX needs a HUMAN check each round** (Chromium denies
  CDP-gesture lock requests, so Playwright cannot exercise it): quake
  lock on client click, ESC unlock, click re-lock, VT-switch release.
  Mechanics covered by `test_wm.js`/`os-quake.mjs` up to the browser
  lock grant itself. **Deferred in rounds 1 AND 2** (operator away at
  round-2 close; anecdotally fine in regular use) — a MUST for round 3
  (`todos/0064`, which numbers this so it cannot slip a third time).
- **snake needs two paced `q`s to quit** (vendor exit-prompt loop spins
  on EOF; documented since 0015). Vendor quirk, not worth patching.
- **Dawn + SIGKILL abort (S3 caveat) — SHRUNK, keep watching**: rounds 1
  AND 2 (storm leg + isolated retest each, webgpu 0.4.x) survived
  `kill -9` of a live gpubox with no Node abort. The drain discipline
  stays (GPU apps quit via SDL_Quit); retest per sweep before relying
  on it.
- **os-gpubox adapter flake: quiet for two rounds** (headless Chromium
  adapter came up in all runs, rounds 1 + 2). Environmental; one more
  quiet round and it can drop off the list.
- ~~**First-frame teleport.**~~ **FIXED in todos/0069** (2026-07-10) by
  map-on-placement: with a WMP subscriber, `SURFACE_CREATE` makes the
  surface UNMAPPED — skipped by both compositor flavors and the hit
  test (still listed/focusable/injectable/SHOT-able) — until the WM's
  first geometry/stacking op on the sid (MOVE/RESIZE/SET_DST/SET_LAYER/
  RESTACK; wm.c's `EV_CREATED` → `WMP_MOVE` doubles as the map ack, so
  wm.c needed zero changes). Foreign borderless surfaces (wm.c ignores
  them — owner-positioned taskbar-class) map at create; the subscriber's
  OWN borderless furniture (the start menu, the worst repro) waits for
  its self-park. Backstops: `WM_MAP_TIMEOUT_MS` (200ms) maps anything a
  wedged WM never places, and last-subscriber-gone maps all pending — a
  dead WM can never hide windows. No subscriber → mapped at create (the
  no-WM fallback is byte-identical to pre-0069). Legs in test_wm.js /
  test_wm_policy.js + the os-shell.mjs first-frame burst capture.

Round-1 non-issues worth remembering: the 0029 icons broke os-doom/
os-quake's "desktop restored = pure teal" asserts (test expectations,
fixed to icon-tolerant thresholds in the 0033 commit); hush `kill` of
the wm is cooperative SIGTERM — tests must barrier on surface
reclaim, not the kill returning (bit os-wm.mjs during 0032).

Round-2 notes (2026-07-09): a wm respawn puts the NEW desktop above an
agent-`wmctl layer -1`-pinned window (within-band arrival order — the
same stable-sort semantics that stack the menu above the bar; by
design, not worth policy). Storm-authoring gotchas for round 3 live in
`logs/2026-07-09/wm-bug-sweep-2.md` (bar-strip pixels are button
chrome, taskbar-button focus-then-minimize semantics, `&;` hush parse
error, `__osScreen` only tracks the viewport on VT2).

## Implementation status — z layers (landed 2026-07-08, todos/0038)

**Decision: kernel mechanism, not reactive wm.c policy.** Each surface
carries a z LAYER (-1 bottom / 0 normal / +1 top, default 0; record
word 11, the ex-reserved slot), set via **WMP SET_LAYER 0x1A** /
kernel-JS `wmSetLayer` / `wmctl layer SID -1|0|1` (`wmctl list` FLAGS
grow a `T`/`B` char for pinned surfaces). Every z mutation —
create-push, focus-raise, RESTACK raise/lower — is followed by a
STABLE sort of `_zOrder` by layer (`_wmZNormalize`), so an op lands at
the top/bottom of its OWN layer and can never cross a boundary: the
pinned taskbar stays above any create/raise/drag, and a RESTACK lower
can never sink a window under the pinned desktop layer (the same
problem mirrored — one mechanism fixes both). Rationale over the wm.c
re-raise-on-EV_MOVED shape: airtight (no one-composited-frame overlap),
and wm.c could not even SEE a `wmctl lower`-driven violation (RESTACK
has no event). Policy still decides WHICH windows are furniture: wm.c
pins its taskbar + Start menu to +1 and the desktop layer to -1 on
their EV_CREATED echoes (the menu is created after the bar, so the
stable sort keeps it above within the layer); the no-WM fallback never
sets layers, so kernel-chrome behavior is untouched. No new event —
subscribers see the layer in EV_CREATED/LIST records. Tests: 0038 legs
in test_wm_policy.js (scripted client: pinning, boundary-crossing
attempts, strip composite + hit-test), test_wm_service_e2e.js (real
wm.c furniture pins, wmctl raise/list), os-wm.mjs (real drag onto the
strip; bar stays visible and its buttons clickable through the
overlap). Image v27.

## Implementation status v1 (landed 2026-07-07, todos/0013)

**What shipped** (all tested; suites: `tests/kernel/test_wm.js`,
`test_wm_e2e.js`, browser `tests/browser/os-wm.mjs`):

- **kernel.js "WM surfaces"**: registry + z-order + focus, 0x1xxx RPCs
  (CREATE/DESTROY/SET_TITLE), shm double-buffer SABs (process-allocated,
  handed over via `{type:'wm-sabs'}` on the FIFO channel — the kernel can't
  post to a parked worker), per-process input ring (kernel producer, drop-
  newest, doorbell wake), kernel-chrome v1 policy (click-to-focus, title
  drag with capture + clamping, close box → SDL_EVENT_QUIT), agent channel
  (`wmList/wmFocus/wmMove/wmInjectKey/wmInjectPointer/wmScreenshot/
  wmScreenshotScreen` — the last is the ~40-line CPU composite), lifecycle
  reclaim on exit AND SIGKILL.
- **host.js `createSurfaceSDL`**: auto-selected when spawnHooks carry the
  surface ops. Browser flavor = full WebGPU SDL renderer on a worker-local
  OffscreenCanvas + per-present `transferToImageBitmap` handoff
  (`{type:'wm-frame'}`); headless flavor = null renderer + real windows.
  **`SDL_UpdateWindowSurface` rides shm in BOTH flavors** (no GPU
  dependency for CPU-present apps — doom-class apps display even where
  nested-worker WebGPU is unavailable). Input-ring drain before every
  frame tick.
- **os/compositor.js** (kernel-worker side): ONE WebGPU render pass per
  rAF (todos/done/0055; was Canvas2D in v1) — desktop clear, shm surfaces
  as seq-gated `writeTexture` uploads into cached per-surface GPUTextures,
  gpu surfaces imported once per ImageBitmap via
  `copyExternalImageToTexture`, chrome as flat quads over a 1×1 white
  texture, title text + the close 'x' as cached label textures (rasterized
  through a throwaway 2D canvas — a texture source, not scene assembly).
  No fallback: kernel-worker.js's `boot-nogpu` guard is the failure mode.
  `routeInput` maps the bridge's raw events through SDL_WEB's tables into
  `wmKey`/`wmPointer`.
- **os/os.html**: desktop canvas pane (natural size; 800×500 at boot,
  viewport-tracking on VT2 since todos/done/0023) transferred to the
  kernel worker; raw input forwarding (keys as plain objects with a
  getModifierState shim; pointer in canvas coords).
- **os/winbox.c** seeded as `/bin/winbox` (image.json v9): the windowed
  demo/acceptance app (`winbox &` from hush).
- **runModule exit-ordering fix** (host.js): with a frame callback
  registered at main-return, the C exit path (atexits + the OS EXIT
  handshake) is DEFERRED until the frame loop stops — it used to run
  first, which killed OS processes before their first frame.
- **Nested-worker rAF**: `requestAnimationFrame` exists but THROWS in
  workers-of-workers (Chromium); host.js latches to a setTimeout(16) pacer
  on first failure.

**Deliberate v1 deviations from the sections above** (revisit at v2):

- **Present is pure SAB** (flip + seq, mailbox) — no SURFACE_PRESENT RPC at
  all; 0x1004 stays reserved for damage tracking.
- ~~**Compositor is Canvas2D**~~ — CLOSED (landed 2026-07-09,
  `todos/done/0055`): the WebGPU pass this doc designed is now the ONLY
  browser compositor. **No Canvas2D fallback** — a fallback is two
  compositors with one a permanently undertested zombie; WebGPU
  unavailable in the kernel worker → a loud `boot-nogpu` guard screen
  (the 0045 pattern), never quiet degradation. Headless (`boot.js`,
  kernel suite, the deterministic CPU screenshot composite) is
  unaffected — it never had a compositor. Rationale in
  `logs/2026-07-09/webgpu-mvu-direction.md`.
- **Terminal is a separate pane**, not a scene-positioned privileged DOM
  surface yet — the split layout was the honest v1; the positioned-xterm
  (clip-path) design stays queued.
- **Cursor is the native browser cursor** (no kernel sprite; headless
  composite has no cursor).
- **One window per process in the browser gpu flavor** (one OffscreenCanvas
  — same as the standalone runtime); the shm flavor supports many.
- ~~**Audio in OS processes stays null**~~ — lifted by todos/0017 (the
  kernel sound server; see "Audio mixing" below).

## Implementation status — the WM client (landed 2026-07-07, todos/0014)

Policy is out of the kernel. What shipped (suites: `test_wm_policy.js`
scripted-client, `test_wm_service_e2e.js` real binaries over os/boot.js,
browser `os-wm.mjs`):

- **Kernel-owned AF_UNIX endpoints** (`sockServe` — KERNEL.md "Kernel-owned
  endpoints") and the framed WM protocol server on **/run/wm.sock** (spec:
  kernel.js `WMP` block, MUST MATCH `os/wm_proto.h`). Events out
  (CREATED/DESTROYED/TITLE/FOCUS/MOVED/MINIMIZED + subscribe snapshot),
  commands in (MOVE/FOCUS/MINIMIZE/RESTORE/RESTACK/CLOSE_REQ/LIST/
  INJECT_KEY/INJECT_POINTER/SHOT/SHOT_SCREEN).
- **Carrier decision**: `wmctl` is just another socket client — the agent
  op set gained its second exposure with ZERO new opcodes ("one op set,
  defined once, exposed twice" held literally).
- **/bin/wm** (os/wm.c, seeded): subscribes, places windows (cascade clear
  of the taskbar strip), draws the taskbar as a **borderless** SDL shm
  surface (SDL_WINDOW_BORDERLESS → surface flags bit0: no kernel chrome,
  and no click-to-focus steal — a taskbar click must see the focus state
  it acts on). Button click focuses/restores; the active window's button
  minimizes (the Win95 toggle). Autostarted at boot via `Kernel.service()`
  (parentless, auto-reaped, non-fatal if missing).
- **/bin/wmctl** (os/wmctl.c, seeded): list/focus/min/restore/close/raise/
  lower/move/key/click/shot (PPM out) — xdotool-as-a-syscall from hush.
- **Crashed-WM story verified**: kill /bin/wm → its surfaces are reclaimed,
  kernel-chrome fallback keeps the system driveable (the endpoint is the
  KERNEL's, so wmctl keeps working), and `wm &` respawns it — the snapshot
  re-places the scene (deliberate: a WM restart tidies the desktop).
- New surface state: `minimized` (+ EV_MINIMIZED both ways) and
  `borderless`. Minimizing the focused window falls focus to the top
  non-minimized surface; focus/restore un-minimizes.

Still kernel-side at v2: title-bar DRAG and the close box (kernel chrome) —
moving those to the WM needs frame surfaces or a pointer-grab protocol;
placement/stacking/minimize policy is already the WM's.

## Implementation status — GPU apps + the Dawn tier (landed 2026-07-08, todos/0016)

The first real `gpu`-transport consumer and the tier-1 suite from the table
above (suites: `test_gpubox_dawn_e2e.js` in the kernel run, browser
`os-gpubox.mjs`; dev log `logs/2026-07-08/webgpu-demo-dawn-tier.md`):

- **/bin/gpubox** (os/gpubox.c, seeded): SDL window + direct `webgpu.h`
  rendering (lambert-shaded cube, per-face flat colors, frame-indexed
  rotation; `-f N` freezes a pose for tolerance-diff shots). Same binary in
  all three environments — invariant 1 held.
- **`wgpuSurfacePresent` is now a real host import** (`__wgpu_surface_present`)
  — no-op on a DOM canvas (present stays implicit), the ImageBitmap handoff in
  the browser OS flavor, the readback tail under Dawn.
- **Dawn present tail exactly as designed** ("The two axes"): host.js's
  surface seam hands the app a plain `GPUTexture`; present =
  `copyTextureToBuffer` → shm SAB mailbox flip — kernel screenshots cannot
  tell Dawn output from a CPU app. Formats: rgba8unorm preferred, bgra8unorm
  swizzled, anything else fails loud.
- **Lazy optional probe**: `require('webgpu')` fires only on a process's first
  `wgpuInstanceRequestAdapter`; stock Node yields a clean adapter-unavailable
  (tier 0 unchanged, zero-dep core kept — the root package.json stays
  devDependencies-only).
- **S3 caveat discipline**: all Dawn promises are tracked; `ctx.gpuDrain`
  (allSettled + device.destroy) runs before the deferred EXIT handshake. GPU
  apps must quit via `SDL_Quit()`, not `exit()`-in-frame-callback; SIGKILL
  mid-frame remains the accepted crash risk of the optional tier.
- The browser `gpu` flavor's one-window-per-process v1 limitation was
  exercised and stands unchanged (gpubox is one window).

## Audio mixing — the kernel sound server (design + landed, todos/0017)

The sound-server analog of the compositor: N per-process source rings in,
ONE page-owned output ring out, the kernel worker mixing between them on a
timer. Same substrate mapping as everything else here — a ring is a SAB,
the mix is pure math, the page stays a dumb playback bridge.

**Rings.** Every ring (source and output) reuses the EXISTING standalone
audio-ring layout (host.js `createSharedAudioBuffer`: 16-byte header
`[writePos, queuedBytes, playing, reserved]` + PCM bytes; writePos masked
mod capacity, `queuedBytes` the single Atomics synchronization cell). What
changes is who sits on each end:

- **Source rings** — one per SDL audio device, allocated by the PROCESS
  (host.js `createSurfaceSDL`, which previously null-stubbed audio) and
  registered with the kernel via `AUDIO_OPEN` (0x2001; `AUDIO_CLOSE`
  0x2002) — the SAB rides a `{type:'audio-sab'}` message immediately
  before the RPC, the exact `wm-sabs` FIFO handshake. The process is the
  producer (`__sdl_queue_audio`, byte-identical discipline to the
  standalone path), the kernel mixer the consumer. The `playing` header
  cell is written by the PRODUCER here (SDL3 devices open paused;
  `SDL_ResumeAudioStreamDevice` sets it) — the mixer skips paused rings.
- **Output ring** — allocated by the kernel (`kernel.audioInit()`),
  fixed format **f32 stereo 48kHz**, handed to the page once at boot
  (`{type:'audio'}` from kernel-worker). The page runs host.js's existing
  `createAudioReceiver` over it VERBATIM (one synthetic `audio-open`) —
  the whole Web Audio scheduling path is reused, and the AudioContext
  autoplay gate is one `resume()` on first user gesture.

**Format/rate normalization** happens kernel-side at mix time, per source
frame: decode (S16/S32/F32/U8/S8 at any sane rate, mono or stereo) →
float, linear-interpolation resample to 48k on a persistent fractional
cursor, mono duplicated to both channels, sum across streams, clamp to
[-1, 1], write f32 interleaved. Unsupported channel counts (>2) are
EINVAL at open — fail loud, per house rules.

**Pacing.** `kernel.audioPump()` runs on a 20ms interval in the kernel
worker (tests call it directly with an explicit frame budget —
deterministic, no timers). Each pump tops the output ring up to a fixed
target depth (~80ms), bounded by the MOST-available active stream — so
one starved app pads with silence rather than stalling another's audio,
and a lone app never has silence manufactured ahead of its data. Apps
self-pace against `SDL_GetAudioStreamQueued` (ring + C-side backlog), so
a stalled consumer (page pre-gesture, headless with no pump) costs
bounded memory: ring fills, app stops pushing — exactly the standalone
page's pre-gesture behavior.

**Lifecycle** (the never-wedge rule): `AUDIO_CLOSE`, process exit, and
SIGKILL all mark the stream *dying*; a dying stream keeps contributing
until its ring is DRY (queued sfx finishes — "drain"), then is reclaimed;
a dying ring that is paused (or when no output ring exists) is dropped
immediately (nothing will ever drain it). Reclaim runs inside the pump,
so a dead process can never stall the mixer — same discipline as fd and
surface reclaim in `_exitProcess`.

**Headless** stays tier 0 with zero setup: `os/boot.js` doesn't call
`audioInit`, streams still register, apps self-pace, nothing plays. The
deterministic mix tests (`tests/kernel/test_audio.js`) drive `audioInit`
+ `audioPump` directly over fake workers: exact-value mixes (same-rate
S16, resample ratios, mono fan-out, two-stream sum, clamp), cursor
continuity across pumps, pause semantics, drain-on-close, SIGKILL
reclaim mid-play.

Deliberate v1 limits: no per-stream volume/pan (the receiver's master
gain is the only knob), no output-rate negotiation (48k fixed), linear
(not windowed-sinc) resampling, `SDL_ClearAudioStream` uses a racy-but-
self-healing `queuedBytes` store-0 (the mixer clamps a negative
underflow back to 0 — worst case a clear drops a few already-mixed
bytes, which is what clear means anyway).

## Implementation status — client resize (landed 2026-07-08, todos/0019)

The deliberately-deferred fiddly part, landed additively on the reserved
opcode (suites: `test_wm.js` renegotiation section, `test_wm_policy.js`
RESIZE/EV_CONFIGURED, `test_wm_e2e.js` real-C resize leg,
`test_gpubox_dawn_e2e.js` Dawn resize leg, browser `os-wm.mjs` drag-resize
+ `os-gpubox.mjs` wmctl-resize; dev log `logs/2026-07-08/surface-resize.md`):

- **Protocol shape**: resize is KERNEL-initiated. The request rides the
  input ring (`WINDOW_RESIZED` 0x206 record, words [2]=w [3]=h — the ring
  is the existing kernel→process channel); the ack is the
  `SURFACE_CONFIGURE` RPC (0x1005) whose NEW fb SAB rides `{type:'wm-sabs'}`
  exactly like at create, and whose front buffer already holds the first
  frame at the new size — the kernel swaps buffers atomically at the ack,
  so the compositor never sees a torn or partial frame. Until the ack the
  old SAB stays on screen at the old geometry; host.js keeps routing
  old-size in-flight presents into the OLD buffer, so a slow adopter stays
  live mid-negotiation (mailbox semantics preserved throughout).
- **Latest wins**: a new request while one is pending replaces it; a stale
  ack is ACCEPTED (the buffer is newer than what's on screen) and the
  kernel immediately re-issues the configure for the still-pending size.
  A request that can't reach the client (dead process, full ring) leaves
  no pending state — nothing would ever ack it.
- **Chrome**: non-borderless windows grew a `WM_BORDER` (4px) Win95-ish
  frame around title+client — same numbers in hit-testing, the browser
  compositor, and the headless composite. Drag zones: right edge → E,
  bottom edge → S, within `WM_GRIP` (16px) of the corner → SE; left/top
  edges are focus-only (moving-edge resizes deliberately deferred). Drags
  preview as a rubber-band outline and send ONE configure at release
  (Win95 outline semantics — no per-motion SAB churn). Floor:
  `WM_MIN_SIZE` (32px) per axis.
- **Client side**: `SDL_EVENT_WINDOW_RESIZED` (+ the 0x202–0x207 window
  event block, `SDL_WindowEvent`, `SDL_GetWindowSize`) landed in the SDL3
  layer; the C runtime re-derives the window surface in place at event
  push (pixel allocation only ever grows — high-water — so stale-size
  drawing can't corrupt the heap). gpu transport resizes the worker-local
  OffscreenCanvas; a webgpu.h app reconfigures its surface + depth (the
  canonical dance, now in gpubox.c); under Dawn the reconfigure recreates
  the readback texture/buffer and the ack rides the shm present tail.
- **Second exposure**: `wmResize` (kernel JS) / `WMP RESIZE` + `EV_CONFIGURED`
  (socket protocol) / `wmctl resize SID W H` (shell) — one op set, defined
  once, exposed everywhere, per the agent-channel rule.
- **Resizable gating (landed 2026-07-08, todos/0021)**: SDL3 semantics —
  a window is non-resizable unless created with `SDL_WINDOW_RESIZABLE`
  (0x20), which host.js maps to kernel surface-flag bit2 at create (and
  through SURFACE_SET_FLAGS). Every resize path dispatches on it: frame
  hit-testing on a non-resizable surface has NO drag zones (the whole
  frame is a focus affordance, like left/top edges), and `wmResize` /
  WMP `RESIZE` / `wmctl resize` refuse with an error, leaving no pending
  configure. Fixed-res apps (doom, quake, gameboy — `flags=0`) can no
  longer be sheared by a drag-resize they never handle; winbox/gpubox/term
  declare the flag and renegotiate as before. The WMP window record
  carries it as flag bit4 (`wmctl list` shows `R`).

## Implementation status — relative mouse / quake (landed 2026-07-08, todos/0018)

The last vendor app and the pointer-lock flag from "Input routing" (suites:
`test_wm.js` relative-mouse section, `test_wm_policy.js` rel-inject + flag
bit3, `test_wm_e2e.js` real-C RELMODE/MOTION legs, `test_os_apps_e2e.js`
quake leg, browser `os-quake.mjs`; dev log
`logs/2026-07-08/quake-relative-mouse.md`):

- **App API**: `SDL_SetWindowRelativeMouseMode` / `SDL_GetWindowRelativeMouseMode`
  in the SDL3 layer → `SURFACE_SET_FLAGS` (0x1006; flag word: bit0
  borderless, bit1 relative-mouse, bit2 resizable since 0021; host.js
  preserves the other bits across the call).
  On a pre-0018 embedder (no `surfaceSetFlags` hook) the request is a clean
  no-op — apps keep absolute-derived xrel/yrel.
- **The wanted/active split**: WANTED = focused surface requested relative
  mouse (kernel-computed; `onPointerLock(wanted)` fires the UI bridge on
  every change — focus moves, minimize, destroy, flag clears all withdraw
  it). ACTIVE = the bridge actually holds the Pointer Lock API lock,
  reported back via `wmPointerLockChanged`. Only ACTIVE flips routing.
- **The lock gesture is kernel-hit-tested**: `requestPointerLock` needs a
  user gesture, and only the kernel knows what a click hit — so a client-
  area mousedown on the focused relative surface RE-OFFERS wanted=true and
  the page requests the lock inside that click's transient activation.
  Title/chrome/desktop clicks never re-offer: the window stays draggable and
  closable while unlocked (the acceptance line). ESC (browser-enforced)
  drops the lock; the next client click re-takes it.
- **Locked routing**: no cursor, no hit test — motion goes to the focused
  surface as RELATIVE ring records (motion word [5]=1, words [2]/[3] = f32
  dx/dy), buttons land at the client center, wheel as usual. host.js drains
  rel records into `__sdl_push_mouse_motion_rel_event` (true xrel/yrel,
  position frozen — SDL3 relative-mode semantics).
- **Agent channel**: `wmInjectPointer(sid, 'rel', dx, dy)` / WMP
  INJECT_POINTER kind 4 / `wmctl relmove SID DX DY`; window records carry
  flag bit3 (wmctl list shows `r`). Injection is post-hit-test by design —
  no lock state needed headless.
- **Standalone pages** got the same feature through the same SDL API:
  `{type:'sdl-relative-mouse'}` notify → click-to-lock on the page canvas →
  `SDL_WEB.mouseMoveRelMsg` (movementX/Y, letterbox-scaled) → the same rel
  push. One window = every click is a client click, so no hit-test needed.
- **Quake**: `/bin/quake` seeded from `vendor/quake/bin.json` (buildProject
  grew `--allow-old-c`), pak0.pak (18MB) + autoexec.cfg via image.json `bin`
  entries under `/root/id1` (basedir is cwd = /root); `VID_Init` requests
  relative mouse; autoexec now ships `+mlook`.
## harnesses: `tests/browser/wm-spikes.mjs` + `tests/spikes/s3_dawn.mjs`)

- **S1 — PASS, `gpu` transport validated.** `transferToImageBitmap()` on a
  webgpu OffscreenCanvas in a worker + postMessage transfer +
  `copyExternalImageToTexture` stays GPU-backed end to end: 640×480 frame,
  render+present p50 **0.02ms** (p95 0.055), kern-side import p50
  **0.005ms** — no hidden readback anywhere. Pixels verified by kern-side
  readback.
- **S2 — PASS.** rAF exists in dedicated workers and holds cadence with
  concurrent message service + 2ms/frame busy-work: intervals p50 10.9ms,
  p95 26ms, max 27ms (headless Chromium). Fine for a compositor.
- **S3 — PASS with caveat.** Dawn via the `webgpu` npm pkg (v0.4.0,
  prebuilt darwin-universal): device per `worker_threads` worker, render +
  readback green, two concurrent workers fine. **Caveat: `worker.terminate()`
  while Dawn has pending async events aborts the whole Node process**
  (napi_throw on torn-down env) — Dawn-tier processes must exit gracefully;
  the OS's SIGKILL path needs a Dawn-aware drain or accepts the crash risk
  in the optional tier.
- **S4 — PASS.** Two-hop OffscreenCanvas transfer (DOM canvas → kern worker
  → proc worker) works; the proc worker configures webgpu on it and its
  frames display. The `direct` transport is viable whenever wanted.
- **S5 — folded into implementation**: the input ring reuses the proven
  console-ring pattern; the storm test lives with the kernel WM tests
  rather than as a separate spike.

## Implementation plan (landing-sized units → queue items as they start)

| unit | scope | est. sessions |
|---|---|---|
| 1 (todos/0012) | spikes S1–S5 | 1 |
| 2 | kernel surface registry + shm transport + input rings + headless tests | 1–2 |
| 3 | kernel-worker compositor (master canvas, scene pass, cursor) + os.html input/canvas bridge | 1–2 |
| 4 | host.js SDL/webgpu.h retarget (surface create, gpu/shm present tails, event rings) | 2–3 |
| 5 | agent channel + screenshot ops + `wmctl` | 1 |
| 6 | `/bin/wm` v1 (placement policy, taskbar, kernel-chrome metrics) | 2–3 |
| 7 | windowed vendor apps acceptance (doom/quake/snake/gameboy) + Playwright test | 1 |
| 8 (v2, later) | WM frame surfaces (Win95 fidelity), resize, Dawn tier-1 suite | — |

~9–13 sessions to the acceptance test. Sequencing rule: nothing in units
2–7 may contradict a spike result — S1 in particular gates unit 4's `gpu`
tail.
