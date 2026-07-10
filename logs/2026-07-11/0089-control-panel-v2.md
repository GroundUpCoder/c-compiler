# 0089 — Control Panel v2: the applet hub (+ per-window WM_CLOSE)

`/bin/ctlpanel` grew from the 0048 single dialog into the classic Windows
Control Panel: the main window is a FOLDER of applet icons, each applet
its own sibling top-level window. Sound (the 0048 volume controls,
lifted verbatim) and System (os-release + /proc/uptime) moved into their
applets; Display is a stub naming todos/0049 (the wallpaper picker's
Control Panel home); Date/Time is new — a live clock over
SetTimer/WM_TIMER, which doubles as the first real acceptance of the
0068 timer outside winmine.

## The veneer growth: per-window close

The item's applet model exposed a 0058 simplification: the kernel's
close request ('x' / `wmctl close`) reached user32 as a process-wide
`SDL_EVENT_QUIT` routed to the FIRST live top-level — so closing an
applet window would have closed the hub (and with it the whole panel).
The fix was already latent in the stack: the kernel names the closed
surface in the QUIT ring record (`_wmEventTo` stamps the sid) and
host.js even computed the SDL handle — then dropped it.

Now: host.js passes the handle; the SDL side (compiler.js builtin)
delivers `SDL_EVENT_WINDOW_CLOSE_REQUESTED` (0x210, the SDL3 event) with
that windowID **when more than one window is live**, and keeps the
historical process-wide `SDL_EVENT_QUIT` for the only/last window;
user32's pump routes CLOSE_REQUESTED's WM_CLOSE to exactly that
top-level. Deliberate divergence from upstream SDL3 (which sends
CLOSE_REQUESTED and then QUIT for the last window): ONE event per
request, so a queued pair can't double-close. Single-window apps (doom,
quake, term, every current test) see byte-identical behavior; a bonus is
that 'x' on a MessageBox/dialog now cancels the dialog (DefDlgProc
already handled WM_CLOSE) instead of hitting the main window.

## Decisions

- **Single-click activation** (the IE4 web-view model), not the Win95
  double-click: one `wmctl click "Sound"` = one open — the agent path
  posts one LBUTTONDOWN/UP pair per request, so double-click activation
  would have needed timing-dependent paired clicks (the 0077 same-icon
  pairing gotcha, but over the agent socket where timestamps are
  drain-time). Selection still exists: down selects (navy label strip,
  the 0077 look), up opens; hub keyboard = Left/Right/Home/End + Enter
  (Up/Down alias Left/Right until a second row exists).
- **Labels are the agent namespace, keep them unique**: icons are
  "Sound"/"System"/"Display"/"Date/Time", applet windows are
  "* Properties" (the Win95 titles), and the 0048 "Sound"/"System"
  groupboxes were renamed/dropped ("Master Volume" / plain STATICs) so
  `wmctl click System` never hits a BUTTON-pass groupbox before the
  icon.
- **Hub close = panel quits** (all applets are the same process, unlike
  Win95's rundll32-per-applet); applet close via its kernel 'x' closes
  just the applet — the new veneer semantics carry exactly this split.
- **One instance per applet**: re-activating an open applet is a no-op
  (no SetForegroundWindow in the veneer yet; acceptable — the window is
  already up).
- **Mouse/Keyboard applets not built** (the item listed them as
  opportunistic): there is no live kernel state for them to control
  today. The item that introduces such state (key repeat, pointer
  accel, cursor themes…) owns creating its applet.

## Gotchas

- CplIcon children carry their label as WINDOW TEXT so the agent tree
  lists them and `wmctl click LABEL` resolves them (pass 2, any shown
  window) — a custom class gets WM_GETTEXT for free from DefWindowProc.
- `wmctl gettext STATIC:0` still addresses the volume label ONLY
  because the hub has no STATICs and the tests open Sound first —
  CLASS:n is tree-order-global across every top-level. The e2e keeps
  that ordering deliberately.
- `wmctl key SID 79 1073741903` / `40 13` drives hub keyboard headless
  (SDL scancode+keysym; user32's vk_of maps by keysym).
- The hub registers CplIcon with the SAME WNDCLASS struct reused —
  hbrBackground stays COLOR_WINDOW+1 from the CtlPanel registration
  (folder white); the applet classes then switch to COLOR_BTNFACE+1.

## Tests

- `tests/kernel/test_ctlpanel_e2e.js` extended (not replaced): hub tree
  (4 CplIcon), single-click open, the 0048 volume legs verbatim inside
  the Sound applet, per-window close (applet dies → hub lives), reopen
  reads kernel gain, keyboard Right+Enter opens System, Display stub,
  the WM_TIMER clock ticks, hub close quits everything, cross-process
  gain persistence. ALL OK first run.
- `tests/browser/os-shell.mjs` grew the 0089 leg: hub composites as an
  icon folder (live-geometry parse, 0023 rule), pixel click on the
  Sound icon opens the applet in its own window, agent-tree volume
  (110%) + System (os-release) drive, kernel close box on the applet
  leaves hub + System alive.

Image v49 → v50 (ctlpanel.c is a baked source; compiler.js/host.js are
bake inputs). Zero kernel.js change in the whole item.
