# WM.md — compositor + window manager design

- **Status**: designed 2026-07-07 (todos/0007); **v1 IMPLEMENTED the same
  day** (todos/0012 spikes + todos/0013 — see "Implementation status v1"
  below for what shipped and where it deviates); **/bin/wm + wmctl landed**
  (todos/done/0014, status section below); **the acceptance test passed**
  (todos/done/0015 — doom/snake/gameboy windowed in-OS with zero source
  changes; quake awaits the relative-mouse flag, todos/0018). Remaining
  queue: 0016 (WebGPU demo + Dawn tier), 0017 (audio), 0019 (resize),
  per todos/README.md.
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
`wmctl shot` frames) and in Chromium (`tests/browser/os-doom.mjs`); quake
is deferred to todos/0018 (needs the relative-mouse/pointer-lock flag).

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
SURFACE_SET_FLAGS(id, flags)           cursor visible, relative-mouse, …
SURFACE_CONFIGURE                      RESERVED (client resize — v2)
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
round-trips to the UI bridge for pointer lock.

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

## The terminal (v1: xterm.js as a privileged DOM surface)

xterm.js stays the terminal, tracked in the scene list as a `dom`-kind
surface: the UI bridge positions/sizes the xterm element per kernel
geometry. Honest limitation: it composites in the browser's layer above the
master canvas, so a canvas window overlapping it needs CSS `clip-path`
cutouts (rect holes, evenodd) applied by the bridge — workable, slightly
ugly, and quarantined to the bridge. Its "screenshot" is the xterm buffer
as *text*, which is more agent-useful than pixels anyway. The pure path — a
wasm terminal app (SDL surface + pty + freetype) — is real but a
multi-session project; it waits until the compositor exists (KERNEL.md
already notes pty pairs wait for exactly this consumer).

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

- **Audio mixing** — today's audio ring assumes one process ↔ the page;
  multi-process needs a small mixer (the sound-server analog of this
  compositor). Design when the second concurrent audio app exists.
- **`direct` transport promotion** — light it up when a fullscreen app
  measurably wants the copy back; needs the two-hop OffscreenCanvas
  transfer spike.
- **wasm terminal app** — the v2 terminal; pty layer lands with it.
- **Damage rects / partial present** — optimization, after correctness.
- **Cross-agent WebGPU sharing** — if the spec ships it, `gpu` present
  becomes zero-copy at the same seam.

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
- **os/compositor.js** (kernel-worker side): Canvas2D scene draw per rAF —
  desktop, shm surfaces via seq-cached ImageData, gpu surfaces via
  drawImage(bitmap), chrome + title text; `routeInput` maps the bridge's
  raw events through SDL_WEB's tables into `wmKey`/`wmPointer`.
- **os/os.html**: desktop canvas pane (800×500, natural size) transferred
  to the kernel worker; raw input forwarding (keys as plain objects with a
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
- **Compositor is Canvas2D**, not a WebGPU pass — single-digit quads;
  bitmap drawImage is still GPU-composited by the browser. Revisit only if
  profiling says so.
- **Terminal is a separate pane**, not a scene-positioned privileged DOM
  surface yet — the split layout was the honest v1; the positioned-xterm
  (clip-path) design stays queued.
- **Cursor is the native browser cursor** (no kernel sprite; headless
  composite has no cursor).
- **One window per process in the browser gpu flavor** (one OffscreenCanvas
  — same as the standalone runtime); the shm flavor supports many.
- **Audio in OS processes stays null** (the mixer open-question below).

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

## Spike appendix — VERDICTS (run 2026-07-07, todos/0012;
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
