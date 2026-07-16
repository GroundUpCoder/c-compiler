# 0215 — os-wm.mjs sysmenu leg flakes 100% under load (pre-existing)

- **Status**: open
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
