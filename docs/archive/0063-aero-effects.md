# 0063 — Aero effects on the WebGPU compositor

- **Status**: done (2026-07-10). All five waves landed: per-pixel alpha
  (SDL_WINDOW_TRANSPARENT → kernel flag bit3 → WMP_F_ALPHA; exact integer
  src-over in the headless composite too — `winbox alpha` acceptance app),
  drop shadows + radius-7 rounded corners (per-quad SDF, still one render
  pass), Aero Peek (kernel wmThumbnail/WMP THUMB deterministic box filter
  + wm.c hover popup; wmctl thumb/hover), 200ms minimize/restore fly
  animations (transient kernel records, browser-visual only), glass (WMP
  GLASS/wmctl glass — segmented backdrop-blur tier, browser pass only;
  glass off IS the pre-0063 single-pass path). Constraint held: headless
  goldens bit-exact, zero tolerance loosening. Image v46. Tests:
  tests/kernel/test_wm_aero.js + policy/e2e legs + browser os-aero.mjs;
  shadow-adjacent TEAL samples moved in os-wm/os-scale/os-quake. Residue
  owned by EXISTING items: notepad's pre-existing file-open ERROR dialog
  → a seeded finding in 0073; the aero-aesthetics/glass-perf human
  eyeball → the 0064 sweep plan. Design/status: WM.md "Implementation
  status — Aero effects"; dev log logs/2026-07-10/0063-aero-effects.md.
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
