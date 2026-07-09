# 0047 — GUI toolkit: microui over SDL + freetype

- **Status**: open
- **Depends**: —
- **Design**: discussion + trade study (microui vs nuklear) in
  `logs/2026-07-09/roadmap-network-desktop.md`; long-run direction
  (Elm/MVU layer over this substrate) in `todos/TOOLKIT.md`

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
- SUPERSEDED (2026-07-09): the earlier nuklear trade-up fallback is
  replaced by the Elm/MVU declarative layer (`todos/0056`, design
  `todos/TOOLKIT.md`). This item's deliverables — the command-list
  renderer, the shared freetype text helper, input plumbing, the
  Win95 skin — are the PERMANENT substrate that layer builds on, not
  throwaway; microui itself stays for quick immediate-mode tools
  until 0056 reaches widget parity.

## Acceptance

- `/bin/uidemo` windowed in-OS: buttons, slider, checkbox, textbox;
  drag-resizable (declares SDL_WINDOW_RESIZABLE).
- Headless drivable: a `wmctl`-injected click toggles a checkbox,
  observed via screenshot or the app's stdout.
- Image version bump; seeded-binaries lists updated.
