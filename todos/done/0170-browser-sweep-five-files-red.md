# 0170 — browser sweep: 5 files red on clean main (os-drop/paint/shell/user32/wm)

- **Status**: done
- **Design**: this file. Found 2026-07-12 running the full sweep as the 0165/
  0166 gate; NOT caused by those changes — every failing leg reproduces
  verbatim-identically (same legs, same last-pixel values) on clean HEAD with
  the changes stashed, serial on an idle machine. Deterministic, not load
  flake. Logs from the discovery: the two compared runs' FAIL legs are quoted
  below (per-file logs land in `build/test-browser/*.mjs.log` on any rerun).

## Goal

`node tests/browser/os-sweep.mjs` has 5 of 25 files failing on main:

- `os-shell.mjs` (1 leg): `pixel (500,300) stayed 0,128,128` — a DIFFERENT
  leg than todos/0156's known rename-leg failure ((49,52) never navy), so
  this is not just 0156.
- `os-drop.mjs` (1): `pixel (132,116) never became 255,140,0; last 0,0,0`
  (the earlier "launcher icon appeared (10-cell grid)" leg passes).
- `os-wm.mjs` (2): `the chord was swallowed (C fill unchanged) [0,200,80]`
  and `pixel (336,224) never became 255,140,0; last 0,200,80`.
- `os-user32.mjs` (3): legs stall around ctldemo's second `options-opening`
  / `opt-init` (see the per-file log for leg names).
- `os-paint.mjs` (1): `pixel (188,194) never became 255,0,0; last
  255,255,255`.

Three of the legs wait on `255,140,0` (the winbox orange fill) that never
arrives, and os-wm's chord leg is winbox's fill-flip — a shared
winbox-rendering/launch-path cause is the leading hypothesis. Bisect
candidates: whatever landed since the sweep was last known fully green
(v84 image bump, 785eca2 notepad icon, the 0163/0164 fixes, registry
batched write-back).

## Plan

- First establish last-green: check build/test-browser summaries / recent
  dev logs, then bisect the failing set (`--filter=os-wm` is the fastest
  single witness at 36s) over the suspect range.
- Triage whether it is one cause or several; split items if several.
- Re-check `os-shell` against 0156 once green — its old leg may still be
  the 0156 residue (0156 stays its own item).

## Root cause (2026-07-13) — five INDEPENDENT stale-TEST bugs, no product bug

The "shared winbox/launch-path cause" hypothesis was wrong. Every failure
was a stale test assertion, not a regression in the OS. None touch product
code; all fixes are in `tests/browser/*.mjs`:

- **os-drop / os-shell** — hardcoded `DESK_ENTRIES` (7 names) missed
  `notepad`, added to `/root/Desktop` by 785eca2. Every icon row shifted
  down one, so `term`'s derived cell was wrong and the launcher-dblclick /
  double-click-term legs clicked the wrong cell (winbox/term orange never
  arrived). Fix: DERIVE the list from `os/image.json` user section (the
  todos/0166 rule the kernel e2e already followed; the browser copies were
  never updated). os-shell's OTHER remaining fail `(49,52)` IS the 0156 leg
  — confirmed still separate, stays deferred under 0156. Fixing os-drop's
  first leg UNMASKED a second latent bug (the test used to bail before it):
  the persistence-reload leg reassigns `page = context.newPage()` but the
  `setVt` helper had captured the ORIGINAL page, so `setVt(1)` after the
  reload hit the closed page ("Target page has been closed"). Fix: `let`-
  bind the helpers and rebind `osHelpers(page)` after the reopen.
- **os-wm** (3 legs) — winbox toggles its fill green on the BARE `Alt`
  keydown (the os-snap "one toggle per chord" behavior), so Alt+Space
  leaves C GREEN, not orange-unchanged. The test asserted fill-UNCHANGED
  and waited for orange. Fix: assert exactly-one-toggle (green) is the
  swallow proof; the moved-corner check samples B's orange underneath (not
  teal); close-teardown probes a point clear of A/B + shadows; the no-WM
  leg waits for each of the two toggles in turn.
- **os-paint** — `sample()` used canvas-LOCAL coords but every call passed
  PAGE coords (`scr()`/`bmp()` include the canvas origin) → sampled the
  wrong pixel; and the toolbox tap missed the `+BAR` menu-bar offset. Fix:
  subtract the canvas rect in `sample`, add `+BAR` to `tbCell`, and wait on
  paint.c's `paint: tool=5` / `paint: fg=` tty markers (0083) not sleeps.
- **os-user32** (3 legs) — (a) the two 0105 cursor-hover legs read
  `canvas.style.cursor` one gesture stale (fixed 200ms sleep raced the
  SetCursor RPC) → poll+jiggle until it settles; (b) modal dialogs are
  kernel-CASCADED (each open lands one slot further: `+40+60`, `+68+84`,
  `+96+108`), so the hardcoded `(120,100)` sample fell in the REOPENED
  Options dialog's navy title bar. Fix: `dialogGeom(title)` reads the live
  `WxH+X+Y` from `wmctl list` and samples BTNFACE at `x+w/2, y+40`.

## Acceptance

- `node tests/browser/os-sweep.mjs` fully green (except any leg explicitly
  owned by 0156, if that is confirmed still separate).
- `node tests/flake.js` clean afterward if the fix touches frame/input
  paths.
