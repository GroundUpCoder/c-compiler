# 0056 — Elm/MVU declarative UI layer

- **Status**: **DROPPED / superseded by Win32** (2026-07-09) — see
  `WIN32.md` / `TOOLKIT.md`. MVU is viable in C, but Win32 gives the same
  message-switch shape plus a queryable HWND tree, portability, and an OSS
  corpus. May return only as optional sugar over user32; not planned. Rest
  retained for history only.
- **Depends**: 0047 (the substrate: command renderer, freetype text
  helper, input plumbing, Win95 skin)
- **Design**: `todos/TOOLKIT.md` (architecture + the MVU-over-React
  decision); declaration encoding per `todos/DOM.md`

## Goal

The repo's declarative C UI library (`ui.h`): Model/Msg/update/view
over a keyed reconciler and a retained tree, rendered through the 0047
command renderer onto an shm surface. UI as a pure function of state;
events as data (tagged-union Msgs), not callbacks.

## Plan

- The flat vtree buffer builder (DOM.md's begin/end/attr encoding,
  keys for identity) — what view() emits.
- Keyed reconciler: old/new buffer diff → retained-tree mutations.
  **Pure C, tested headless first** — reconciler unit tests need no
  GUI, no kernel, no browser (the deterministic-goldens culture).
- Flexbox-subset layout pass (row/column, grow, padding, gap, min/max).
- Retained tree → 0047 command list → SDL surface; input ring →
  hit-test → Msg → update → view. Repaint only on msg/timer.
- Retained widget state keyed by identity (scroll, focus, caret);
  nested-TEA convention for reusable components (TOOLKIT.md).
- First retained widgets: button, checkbox, slider, label, scrollview.
  The multi-line text editor lands with notepad (0048) as its own
  chunk.

## Acceptance

- Reconciler + layout unit tests pass headless (compiled C, no GUI).
- A demo app (counter + list add/remove — exercises keyed reorder)
  windowed in-OS; drivable headless: a `wmctl`-injected click emits a
  Msg observable via the app's stdout/screenshot.
- 0048's notepad editor is buildable on this layer (proven by the
  notepad landing, not this item).
