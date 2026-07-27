# 0271 — os-touch.mjs taskbar-menu leg red after osk-bigger (pre-existing on main @e188893)

- **Status**: done
- **Design**: —

## Goal

`tests/browser/os-touch.mjs` fails deterministically since the osk-bigger
merge (e188893, os.html/osk.js only — the test file itself unchanged):

```
FAIL: pixel (92,726) never became 192,192,192; last 0,128,128
```

That is the **taskbar-button long-press → window menu** leg (`longPress(100,
SH-14)` then `waitPixel(BMX+4, BMY+46, FACE)` with `BMX=88, BMY=SH-36-134`)
— NOT an OSK-key pixel probe. Proven pre-existing: identical failure on
pristine main @e188893 with zero other content (found during the t3-closeout
re-gate, which is otherwise fully green — see
`logs/2026-07-21/t3-closeout-merge-ship.md`). All earlier os-touch legs
(taps, icon menu, double-tap launch, EDIT pan, touch title-drag) still pass.

Likely mechanism to verify: the OSK is a flex SIBLING of the VT
(`body[data-osk] #osk`), so when visible it shrinks the desktop canvas and
fires `screen-resize`; the test samples `__osScreen` ONCE at start. With the
56px-key OSK now taller, either (a) the canvas shrinks after the sample so
`SH` is stale and the long-press lands on OSK DOM instead of the canvas
taskbar, or (b) the bottom-of-canvas geometry the leg computes no longer
matches. Decide whether this is a TEST geometry fix (re-sample `__osScreen`
before the leg / derive from the live rect) or a real touch-UX regression
(OSK occluding the taskbar on touch devices) — if the latter, it is a
product P0, not a test fix.

## Plan

- Reproduce headful/screenshot the moment of the long-press; check whether
  the OSK is visible and where the canvas bottom actually is.
- Fix root cause per the 0171 discipline (no quiet re-tune without naming
  the mechanism); re-run `node tests/browser/os-sweep.mjs --filter=os-touch`
  and the flake tripwire.

## Acceptance

- os-touch.mjs green in the full sweep on main, mechanism documented.
