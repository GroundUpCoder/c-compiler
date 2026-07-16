# 0215 — os-wm.mjs sysmenu leg flakes 100% under load (pre-existing)

- **Status**: done (2026-07-17)
- **Design**: tests/browser/os-wm.mjs (the 0102 window-system-menu legs),
  tests/flake.js mechanism (todos/0147), test-sync discipline (todos/0171)

## Goal

`node tests/browser/os-sweep.mjs --repeat 3 --under-load --filter=os-wm`
fails 3/3 (found 2026-07-16 during the 0214 close-out sweep; one
unloaded full-sweep run also hit it once, then passed on retry — so it
occasionally bites plain serial sweeps too). **Verified pre-existing:**
pristine main @4c5495a fails 3/3 under load with the identical
signature, so this is not a 0214 regression.

Signature (os-wm.mjs:287, the 0102 sysmenu chord-swallow proof):

    ok   Alt+Space opened the window system menu
    FAIL: pixel (296,208) never became 0,200,80; last 0,0,0

The winbox-C fill probe (CX+200, CY+100) expects GREEN (exactly one Alt
toggle, Space swallowed) and reads BLACK at timeout — not orange (leaked
Space) and not teal (missing window), which suggests the probe races
something that draws black there (menu popup over the probe point?
winbox mid-redraw under load?) rather than an actual swallow failure.

## Plan

Diagnose under `--under-load` (the failure is 100% reproducible):
`wmctl shot` at the timeout to see what actually covers (296,208);
check whether the sysmenu popup geometry can overlap the probe point on
the moved cascade slot, and whether the leg needs a menu-position-aware
probe or a wait-for-redraw marker instead of a fixed pixel. Fix the
root cause per the 0171 discipline (no quiet-the-symptom sleeps); the
diagnostic should name the cause on failure.

## Acceptance

- `node tests/browser/os-sweep.mjs --repeat 3 --under-load
  --filter=os-wm` 3/3 green.
- Full sweep stays 27/27.

## Resolution (2026-07-17) — test choreography bug, OS semantics correct

A pixel-grid dump at the timeout showed an exact 8x8 BLACK square spanning
(292,204)–(299,211) with GREEN on all four sides: winbox's persistent
click mark, painted at client (200,100) by the leg's own "focus C" click —
i.e. the Space really was swallowed (the fill was green everywhere), and
the probe was reading the test's own click paint.

Root cause: the "C composited" wait probed (CX+200, CY+100), a point that
lies inside B's client too, so it was satisfied by B before C even mapped
(map-on-placement, todos/0069 — unmapped surfaces are skipped by the hit
test). The follow-up focus click therefore RACED C's map: serially the
click usually arrived before C existed and landed harmlessly on B (mark
later hidden under C); under load the Playwright CDP round-trips starve
while the kernel worker proceeds, C maps first, the click landed on C,
and the mark sat exactly on the later green-swallow probe pixel.

Fix (per the 0171 discipline — sync on an observable event, no sleeps),
mirroring the already-correct A/B chord leg's ordering:
- wait for C's FOCUSED NAVY TITLE first (composited only once mapped;
  create-focus is kernel mechanism, so it is C's) — the map/focus proof;
- then confirm C's orange fill at the probe point (now genuinely C's);
- then send the canvas focus click, moved to (CX+30, CY+30) — on C but
  clear of every later probe, since a winbox click paints where it lands.
`waitPixel` grew an optional `what` label so the failure names its cause.
Test-only fix: no bake, no image bump.

Gate: filter=os-wm --repeat 3 --under-load 3/3 stable (flake 0%);
full browser sweep 27/27.
