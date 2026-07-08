# 0032 — window cycling: the kernel chord → EV_CYCLE

Landed `todos/0032`: Alt-Tab-shaped focus cycling. The one desktop-shell
piece needing new kernel mechanism — every key went to the focused
surface; now ONE chord is recognized at the `wmKey` routing seam and
emitted as **WMP EV_CYCLE { direction }** instead of being delivered.
Image v25 (wm.c + wmctl.c seeded).

## Decisions

- **Chord: Tab with Alt held** (mod & ALT, scancode 43) — documented as
  Ctrl+Alt+Tab (aligning with the VT chords, in the Desktop tab tooltip
  per the discoverability rule), but plain Alt+Tab works too where the
  browser delivers it (macOS — Windows/Linux OSes grab both Alt+Tab and
  Ctrl+Alt+Tab, which is exactly why `wmctl cycle` exists). Shift
  reverses. The matching keyup is swallowed (no half-chords); key repeat
  keeps cycling.
- **No subscriber → no interception**, exactly as designed: the chord
  isn't recognized at all and the Tab lands in the focused app. The
  kernel never silently eats keystrokes; `wmCycle`/WMP CYCLE refuse
  without a WM (R_ERR — cycling IS policy, the maximize precedent).
- **Policy is LRU-stamp based, not z-based** (an in-item deviation from
  the design sketch, for cause): wm.c can't track true kernel z (RESTACK
  has no event), and Alt-Esc-style lower-then-focus would push windows
  BELOW the 0029 desktop layer. Instead every EV_FOCUS/EV_CREATED stamps
  the window with a counter; **dir>0 focuses the least-recently-used**
  (repeated presses tour the whole ring — each FOCUS echo restamps, so
  the walk converges instead of ping-ponging), **dir<0 focuses the
  second-most-recent** (the quick previous-window toggle, and the exact
  inverse of one forward step). Minimized windows are skipped. Stateless
  — no chord-session tracking, no Alt-release event needed.
- `wmctl cycle [DIR]` → WMP CYCLE 0x19 → the same EV_CYCLE ("one op set,
  exposed twice"). EV_CYCLE is 0x8B.
- **Browser-test gotcha**: hush `kill` is cooperative SIGTERM — the wm
  stays SUBSCRIBED (and eats the chord) until it actually dies. The
  no-WM passthrough leg must barrier on the wm's surfaces vanishing
  (taskbar pixel → teal), not on the `kill` returning.

## Tests

- `test_wm.js`: chord with NO subscriber passes through (down+up in the
  app ring), `wmCycle` refuses.
- `test_wm_policy.js`: chord down → EV_CYCLE{+1}, keyup swallowed, Shift
  → {-1}, CYCLE command rides the same event, plain Tab still delivered.
- `test_wm_service_e2e.js`: real wm.c policy — `cycle -1` = previous
  window, again = toggle back, minimized skipped (deterministic recency
  ladder set up via explicit focuses), forward walks to the LRU.
- `os-wm.mjs`: chord flips focus between two winboxes (title colors),
  flips back; kill the wm → the chord reaches the app (fill toggles).
