# 0033 — WM bug sweep, round 1

Dedicated dogfood/verification session over the whole desktop surface
area, run immediately after the 0028–0032 shell round. Output per the
item: findings → fixes/known-issues, and WM.md gained the standing
**Known issues** section this format re-checks every round.

## Deterministic suites (post-round re-baseline)

- unit: **697 passed, 0 failed, 3 skipped** (matches the handoff baseline)
- blockfs (`tests/blockfs/run.js`): all passed (incl. fuzz + mounts)
- kernel (`tests/kernel/run.js`): all passed (incl. the new 0028–0032
  legs and the gpubox Dawn e2e — webgpu pkg present)

## Browser sweep (real Chromium, serial)

os-boots✓ os-wm✓ (incl. new 0030 box + 0032 chord legs) os-scale✓
os-doom✓* os-quake✓* os-gpubox✓ os-term✓ os-vt✓ os-screen✓ os-shell✓
(new, 0028/0029/0031 legs).

*os-doom and os-quake failed on first run — **test-expectation breaks,
not product bugs**: their "window closed → desktop restored" waits
demanded `nonTeal === 0` over the window region, and the 0029 icon grid
now lives there (554/61936 px for doom's region, ~3.2% for quake's).
Fixed to icon-tolerant thresholds (<2% / <5%), re-run green.

## Storms

- **Headless open-everything** (boot.js): winbox + fixbox + term +
  gameboy + doom + quake + gpubox all up simultaneously (9 surfaces);
  `kill -9` winbox mid-pending-resize, quake, doom mid-audio, gpubox
  mid-Dawn-frames — every one reclaimed, no ghost windows; wm kill →
  apps keep running, endpoint serves; `wm &` respawn re-places the
  scene; `wmctl cycle` + screen shot clean at the end. Exit 0.
- **Dawn + SIGKILL retest (S3 caveat)**: isolated gpubox `kill -9`
  under Dawn — the Node process SURVIVED (twice, incl. the storm).
  The caveat has shrunk on the current webgpu pkg; recharacterized on
  the known-issue list (drain discipline stays, retest per sweep).
- **Browser storm**: maximized + scaled + minimized windows in play,
  viewport shrink to 640 (taskbar re-lay, maximized re-fit) and grow
  back; VT flip mid-title-drag (no wedge); doom `kill -9` mid-audio
  (window + stream reclaimed); zero page errors; shell alive.

## Standing-checklist outcomes

- **pointer-lock UX: still needs a human** — Playwright can't grant
  CDP-gesture lock. Mechanics below the grant are covered by suites.
  Flagged in the known-issue list and to the operator.
- **os-gpubox adapter flake: not reproduced** this round.
- **snake double-q**: unchanged vendor quirk, stays documented.

## Findings ledger

- FIXED (tests): os-doom/os-quake desktop-restored asserts (above).
- NEW KNOWN ISSUE (verified, deferred): **the taskbar is not
  always-on-top** — every create raises above it, so a window dragged
  onto the bottom strip covers the bar (evidence: storm z-order shows
  app windows above `taskbar`; the drag clamp allows y up to
  scr_h-8). Deferred with repro + fix sketch on the WM.md list.
- RECHARACTERIZED: Dawn+SIGKILL (shrunk), gpubox flake (quiet).
