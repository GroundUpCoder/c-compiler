# 0063 — Aero effects on the WebGPU compositor

- **Status**: open
- **Design**: `todos/WM.md` (Compositor; the earlier Aero-track survey)

## Goal

The DWM/Aero visual wave on the `0055` WebGPU pass. The compositing model
is already there (0055); this adds the per-pixel effects, in dependency
order, GPU-side. Benefits from `0062`'s zero-copy present but doesn't
require it.

## Plan (rough dependency order)

1. **Per-pixel alpha surfaces + src-over blend** — the enabling primitive
   (a has-alpha surface flag). Useful far beyond Aero: menu shadows,
   tooltips, toasts.
2. **Drop shadows + rounded window corners** — compositor masks.
3. **Live taskbar thumbnails / Aero Peek** — a downscaled per-surface
   composite; nearly free (surfaces are already readable).
4. **Window animations** (minimize/snap) — needs a compositor frame clock +
   transient interpolated geometry driven by the WM.
5. **Backdrop blur — the "glass"** — the one genuinely hard item (samples
   what's behind a window; downsample + box-blur approximation on the GPU
   pass; this is *why* DWM had to exist).

## Constraint

The headless deterministic CPU composite (`wmctl shot`) stays bit-exact:
either implement each effect deterministically there too, or gate it out
of the headless path. **No golden tolerance loosening.**

## Acceptance

- Alpha + shadows + thumbnails visible in-browser; headless goldens
  intact; blur behind a flag/tier.
