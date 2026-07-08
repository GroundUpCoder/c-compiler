# 0039 — WM bug sweep, round 2

Second dedicated dogfood/verification session over the desktop surface
area, per the repeatable 0033 format: suites → storms → standing
checklist → findings-as-tests-first. Round 2's brief additionally
demanded re-verifying 0038's z layers under storm and the pointer-lock
HUMAN check round 1 skipped.

## Deterministic suites (pre-round baseline)

- unit: **698 passed, 0 failed, 3 skipped** (matches the 0034 handoff)
- blockfs (`tests/blockfs/run.js`): all passed (incl. fuzz + mounts)
- kernel (`tests/kernel/run.js`): all passed (incl. gpubox Dawn e2e —
  webgpu pkg present)

## Browser sweep (real Chromium, serial)

os-boots✓ os-wm✓ os-scale✓ os-doom✓ os-quake✓ os-gpubox✓ os-term✓
os-vt✓ os-screen✓ os-shell✓ — **10/10 on the first run, zero flakes**
(round 1 needed two icon-tolerance test fixes; nothing this round).
Re-run in full after the kernel.js fix below: 10/10 again.

## Storms

- **0038 layer storm** (headless, new this round): 6 winboxes + a
  scripted `wmctl layer/raise/lower/focus/min/restore/max/cycle` gauntlet
  (single ops, band transitions, error paths, a 5-round rapid-fire mix,
  SIGKILL of a +1-pinned window, wm kill/respawn under pinned windows),
  with `wmctl list` snapshotted after EVERY op and a checker asserting
  the 0038 invariant mechanically: z-sorted layers non-decreasing, z
  consecutive after reclaim, taskbar T / desktop B. **29 snapshots, 0
  violations** — the invariant the 0038 log worried about ("no checker
  for it") held under everything we threw at it.
- **Headless open-everything** (round-1 shape): winbox + fixbox + term +
  gameboy + doom + quake + gpubox up simultaneously (9 surfaces), 12
  rapid `wmctl cycle`s under load, move/scale/max storm, `kill -9`
  winbox mid-pending-resize / quake scaled / doom mid-audio / gpubox
  mid-Dawn-frames — every one reclaimed, no ghosts; wm kill → endpoint
  serves, apps live; `wm &` re-places; screen shot clean; exit 0.
- **Dawn + SIGKILL retest (S3 caveat)**: survived both the storm leg and
  an isolated retest — second clean round on webgpu 0.4.x.
- **Browser storm** (round-2 additions): desktop-icon dbl-click races
  (straddled rapid clicks on two icons launch nothing; 4 rapid clicks
  launch exactly 2 — wm.c's desk_last_idx reset prevents chaining),
  Start-menu spawn storm (4 back-to-back launches, all spawned, all
  reaped), 10 rapid cycle chords under load (exactly one focused
  surface after), VT flips mid-title-drag and mid-press (no wedge),
  taskbar always-on-top under a 4-window pile-on (strip stays bar
  chrome, z stays bar-top, button clicks work THROUGH the overlap),
  screen shrink to 760px with a maximized + a scaled + a minimized
  window in play (bar re-laid, maximized re-fit, nothing stranded) and
  grow back. **PASS, zero page errors.**

## Findings ledger

- **FIXED — the focus fall landed on pinned furniture** (the round's one
  real bug, caught by the layer storm): after 0038 the taskbar is ALWAYS
  top of raw z, so the destroy/minimize focus fall ("topmost
  non-minimized surface") parked keyboard focus on the bar whenever the
  focused window died or minimized — typed keys then vanished into the
  furniture. Pre-0038 the top of z was usually an app window, so the old
  walk was right by accident. Fix: `_wmFocusFall` (kernel.js, one helper
  replacing both duplicated walks) prefers the topmost non-minimized
  NORMAL-layer window; furniture only takes the fall when no normal
  window remains (the degenerate keeps pre-0038 behavior; no-WM paths
  see no change — without layers pass 1 IS the old walk). Test-first:
  failing legs in commit 9a040a1 (test_wm_policy.js minimize/destroy/
  degenerate falls; test_wm_service_e2e.js SIGKILL-the-focused-winbox
  under the real wm.c bar), fix in 5798a0c. No image bump — kernel.js
  is host-side.
- **By design, noted**: after a wm kill/respawn with an agent-pinned
  layer -1 window in play, the NEW desktop lands above that window
  (within-band arrival order — the same stable-sort semantics that put
  the Start menu above the taskbar in +1). Only reachable by `wmctl
  layer SID -1` deliberately spanning a wm restart; not worth policy.
- **Storm-authoring gotchas** (test-expectation class, for round 3):
  the re-laid taskbar strip row is button CHROME after a few launches —
  white bevels, black glyphs, 222 highlights — so "bar present" pixel
  asserts must accept the chrome family, not demand pure FACE; a
  taskbar button click on an unfocused window FOCUSES it (Win95
  semantics), so minimize-via-button asserts must pin the focus state
  first; `cmd &; echo` is a hush parse error (join with a space);
  `__osScreen` only tracks the viewport while VT2 is visible.

## Standing-checklist outcomes

- **pointer-lock UX (HUMAN)**: **still not human-verified** — the
  operator was away at close (noting it "worked many times before").
  Everything below the browser lock grant is suite-covered
  (test_wm.js/os-quake.mjs); the grant-side UX check carries forward
  as a MUST for round 3, two rounds deferred now.
- **taskbar always-on-top (0038)**: HELD under the layer storm + the
  browser pile-on. Entry retired from the known-issues list.
- **Dawn + SIGKILL**: two clean trials again this round; caveat wording
  stays (retest per sweep), risk keeps shrinking.
- **os-gpubox adapter flake**: not reproduced — quiet two rounds now.
- **snake double-q**: unchanged vendor quirk, stays documented.
