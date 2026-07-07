# WM/compositor design (todos/0007 → todos/WM.md)

Third landing of the day: the Phase 3 design doc. No code — but the design
conversation changed shape twice in ways worth recording, because both
wrong turns were plausible enough to re-attempt later.

## Wrong turn 1: "virtualize one kernel-owned WebGPU device"

First instinct for per-process graphics was a kernel-owned GPU context with
processes speaking a serialized `webgpu.h` wire protocol — i.e. rebuild
Chrome's GPU-process architecture *inside* Chrome. Rejected on a platform
fact: **every worker can `requestDevice()` and the browser's GPU process
already multiplexes, validates, and schedules across them.** Per-process
"own GPU context like a real OS" is the native model, free. The only thing
the web lacks vs Linux is cross-context buffer sharing (dma-buf), and
`transferToImageBitmap` → transfer → `copyExternalImageToTexture` is that
handoff, GPU-side in Chromium. The whole Wayland stack maps 1:1
(render nodes → per-worker devices, dma-buf → ImageBitmap, wl_shm → SAB,
overlay planes → per-window DOM canvas); WM.md's mapping table is the
takeaway.

## Wrong turn 2: conflating rendering backend with present transport

Mid-conversation the design had "shm surfaces" vs "gpu surfaces" as if apps
would target one or the other, which implied writing a software SDL
rasterizer for headless pixels and a browser GPU→CPU readback path for
quake. Both evaporate once the axes are separated: **backend** (who
executes draw calls: browser WebGPU / Dawn / null) × **transport** (how
finished frames travel: bitmap / SAB / direct). Apps see only SDL/webgpu.h
— which is already the repo's architecture, since the SDL renderer
(UpdateWindowSurface included) sits on `webgpu.h` with no second pixel
path. Decisions that fell out:

- **No software rasterizer, ever.** Headless real pixels for wgpu apps =
  Dawn (the Mesa-llvmpipe of this world). Verified on the registry today:
  the `webgpu` npm package IS `dawn-gpu/node-webgpu`, prebuilt Dawn,
  active (v0.4.0, 2026-03) — planned as the repo's first package.json,
  devDependencies-only, optional, suite skips when absent.
- **No browser readback path.** In-browser everything presents GPU-side
  (bitmap handoff); readback→SAB exists only as Dawn's canvas-less present
  tail, where it makes the kernel compositor backend-blind.
- Stock-Node floor stays the existing null backend — wgpu apps *run*
  headless (fs/signals/protocol all real), draws no-op. Tier table in
  WM.md.

## Numbers

Ran `tests/kernel/bench_fs.js` to anchor the "what does the kernel cost"
question: brokered vs in-process = 548/1112 MB/s write(8K), 462/1159 read,
~100k/705k metadata ops/s ⇒ **~10µs per RPC**, and the single-threaded
kernel worker makes that a system-wide syscall ceiling. Recorded in WM.md
as the rationale for the data-plane rules (present = SAB/bitmap per frame,
input = rings, never per-pixel RPCs). Compositor budget: full-1080p worth
of windows ≈ 1GB/s GPU-internal at 60fps — noise.

## Other calls made (rationale in WM.md)

Kernel-worker compositing on a transferred master OffscreenCanvas (os.html
stays a dumb bridge); mailbox double-buffer shm semantics (producer never
blocks); one input ring per process, surface-tagged (matches SDL's single
queue); WM policy over AF_UNIX (dogfoods 0008); decorations staged
kernel-chrome-v1 → WM-frame-surfaces-v2 (v1 chrome doubles as the
WM-crashed fallback); no client resize in v1 (every GUI vendor app is
fixed-size; SURFACE_CONFIGURE reserved); xterm.js as a privileged
DOM-kind surface v1 with clip-path cutouts, wasm terminal deferred; agent
channel (enumerate/focus/inject/screenshot) defined once, exposed to the
harness and as in-OS `wmctl`. New open question surfaced: **audio mixing**
(today's ring assumes one process ↔ page) — the sound-server analog, design
when a second concurrent audio app exists.

## Queue

0007 done (this doc). Next: **0012 — the spike pack** (S1
transferToImageBitmap GPU-backedness — gates the gpu transport; S2 rAF
jitter in a busy kernel worker; S3 Dawn under worker_threads; S4 two-hop
canvas transfer; S5 input-ring storm). Implementation units 2–7 get
numbered as they start; ~9–13 sessions to the acceptance test (every SDL
vendor app windowed, zero source changes).
