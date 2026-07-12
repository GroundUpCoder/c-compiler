# 0157 — Real icon set for gucOS (desktop / Start menu / taskbar)

- **Status**: open
- **Design**: `os/wm.c` (`draw_desk` icon glyphs, Start-menu rows, taskbar
  buttons); a new bake-time rasterizer under `tools/`; `os/image.json` seed.

## Goal

Replace the placeholder icon glyph — a generic white tile with a navy square
(`draw_desk`, os/wm.c ~2218; the Recycle Bin's hand-coded basket is the lone
exception) — with a **real, permissively-licensed icon set**, and give the
Start-menu rows and taskbar buttons per-app icons too. Today icons are pure
flat rects and the menu/taskbar are text-only; there is no icon-image path in
wm.c at all, so this is building the path, not swapping assets.

## Licensing — what we can actually use

Real Win95/98 icons are Microsoft-copyright — **out**. Permissive options:

- **Pixelarticons (MIT)** — ★ recommended. Monochrome pixel-art grids; the
  retro aesthetic matches gucOS, and being 1-bit pixel art they bake into a C
  array shaped exactly like the existing `F_AZ` font, so the "blitter" is
  essentially the font path reused (cheap, no alpha compositing).
- **Tango (public domain base)** — classic full-colour desktop icons; needs a
  real RGBA blit path.
- **Bootstrap Icons / Lucide (MIT/ISC)**, **Material Symbols (Apache-2.0)** —
  clean but modern line icons, less retro.

Vendor the chosen set under `vendor/<set>/` with its LICENSE, the usual
per-dir README pinning commit + license (the vendor-corpus convention).

## Plan (sketch — its own design pass first)

1. **Rasterizer** `tools/mkicons.js`: chosen set → small tiles (16×16 and
   24×24) in a wm.c-friendly format. For Pixelarticons: emit a C header of
   1-bit rows (font-style) or a packed RGBA blob seeded to `/usr/share/icons`.
2. **wm.c loader + blitter**: load a tile by name, blit into a surface span
   (desktop cell, menu row gutter, taskbar button). For 1-bit tiles this is a
   near-copy of `draw_text_s`; for RGBA add an alpha src-over.
3. **name→icon map**: resolve an app/extension to an icon (a small table, or
   an `openwith.h`-shaped `/usr/share/icons/map`), with a generic fallback so
   nothing is icon-less. Desktop launchers, `/etc/menu` entries, and taskbar
   buttons all resolve through it.
4. **Wire-in**: desktop icon grid, Start-menu rows (left gutter), taskbar
   buttons. Bump `os/image.json` version; extend the os-shell/wm_service pixel
   asserts (they currently assert the navy-square glyph).

## Acceptance

- A vendored, permissively-licensed icon set (LICENSE + README pinning
  commit) baked into the image; desktop icons, Start-menu rows, and taskbar
  buttons render per-app icons with a generic fallback.
- `tools/mkicons.js` regenerates the baked tiles deterministically; the
  kernel + browser shell tests updated off the placeholder-glyph asserts and
  green.
- No licence violation (no Microsoft/proprietary art); the set's license file
  is in the repo.

## Notes

- Filed P1 (feature) per the priority policy — new capability, not a bug.
  Split out of the todos/0132 Start-menu follow-up (gucOS sidebar band +
  bottom All-Programs) where the user asked about pulling in an icon set;
  that follow-up shipped, this is the separate, larger pipeline.
- Recommend scoping to Pixelarticons first (cheapest path, best aesthetic
  match); if a fuller desktop look is wanted later, Tango is the PD fallback.
