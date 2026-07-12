# 0166 — test_wm_service_e2e: 3 legs fail on clean main (DESK_ENTRIES hardcode)

- **Status**: open
- **Design**: the 0164 precedent (`todos/done/0164`, commit `33d836b` —
  derive desktop geometry from live state, don't hardcode). Diagnosed in
  `todos/IDLE-POWER.md`'s review; resolves the 0160 deferral note's open
  flake-vs-regression triage.

## Goal

`tests/kernel/test_wm_service_e2e.js` fails 3 legs on clean main today
(dblclick-on-term, `.icons` layout, Ctrl+A): `DESK_ENTRIES` (~line 79)
hardcodes 7 desktop launchers and omits the notepad icon added by
`785eca2` (its own comment says "bump when the image gains one" — the bump
never happened). Deterministic, NOT flake, NOT related to the reverted
0160 attempt; the recycle-suite twin of this class was already fixed by
0164. Must land before any IDLE-POWER stage re-runs this suite or the same
3 failures re-muddy the verdict.

## Plan

- Prefer deriving the entry set/count from live state (list `/root/Desktop`
  in-test, or reuse 0164's derivation helper) over bumping the hardcode, so
  the next seeded icon can't re-break it. Keep the Recycle-Bin-pinned-last
  special case (entcmp tail rule) intact.

## Acceptance

- `node tests/kernel/run.js --filter=test_wm_service_e2e` fully green,
  serial and parallel.
- Adding a hypothetical new Desktop seed no longer requires editing this
  test (or, if a count assert must stay, it's derived, not literal).
