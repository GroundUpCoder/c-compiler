# Maximize/restore (todos/0025) — the last outer-geometry piece

Lands `todos/0025`: double-click a title bar to toggle maximize. With
0021 (resizable gating), 0023 (dynamic screen), and 0024 (viewport
scaling) in place this was, as predicted, nearly pure policy — the only
new kernel mechanism is double-click detection.

## Shape

- **Kernel (mechanism only)**: `wmPointer`'s title-down branch tracks
  the last title mousedown `{sid, x, y, t}`; a second down on the same
  sid within `WM_DBLCLICK_MS` (400) and `WM_DBLCLICK_SLOP` (4px) emits
  **WMP EV_TITLE_ACTIVATE 0x8A** and starts NO drag (the gesture must
  not also move the window). The kernel keeps zero maximize state.
  A new **ACTIVATE 0x18** command (`wmctl max SID`) fires the same
  event — one policy path for mouse and agent, per the one-op-set rule.
  It returns R_ERR with no subscriber: maximize IS policy, so unlike
  kernel-implemented minimize there is no no-WM fallback (kernel chrome
  stays minimal, as decided in the item).
- **wm.c (policy)**: per-window `maximized` flag + saved geometry
  (x, y, and w/h for resizable windows, dst for fixed-size — whichever
  the branch will clobber). On activate, dispatch on the RESIZABLE bit
  (the same bit that makes RESIZE vs SET_DST legal — 0021/0024's
  exclusive modes): resizable → MOVE(0, TITLE_H) + RESIZE to the work
  area (screen minus taskbar, below the kernel title bar); fixed-size →
  centered aspect-fit SET_DST. Second activate restores the saved
  geometry. EV_SCREEN while maximized re-fits to the new work area
  instead of clamping.
- **wmctl**: `max SID`, "max refused (no WM?)" on R_ERR.

## Decisions & gotchas

- **The 15% integer snap can overflow a fit box.** 0024's `fit_dst`
  snaps a scale within 15% of a whole multiple — deliberately allowed
  to round UP past the drag box (a drag is an approximate gesture; the
  gameboy-at-1.9x case wants 2x). Maximize must never overflow the work
  area, though: at the browser test's ~1084×852 screen, 240×160 fits at
  4.52x and would have "snapped" to 5x = 1200px wide, off screen. Fix:
  `fit_dst` grew an `allow_over` flag — the drag path keeps snap-up,
  maximize falls back to the raw fit when the snap doesn't fit.
- **Clock-backwards guard.** Double-click detection requires
  `0 <= dt <= 400ms`. The negative case is real: mixed time origins
  (bridge event timestamps vs `Date.now()` fallback vs test-injected
  `opts.t`) must never look like a double-click. Caught by
  test_wm_policy, where an untimestamped title click preceded a
  `t: 5000` one.
- **Event timestamps ride the bridge.** os.html now sends
  `e.timeStamp` with mousedowns and `routeInput` threads it through as
  `opts.t`, so the detector measures the user's real inter-click gap
  instead of worker processing time (a busy compositor tab could
  otherwise eat the gesture).
- **A wm restart forgets maximize state** — the saved-geometry map
  lives in wm.c and the respawn snapshot has no "maximized" bit. Fine
  by design: restarting the WM already re-places windows ("tidies the
  desktop"); the next double-click just re-saves.
- **Emit-order note for scripted clients**: the activating down still
  focuses first, so an unfocused window produces EV_FOCUS before
  EV_TITLE_ACTIVATE.

## Tests

- `test_wm.js`: detection matrix — fast pair activates (and starts no
  drag), third click starts over, slow pair drags, out-of-slop pair
  drags, no app-event leaks.
- `test_wm_policy.js`: EV_TITLE_ACTIVATE to the subscriber from the
  real hit-test path; ACTIVATE → same event; R_ERR on bogus sid and on
  borderless (no title bar, no gesture).
- `test_wm_service_e2e.js`: real wm.c/wmctl through boot.js —
  `wmctl max` on winbox fills the 1024×712+0+28 work area and restores
  240×160+12+36 exactly; on fixbox scales to the snapped 4x 960×640
  centered (buffer untouched) and restores the pre-max 480×320 dst;
  refused after killing the wm.
- Browser: `os-wm.mjs` (real `dblclick` → work-area fill → restore,
  taskbar stays visible) and `os-scale.mjs` (fixed-size scale-to-fit,
  letterbox stripe, inverse-mapped click at the maximized center,
  restore) — both derive expectations from the live `__osScreen`.

Image bumped to **v19** (wm.c/wmctl.c/wm_proto.h are seeded sources).
