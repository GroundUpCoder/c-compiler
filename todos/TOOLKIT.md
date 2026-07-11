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

## The three GUI substrates, and no Xlib shim (2026-07-11)

Three surfaces sit on the one kernel display server (surfaces + input ring
+ WMP): **SDL** (framebuffer + input + audio — the primitive base),
**Win32** (user32/gdi32 — the widget toolkit + drivable HWND tree; primary,
per above), and — hypothetically — **Xlib**. Both Win32 and Xlib are pure
user-space translation libs *on top of the SDL veneer* (verified: the
kernel has zero Win32/Xlib knowledge; user32.c calls `SDL_*`). Division of
labor:

- **Win32 owns widget apps** — its corpus targets the OS's own widgets, so
  a thin veneer suffices and every app is agent-drivable for free.
- **SDL owns raw-canvas apps** — games, and the raw-Xlib canvas apps
  (sent/mgp/xeyes) which use only window+draw+events.

**Decision: we do NOT build an Xlib shim.** An Xlib API buys only
source-compatibility, no capability SDL/Win32 lack, and a real Xlib shim
would drag in the *hairy* Xlib (selections, atoms, ICCCM, Xrm) that Xt/Motif
need but our canvas targets never touch. So raw-Xlib apps we want are
**patched to call SDL directly** (a small per-app fork), not run over a
shim. See `todos/0119` (sent/mgp). Revisit only if an ongoing suckless/Xlib
corpus (st/dmenu/tabbed/…) ever makes per-app patching hurt more than a
veneer would. Corollary for GTK/Qt/Motif apps: the *toolkit* is the porting
unit — don't port the toolkit; port the app's portable core and re-shell it
on Win32.
