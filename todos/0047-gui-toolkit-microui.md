# 0047 — GUI toolkit: microui over SDL + freetype

- **Status**: open
- **Depends**: —
- **Design**: discussion + trade study (microui vs nuklear) in
  `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

The repo's C widget toolkit: vendored **microui** (rxi, ~1.1k lines
ANSI C, zero deps) + a renderer binding (SDL surface + freetype text) +
a Win95-flavored skin. Gates the whole desktop-apps wave (0048).
`/bin/uidemo` is the acceptance app.

## Plan

- `vendor/microui/` with a bin.json like other vendored libs. microui
  is renderer-agnostic by design — it emits a command list (rect / text
  / icon / clip) that maps directly onto our SDL surface draws.
- Text: freetype, the way `/bin/term` already does it — extract or
  mirror a small common text-draw helper rather than a third copy.
- Win95 skin: bevels/raised buttons/gray chrome live in the render
  layer + microui's style struct; we own both, so no upstream fight.
- Input: kernel input-ring key/mouse events → `mu_input_*`. Clipboard
  hooks stubbed until a clipboard item exists.
- Fallback recorded: if list-widget/multi-line-edit needs outgrow
  microui (the known gaps), trade up to nuklear — same immediate-mode
  model, app code migrates. Decide from real 0048 experience, not
  speculation.

## Acceptance

- `/bin/uidemo` windowed in-OS: buttons, slider, checkbox, textbox;
  drag-resizable (declares SDL_WINDOW_RESIZABLE).
- Headless drivable: a `wmctl`-injected click toggles a checkbox,
  observed via screenshot or the app's stdout.
- Image version bump; seeded-binaries lists updated.
