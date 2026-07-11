# 0134 — EDIT control mouse-wheel scrolling (WM_MOUSEWHEEL)

- **Status**: open
- **Design**: `todos/WIN32.md` (EDIT status). Umbrella 0133. The quick win
  of the EDIT-completeness set.

## Goal

Mouse-wheel scrolling does nothing in notepad (and any multiline EDIT). The
wheel event is well-formed all the way down — os.html's `wheel` listener →
`compositor.js` → the kernel input ring (`WMEV.MOUSEWHEEL 0x403`) → the SDL
veneer's `SDL_EVENT_MOUSE_WHEEL` → the user32 message loop, which already
hit-tests and posts a proper `WM_MOUSEWHEEL` to the child under the cursor —
and is then dropped because `edit_proc` has no handler and `DefWindowProc`
discards it. The fully-working LISTBOX handler (`lb_proc`, `os/win32/
user32.c`) is the precedent. This adds the equivalent to the multiline EDIT.

## Plan

- Add a `case WM_MOUSEWHEEL` to `edit_proc` (`os/win32/user32.c`): decode
  the signed wheel delta from `wParam` (`GET_WHEEL_DELTA_WPARAM` / divide by
  `WHEEL_DELTA`), scroll the multiline view by the Windows default of 3 lines
  per notch (adjust `topLine`, clamp to `[0, maxTop]`), and invalidate. Mirror
  the LISTBOX arithmetic; single-line EDITs ignore the wheel (return via
  DefWindowProc as today).
- Keep it caret-independent — wheel scrolls the *view*, not the caret/
  selection (Windows behaviour). Ensure the clamp uses the same
  visible-lines / total-lines math the caret-driven `topLine` path already
  uses so the two agree.
- No new opcode, no kernel change — this is entirely inside `edit_proc`.

## Acceptance

- A conformance/e2e leg: load a multiline EDIT taller than its client area,
  inject `WM_MOUSEWHEEL` (or drive notepad headlessly with a wheel event via
  the kernel ring / `wmctl`), assert `topLine` advances and clamps at both
  ends.
- Manual: wheel-scrolling a long file in notepad on the desktop moves the
  view; single-line edit boxes are unaffected.
- No regression in `test_user32_e2e.js` or the notepad legs.
