# 0268 — Mobile on-screen keyboard (OSK) for VT1+VT2

- **Status**: done
- **Design**: logs/2026-07-19/gucos-mobile-osk.md

## Goal

Make gucOS usable on a phone: a synthetic-key on-screen keyboard the page
builds itself (NOT the device IME — VT2 is a canvas with no focusable text
input, and an IME proxy can't express the scancodes + chords the OS consumes:
kernel Ctrl+Alt+Tab / Ctrl+Esc / GUI+arrow, term's ^C fold, wm.c's
ctrl/shift-click). Zero-bake: page-side JS only, no kernel/C/image change.

## Plan

- `os/osk.js`: ONE component, TWO first-class backends — VT2 injects the
  same `{kind:'key', down, code, key, repeat, mods}` records the physical
  keyboard listeners ship (bit-identical at routeInput); VT1 injects tty
  bytes through the vt1Input funnel (xterm escape conventions, CSI 1;N
  modifier encodings).
- 3 layers (abc / sym / num-fn), every legend a complete `{code, key, mods}`
  entry (SDL3 keysyms are modifier-applied; '!' = Digit1+Shift baked, never
  a runtime transform).
- Sticky modifiers: arm sends a REAL modifier keydown, merges into every
  event, disarms at the next key's KEYUP (kernel chord-keyup swallow needs
  the mod still held); tap-lock on double-tap; multi-arm chords.
- Key repeat: own timer (400ms, ~30Hz), never for modifiers/layer keys.
- `#osk` is a flex SIBLING of the VT panes: opening it shrinks the pane →
  syncScreenSize → screen-resize → wm re-lay + re-clamp (occlusion by
  layout; composes with the VT2 zoom's floor(pane/Z)).
- Toggle in the tab bar on both VTs, ungated on data-touchui; open state
  saved-else-phone-viewport-default (#69 D6 shape); OSK supersedes the 0212
  keystrip while open.
- Probes `__osOsk*`; sweep `tests/browser/os-osk.mjs`.

## Acceptance

On a phone-shaped VT2: type into a running app; reach Esc/Tab/arrows/Fn;
fire Ctrl+Alt+Tab / Ctrl+Esc / term ^C / Ctrl+Shift+C via sticky mods; the
focused window is never hidden (pane shrink re-clamps); works at zoom; VT1
still types via tty bytes; os-osk.mjs green + flake-stable; image version
unchanged.
