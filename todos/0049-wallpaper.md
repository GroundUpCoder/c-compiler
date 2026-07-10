# 0049 — wallpaper

- **Status**: open
- **Design**: discussion in `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

`/etc/wallpaper/` holds candidate images; `current` is a symlink to the
chosen one; wm.c's desktop layer draws it under the icon grid;
`wmctl wallpaper <name>` switches. wm.c only — the control-panel
picker's home is the 0089 hub's **Display applet** (today a stub in
`os/win32/ctlpanel.c` naming this item — replace its two STATIC lines
with the picker UI).

## Plan

- Follow the `/etc/menu` first-existing-dir pattern: wm.c reads
  `/etc/wallpaper/current` if present, else a baked
  `/usr/share/wallpaper/` default location; **no `current` = solid
  teal** (today's look — keeps existing pixel-test asserts valid).
- PNG via vendored libpng (wm.c links it like term links freetype).
- GIF: **first frame only** via a tiny decoder (stb_image's gif path or
  gifdec) — GIFs display, don't animate. Animation deferred: fullscreen
  re-damage at gif framerate is a standing composite burn; revisit only
  on real demand.
- Scale policy: pick ONE of center / aspect-fit stretch, record it;
  re-fit on EV_SCREEN.
- `wmctl wallpaper <name>`: retarget the symlink + poke wm (reuse an
  existing WMP nudge or add a verb — decide at implementation, keep the
  MUST-MATCH blocks in sync).
- Browser pixel tests: wallpaper only exists when `current` does, so
  "empty desktop teal" asserts hold; add a wallpaper-set leg that
  screenshots and then unsets.

## Acceptance

- Set → screenshot shows the image under the icons; unset → teal;
  switch via wmctl; EV_SCREEN re-fits.
- A GIF candidate displays (first frame).
- Image version bump if anything is seeded.
