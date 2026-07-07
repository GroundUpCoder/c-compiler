# 0016 — SDL+WebGPU demo app windowed + Dawn tier-1 suite

- **Status**: queued
- **Depends**: 0013 (WM v1 — gpu transport); 0014 (soft)
- **Design**: `todos/WM.md` ("The two axes", "Headless testing tiers",
  spike verdicts S1/S3), `todos/WEBGPU.md`

## Goal

A real GPU-rendered app windowed in-OS — the first end-to-end consumer of
the `gpu` transport — landing together with the tier-1 (Dawn) test suite
from WM.md unit 8, because the suite needs exactly this fixture.

- Repo-owned demo in the winbox mold (e.g. `os/gpubox.c`, seeded as
  `/bin/gpubox`): SDL window + direct `webgpu.h` rendering — rotating
  shaded cube or similar, deterministic enough for tolerance-diff.
- Browser: per-process WebGPU device in the nested worker; present via
  `transferToImageBitmap` (the S1-validated path). This is the first real
  exercise of the "one window per process in gpu flavor" v1 limitation —
  document or lift as discovered.
- Headless: Dawn (`webgpu` pkg) renders the same demo; present =
  `copyTextureToBuffer` readback → shm SAB, so kernel screenshots work
  identically to CPU apps.
- Tier-1 suite: tolerance-diff assertions (GPU output is per-platform
  stable, not cross-platform bit-exact); **skips cleanly** when the
  `webgpu` package is absent; nothing in compiler.js/host.js/kernel.js/os/
  imports it (core stays zero-dep).
- Respect the S3 Dawn caveat: Dawn-tier processes exit gracefully — no
  `worker.terminate()` with pending Dawn events.

A real-world WebGPU C app **port** is a wanted follow-up — stays
unnumbered until scheduled (candidates via `WEBGPU.md`).

## Acceptance

- `gpubox &` in browser os.html: animated GPU-rendered window, draggable/
  focusable/closable like any surface.
- Tier-1 headless run renders the demo under Dawn and the screenshot
  matches expected within tolerance; the suite skips (not fails) without
  the package.
- Existing suites stay green in stock Node (tier 0 unaffected).
