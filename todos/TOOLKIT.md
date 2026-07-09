# The GUI toolkit — SUPERSEDED by Win32 (see `WIN32.md`)

Decision 2026-07-09 (log: `logs/2026-07-09/win32-direction.md`): the primary
UI toolkit is **Win32** (user32 + gdi32 + a kernel32 subset). See
**`WIN32.md`**.

This supersedes the earlier **microui (0047)** and **Elm/MVU (0056)** plans,
which are **dropped** (their items carry a superseded status). Short
history:

- **microui / Clay (immediate mode) — dropped**: no persistent tree, so no
  accessibility / agent-drivability without pixel injection — and agent-
  drivability is a hard requirement.
- **Elm/MVU (0056) — dropped as primary**: genuinely viable in C, but Win32
  delivers the same closure-free message-switch shape (`WndProc` =
  `update(state, msg)`) **and** a queryable HWND tree **and** source
  portability to Windows **and** a real OSS corpus to test against. MVU
  could return later only as optional app-side sugar over the user32 tree;
  not planned.

Why Win32 wins on the hard requirement: every widget is an HWND in a
persistent tree, and `wmctl click "OK"` resolves by walking that tree
(`EnumChildWindows` → `WM_GETTEXT` → `PostMessage(BM_CLICK)`), never pixels
— exactly how Windows' own MSAA / UI-Automation works.

The one microui deliverable that carries over: the shared freetype
text-draw helper (gdi32's `TextOut` reuses it). Everything else in 0047/0056
is retired. `DOM.md`'s flat-buffer idea is parked (a possible future
MVU-sugar encoding), not on the queue.
