# 0199 — os-wm.mjs 'keyboard Move relocated C' leg flakes under load

- **Status**: open
- **Design**: tests/browser/os-wm.mjs (the 0102 sysmenu keyboard-Move leg), CLAUDE.md "Test-sync discipline"

## Goal

The os-wm.mjs leg `keyboard Move relocated C (+40,+16)` intermittently
fails (observed 2/5 runs on 2026-07-15 during the 0198 gate, on a tree
whose emitted binaries hashed byte-identical to a passing HEAD — so the
product bytes are excluded as the cause). Failure shape: the
`waitPixel(CX + 240, CY + 116, GREEN, 30000)` after the Move commit burns
its full 30s and reports `[192,192,192]` (gray) — the window never moved,
or the sysmenu never entered move mode.

Root-cause and fix the SYNC, not the symptom (no timeout inflation, no
quiet retry): find the unsynchronized step between the SYSMENU-UP echo
(sysmenu confirmed present via wmctl on VT1) and the ArrowDown/Enter
sequence on VT2. Prime suspect: the keypresses race the sysmenu root's
FOCUS/grab acquisition — presence in `wmctl list` doesn't prove the menu
root already holds kernel focus, so early arrows may land on winbox C or
fall dead, leaving the menu on the wrong row when Enter fires.

## Plan

- Reproduce with `node tests/browser/os-sweep.mjs --repeat 5 --filter=os-wm`
  and `--under-load` (the 0147 flake gate) to get a rate.
- Instrument: on failure, dump `wmctl list`/`wmctl tree` — is the ctxmenu
  still up? Did C keep focus? Which row was selected?
- Fix the wait (e.g. wait for the menu root to hold focus — a focus-flag
  probe or a wm-side marker — before typing), per the 0171 discipline:
  wait on a marker, never on presence alone.
- Add the file to the flake-gate tripwire set if the class warrants it.

## Acceptance

`node tests/flake.js --filter=os-wm` (or the sweep `--repeat 5
--under-load`) reports 0% flake on the leg; the fix is a real sync marker,
not a longer timeout.
