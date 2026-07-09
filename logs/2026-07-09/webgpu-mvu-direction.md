# Platform direction: full-WebGPU compositor + Elm/MVU toolkit

Two direction decisions today, both doc-only (the queue items carry the
implementation): `todos/0055` (WebGPU compositor) and `todos/0056`
(MVU declarative UI layer, design `todos/TOOLKIT.md`).

## 1. The compositor goes WebGPU — with NO fallback (todos/0055)

Context: WM.md always *designed* the browser compositor as one WebGPU
render pass (z-ordered textured quads; shm surfaces via `writeTexture`,
gpu surfaces via `copyExternalImageToTexture`). v1 shipped a Canvas2D
stand-in (`os/compositor.js`) because the scene was single-digit opaque
quads — a documented "revisit if profiling says so" deviation.

Decision: implement the designed pass, and make it the ONLY compositor.
The revisit trigger isn't profiling after all — it's platform intent:

- **WebGPU is the native rendering interface end to end.** Apps already
  have exactly one rendering interface (`webgpu.h`; the SDL renderer is
  built on it; "no software SDL rasterizer" was decided 2026-07-07).
  The compositor was the one non-WebGPU stage left in the browser
  pipeline. Future high-res 3D apps and the Aero-class effect wave
  (alpha, blur, shadows, animation) all ride the compositor pass.
- **No Canvas2D fallback** — a fallback means maintaining two
  compositors with one a permanently undertested zombie, and lets
  boots "quietly succeed" while the intended path is broken. WebGPU
  unavailable in the kernel worker → a loud `boot-nogpu` guard screen
  (the 0045 boot-locked pattern). A tty-only (VT1) maintenance boot
  was considered and rejected on the same zombie-mode grounds.
  Consequence accepted with eyes open: browsers without worker WebGPU
  (Firefox stable today, Safari < 26) cannot boot the desktop.

Dependency audit (why 0055 can be first in *Next up*): worker WebGPU is
proven in-repo (0016 runs `navigator.gpu` devices inside process
workers); the browser harness already runs the 25-test `webgpu-*` suite
on headless Chromium/SwiftShader; headless (`boot.js`, the kernel
suite, the deterministic CPU screenshot composite) never constructs a
compositor and is untouched, so bit-exact goldens stay the headless
contract. Nothing in the open queue blocks it.

Also confirmed while deciding: the "cube demo that requires WebGPU"
already exists — `/bin/gpubox` (todos/done/0016), a rotating
lambert-shaded cube through raw `webgpu.h` on a real per-process
device. Under 0055 its frames stop touching CPU pixels entirely
(ImageBitmap → texture import → compositor pass).

## 2. The toolkit direction: Elm/MVU over the 0047 substrate (todos/0056)

The 0047 trade study picked microui over nuklear for the desktop wave.
Today's discussion went one level up — immediate mode vs the modern
declarative-over-retained consensus (React/Flutter/SwiftUI shape) —
and settled the long-run architecture:

- **Elm/MVU, not React-hooks**, because MVU is the C-natural half of
  that consensus: Msgs are tagged unions (enum + union), update is a
  switch, the Model is one struct, and event handlers are *data*
  ("this button emits MSG_SAVE"), not closures — the one construct C
  is genuinely bad at. Full argument + architecture in
  `todos/TOOLKIT.md`.
- **The nuklear trade-up recorded in 0047 is superseded** — if/when
  microui runs out (notepad's multi-line editor is the predicted
  trigger, per 0048), the trade-up target is the MVU layer, not a
  bigger immediate-mode library.
- **0047's deliverables are the permanent substrate** (command-list
  renderer, shared freetype text helper, input plumbing, Win95 skin);
  microui stays for quick immediate-mode tools until 0056 reaches
  parity. `DOM.md`'s flat-buffer declaration encoding is reused as the
  vtree format (browser DOM becomes a possible alternate backend
  later, not a competing architecture).
- Repo-specific wins that tipped it: Msg streams are injectable
  (`wmctl`-drivable apps without pixel-coordinate synthesis) and
  loggable (deterministic UI replay — the BlockFS golden/fuzzer
  culture applied to GUIs).

Sequencing recorded in the README: 0055 is next up; the desktop wave
runs 0047 → 0056 → 0048, with notepad's editor as 0056's first real
retained widget and the other four wave-1 apps not waiting on it.
