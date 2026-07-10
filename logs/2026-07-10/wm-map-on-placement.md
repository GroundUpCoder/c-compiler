# WM map-on-placement — no first-frame teleport (todos/0069)

Every new window — app windows and the wm's own furniture, the Start
menu most visibly — composited for a few frames at the kernel's
sid-cascade default before `/bin/wm`'s `EV_CREATED` → `WMP_MOVE` round
trip landed, then jumped to its placed spot. Structural, not a race:
`SURFACE_CREATE` bumped `_wmVersion` immediately, so the very next
compositor pass drew the surface while placement still had to cross two
workers plus wm's poll loop. Fixed with the classic X11/Wayland answer:
a WM-managed surface is not **mapped** until the WM has placed it.

## What landed (kernel.js + os/compositor.js only — zero wm.c change)

- `SURFACE_CREATE` with a WMP subscriber creates the surface
  `mapped: false`. Both compositor flavors (the WebGPU pass reads the
  flag off the live surface objects; `wmScreenshotScreen` skips it) and
  the pointer hit-test ignore unmapped surfaces. Everything else still
  works on them: they're listed (`wmList` grew a `mapped` field),
  focusable, injectable, and single-surface `SHOT`-able — agents are
  unaffected.
- **Map ack = the WM's first geometry/stacking op on the sid**:
  `wmMove` / `wmResize` / `wmSetDst` / `wmSetLayer` / `wmRestack`
  (including their success-no-op paths — the WM addressed the window's
  geometry, that IS the placement decision). wm.c already answers every
  `EV_CREATED` with a `WMP_MOVE` — for app windows via `place()`, for
  its own furniture via the by-title park — so that MOVE doubles as the
  map ack and wm.c needed no changes at all.
- **Borderless dispatch**: wm.c deliberately ignores foreign borderless
  surfaces (`WMP_F_BORDERLESS` early-return — taskbar-class,
  owner-positioned), so those map at create; they'd otherwise always
  eat the backstop delay. But the wm's OWN furniture is also borderless,
  and the start menu is the worst teleport case — so a borderless
  surface whose owner pid has a subscribed WMP connection stays
  unmapped for its self-park. `wmServe` now records the connecting
  pid on the conn (the `sockServe` handler always had the pcb).
- **Backstops — a WM can never hide windows**: `WM_MAP_TIMEOUT_MS`
  (200ms, exported) maps a surface a wedged WM never places, and the
  last subscriber dropping (crash, close, corrupt-stream hangup — now
  centralized in `_wmSubDrop`) maps everything pending at once.
  `_wmDestroySurface` clears the pending timer.
- **No subscriber → mapped at create**: kernel-chrome/no-WM boots are
  byte-identical to pre-0069 (test_wm.js runs subscriber-less and
  passed unmodified; one explicit `mapped === true` assert added).

## Decisions

- Map triggers are geometry/**stacking** ops only — FOCUS and MINIMIZE
  do not map. wm.c never focuses a window it hasn't placed, and a
  pathological WM is what the timeout backstop is for.
- The WMP window record (80 bytes) is unchanged — no `mapped` bit. wm.c
  doesn't need it, and the record is a three-way MUST-MATCH
  (kernel.js / wm_proto.h / test_wm_policy.js); `wmList` carries the
  flag for tests/agents instead.
- `SURFACE_RESIZE` (0068's owner-initiated resize) does NOT map — it's
  the app's own op, not the WM's placement.

## Tests

- `test_wm_policy.js` grew a 0069 section: unmapped create (composite
  shows desktop at the record's cascade x,y; hit-test falls through to
  'desktop'), injection + SHOT while unmapped, MOVE-maps (first
  composited position IS the placed one), SET_LAYER-maps (no-op layer),
  the 200ms backstop, foreign-vs-subscriber-owned borderless, and
  last-subscriber-gone mapping all pending.
- `tests/browser/os-shell.mjs` grew a first-open burst capture: an
  in-page rAF loop samples every frame through the Start-menu open —
  face-gray pixel count over the whole cascade band (x≤460, y≤~436,
  which every sid-cascade placement of the 150×188 menu intersects)
  must stay ~0 in EVERY frame while the parked position lights up.
  In-page rAF gives per-frame granularity a CDP round-trip poll can't.
  **Teeth-checked**: with the kernel fix disabled the leg fails with
  `maxCasc: 26699` (the menu fully composited in the band); with the
  fix, 0. The kernel suite + the 14-leg browser sweep ran green at
  landing.

## Gotchas for later

- The burst-capture leg relies on nothing face-gray living in the
  cascade band at that point in os-shell.mjs (icons are white/navy,
  antialiased text blends toward teal). A future window opened BEFORE
  that leg with gray chrome in the top-left band would false-positive
  it — keep the leg early, right after boot.
- Unit tests that create a surface WITH a subscriber and then
  composite/hit-test immediately must either send a MOVE/SET_LAYER
  first or expect the surface to be invisible for WM_MAP_TIMEOUT_MS.
  (test_wm_policy's pre-existing legs all happened to place first —
  only ring-drain hygiene needed touching.)
- Backstop timers are per-surface `setTimeout`s — cleared on map and on
  destroy, so nothing lingers past 200ms; but a fake-worker test that
  creates surfaces and never places them will see them self-map 200ms
  later (deliberate).
