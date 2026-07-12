# 0170 — browser sweep: 5 files red on clean main (os-drop/paint/shell/user32/wm)

- **Status**: open
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

## Acceptance

- `node tests/browser/os-sweep.mjs` fully green (except any leg explicitly
  owned by 0156, if that is confirmed still separate).
- `node tests/flake.js` clean afterward if the fix touches frame/input
  paths.
