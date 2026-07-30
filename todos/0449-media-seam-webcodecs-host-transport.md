# 0449 — Media seam: a general WebCodecs host transport with independent decode/encode capability probes

- **Status**: open
- **Design**: this ticket. Origin: the gucOS video-player viability investigation (2026-07-30),
  commissioned by jku and reported to him by email. He asked for the work to be queued.
- **Difficulty**: heavy. **Run this lane on Fable** — jku's call: the stream is "tricky enough to
  require fable for the work".
- **Stream**: A of A→B→C (+D). 0450 and 0452 both depend on this ticket; 0451 depends on 0450.

## Goal

A **general media transport** host module — `createMedia` in `host.js` — that exposes WebCodecs to
gucOS apps, plus a **capability-probe surface** C apps can read at init. This is the foundation the
player (0450), the A/V sync work (0451) and the optional encoder (0452) all build on.

🔴 **Build the general transport, not a video-player hook.** Follow the transports convention in
`todos/WM.md` and the tier model in `todos/NETWORK.md`. The CORE PRINCIPLE applies: "nothing uses it
yet" is not a reason to narrow the surface to whatever the first player happens to call.

## Why this shape (measured in the investigation — do not re-litigate)

- **In-wasm software decode was REJECTED.** The compiler emits no SIMD and no threads/atomics
  (processes are the parallelism unit), and scalar codegen measured **~5.4x slower than clang** —
  an in-wasm H.264 decoder caps around 240-360p. **Host WebCodecs decode is the only performant
  path.** These are the investigation's numbers, not this ticket's; re-measure only if you intend
  to overturn the conclusion.
- **The frame-handoff precedent already exists**: the `gpu` window transport runs
  `host.js surfaceFrame(sid, bmp)` → `postMessage wm-frame` → kernel `_wmFrame` → compositor
  `copyExternalImageToTexture`, latest-frame-wins. **Video reuses this shape** — a `VideoFrame` and
  an `ImageBitmap` are both `CanvasImageSource`.
- **`__externref` is implemented** (`todos/EXTERNREF.md`), so an opaque host handle such as a
  `VideoFrame` can be a first-class C value. **No handle table is needed.**
- **The browser floor is a non-issue**: gucOS hard-requires WebGPU, and full WebCodecs is available
  everywhere WebGPU is (including Safari 26+/iOS 26+).

## Plan

1. **`createMedia` in `host.js`**, mirroring the existing `createHttp` / `createEgress` modules.
   `VideoDecoder` is worker-scope, and process workers already use `navigator.gpu` /
   `OffscreenCanvas` directly, so the module lives in the app's **process worker**.
2. **Generalize the frame path to accept `VideoFrame` alongside `ImageBitmap`** — kernel `_wmFrame`
   (its superseded-frame close already exists) and the compositor's `gpuBindFor` /
   `copyExternalImageToTexture` in `os/compositor.js`.
3. **The capability-probe surface**, exposed to C apps at init. 🔴 **Probe decode and encode
   INDEPENDENTLY**: check `VideoDecoder` / `VideoEncoder` existence *and* `isConfigSupported` per
   codec. **Never infer encode support from decode support** — iOS Safari 16.4-18 shipped
   decode-only WebCodecs, so an inferred capability is a wrong answer on real devices.
   ⚠️ `hardwareAcceleration` is a **hint**; `isConfigSupported` is the only truth.
4. **`VideoFrame.close()` discipline.** The decoder **stalls** if frames are held. The kernel's
   existing superseded-bitmap close is the pattern to follow; make the ownership rule explicit at
   the seam rather than leaving it to each caller.

## Acceptance

1. `createMedia` exists in `host.js` and is wired as a host import module on the same footing as
   `createHttp` / `createEgress` — **not** special-cased for one app.
2. The frame path carries a `VideoFrame` end-to-end (app → `_wmFrame` → compositor texture) with no
   `ImageBitmap` conversion step, and the superseded-frame close path covers `VideoFrame`.
3. A C app can read decode and encode capability **separately**, per codec. Add a test that proves
   the two probes are independent — e.g. a decode-capable/encode-incapable configuration reports
   `encode: false` while `decode: true`. **A test that only ever sees both-true does not test this.**
4. `VideoFrame.close()` is proven, not assumed: a test shows that frames are released and the
   decoder does not stall under sustained delivery.
5. The seam is documented in `todos/WM.md`'s transports convention (and `todos/NETWORK.md` if it
   claims a tier), so the next reader finds it where the other transports are described.

## Notes for the lane

- 🔴 **Grep for symbols; never trust a cited line number.** The investigation's line references
  were approximate, and **0442 is actively rewriting `host.js`**. Re-derive every anchor at spawn.
- 🔴 Per **(FA)**, re-run each acceptance arm against the tree at spawn and say which were already
  green — an arm satisfied by someone else's ticket certifies nothing about your work.
- Work in a **worktree** (`~/worktree/c-compiler/<slug>`), one repo.
- On a `todos/queue.json` rebase conflict: **drop your own close commit and re-run
  `node todos/queue.js done 0449`** on the new base, verify the staged blob, **never hand-merge**.
