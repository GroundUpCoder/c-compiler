# Handoff — start of thread (updated 2026-07-08, after 0016 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**GPU apps run windowed in the OS — in the browser AND headless.** This
thread landed **0016**: `/bin/gpubox` (os/gpubox.c, a lambert-shaded cube
via direct webgpu.h calls, `-f N` freezes a pose) is the first end-to-end
`gpu`-transport consumer. The machinery: `wgpuSurfacePresent` became a
real host import (`__wgpu_surface_present` — no-op on DOM canvases,
ImageBitmap handoff in the browser OS flavor, Dawn readback→shm tail
headless); `createBrowserWebGPU` grew `resolveGpu`/`shmSurface`/`onPresent`
seams; `createSurfaceSDL` exposes them as `sdl.webgpuConfig`. The Dawn
tier (`webgpu` devDependency, root package.json) is probed LAZILY on a
process's first requestAdapter — stock Node stays tier 0, core stays
zero-dep. image.json is **v12**. Dev log:
`logs/2026-07-08/webgpu-demo-dawn-tier.md`.

Decisions made in 0016 (don't re-litigate): the S3 terminate caveat is
handled by tracking every Dawn promise + `ctx.gpuDrain` awaited before the
deferred EXIT handshake — **GPU apps quit via SDL_Quit(), never
exit()-in-frame-callback** (that fires the EXIT RPC → worker.terminate
before any drain); SIGKILL mid-frame stays the accepted crash risk of the
optional tier. Dawn's shm tail pins preferred format rgba8unorm (bgra8
swizzled, others fail loud). Tier-1 assertions are tolerance-diff, never
bit-exact goldens.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel 20 files✓ (new: test_gpubox_dawn_e2e — pose-0 center hit the
computed lambert value (208,28,28) exactly under Dawn; suite verified to
SKIP with the package hidden), browser webgpu-renders✓ +
sdl3webgpu-renders✓ (standalone regression) + os-boots✓ + os-wm✓ +
os-doom✓ + os-gpubox✓ (new: composited cube, animation, clean wmctl
close).

## The queue (todos/README.md is authoritative)

1. **`0017` audio mixing** — kernel sound server; doom + gameboy are
   waiting consumers (both already NULL-check the failed stream open)
2. `0018` quake — relative-mouse/pointer-lock flag + pak0.pak seeding
   (trivial via `bin` entries)
3. `0019` client resize (SURFACE_CONFIGURE)
4. `0020` wasm terminal + ptys
5. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md;
   the platform side is done

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **Texture vs buffer usage constants differ**: texture COPY_SRC=0x01,
  buffer COPY_SRC=0x0004. host.js's shm tail uses commented literals
  (Dawn's globals are deliberately not installed).
- `wmctl list | grep "title$"` then `sed "s/[^0-9].*//"` is the SID-capture
  idiom in tests; a section-split test assertion must match list ROWS
  (`\ttitle` suffix) — background-app stdout interleaves into sections.
- The webgpu package (`node_modules/`, root) is installed on THIS machine;
  the tier-1 suite skips cleanly elsewhere. Hiding/restoring
  `node_modules/webgpu` is the way to test tier-0 behavior (gpubox exits 2
  with a clean stderr message) and the suite's SKIP path.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v12 now).
- compiler.js must stay browser-clean (no bare `process.*`); host.js's
  Dawn probe is require-in-try/catch behind a `typeof process` guard.
- WM protocol MUST-MATCH blocks live in THREE places: kernel.js (WMP) ↔
  os/wm_proto.h ↔ tests/kernel/test_wm_policy.js. gpubox adds another:
  its shader light/colors ↔ test_gpubox_dawn_e2e.js's expected-color math.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox after touching os/, kernel.js, host.js SDL/webgpu/fd paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0014's decisions, 0015's decisions (WAD at /root, kernel
  clips oversized windows), 0016's decisions above.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0017 (audio mixing), a lingering item, or something else."
