# 0048 close-out — the "os-doom" failure was never doom (todos/0074)

The deterministic sweep failure blocking 0048's close was misattributed
at landing. The fix is 20 lines in the test; nothing in the OS was
wrong. Recording the diagnosis because the misattribution mechanism is
instructive.

## The tell was the sample count all along

The landing evidence: `waitFrame` timing out with identical stats across
runs — `{"h":2417206421,"colors":4,"nonTeal":1022,"n":50032}` — where
"the region math says 61936". The 0074 item theorized a canvas-dimension
race with the VT2 re-mode, because DOOM_REGION (16,40)-(648,432) yields
632·392/4 = 61936 sample points, and 50032 seemed geometrically
impossible.

It isn't. os-doom.mjs has a SECOND region: GB_REGION (16,40)-(488,464),
and 472·424/4 = **50032 exactly**. The `no frame:` error doesn't say
which region it sampled, and the debug effort (zz-doom-debug.mjs) only
ever drove doom — which passes, and always did. Re-running the leg with
the check sequence in view: every doom check `ok`, gameboy composites
`ok`, and the failure is the LAST gameboy step —

    wmctl close quit gameboy; desktop restored
    waitFrame(GB_REGION, s => s.nonTeal < s.n * 0.02, 30000)

## Root cause: the icon grid outgrew a hardcoded 2% allowance

The "desktop restored" predicate tolerated desktop-icon pixels as
`nonTeal < 2%` of the region. 758dd6e (the concurrent landing) added
three ROM launcher icons (pokemon/mario/drmario) to /root/Desktop; the
GB region's static icon coverage became 1022 samples against a
2%-of-50032 threshold of 1000.6. Off by 21 samples — deterministic,
identical hash across runs (a static teal+icons screen), colors:4.

Same failure class as os-shell/os-drop at landing (hardcoded
pre-758dd6e icon-grid geometry), wearing a different costume: those
failed at launch-time asserts, this one at restore-time, so it read as
"the window never composited".

## Fix (test-side, no OS change)

os-doom.mjs now baselines the idle desktop BEFORE launching anything:
after the first VT2 entry + canvas-commit guard, a `stableRegion` helper
waits for two consecutive identical region snapshots (the 0023 re-mode
re-lay settle), captures the signature of both regions, and each
"desktop restored" assert becomes `s.h === base.h` — restoration means
returning to the exact pre-launch signature, icon grid included. No
tolerance constant to outgrow; the assert derives from the live desktop
the way os-shell/os-drop now derive from entry lists.

Note the hash is order-sensitive (FNV over the sample grid), so this
also asserts the icons are UNCHANGED, not merely "little non-teal" —
strictly stronger than the old check.

## Sweep

- os-doom: PASS twice consecutively (the 0074 acceptance gate).
- Full 14-leg serial sweep: 13 clean + os-winmine failing on the
  documented cell-reveal flake (`at(13,61)` = screen (25,97) stayed
  face-gray — the blank-cell class), then PASS alone. Net: **14/14**.
- Headless `test_os_apps_e2e.js` green throughout (it never covered the
  restore-tolerance path — it asserts via `wmctl shot`, not desktop
  compositing).

## Bonus: the winmine cell-reveal flake is dead

The re-run-alone rule needed TWO re-runs this time (the flake fired
twice in a row), which crossed the annoyance threshold. Root cause was
sitting in the failure text: the check sampled cell (1,1)'s CENTER
pixel, but a blank reveal (no adjacent mines — roughly a third of
random boards) flood-fills FLAT: the center stays face gray and only
the raised 3D border changes. The headless twin never flaked because it
diffs the whole 16x16 cell rect (`f.equals(r)` over cellRect).
os-winmine.mjs now does the same — `rectSig` FNV over the cell rect,
wait for the signature to change. Any reveal outcome (number, blank
flood, even a mine) moves the border pixels. Validated 3/3 green; the
HANDOFF gotcha entry is retired.

## Residue

- os-quake's restore assert still carries a hardcoded 5% icon allowance
  over (16,40)-(328,232) — margin today (~3 icons in that band), same
  fragility class. Owned: added to 0064's standing checklist (repair to
  the baseline pattern when it trips or the Desktop grows in that band).
- zz-doom-debug.mjs deleted (scratch; it answered "is doom fine?" — yes
  — which was the wrong question).
- The 0074 item body's canvas-race theory is superseded by this log;
  the item closes with a Status line pointing here.
