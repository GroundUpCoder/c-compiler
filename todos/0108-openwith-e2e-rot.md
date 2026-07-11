# 0108 — test_openwith_e2e: register in run.js + realign with the sameboy .gb default

- **Status**: open
- **Design**: `tests/kernel/test_openwith_e2e.js`, `todos/done/0072`,
  `todos/done/0075`. Filed by the 0092 closeout audit.

## Goal

`tests/kernel/test_openwith_e2e.js` silently rotted: it was never added to
the run.js MANIFEST (the exact trap the 0091 handoff warned about — a test
file not listed in `tests` never runs), and it fails 3 checks on baseline
because the baked `.gb`/`.gbc` association moved to `/bin/sameboy` (the
recorded 0075 call) while the test still expects Peanut-GB windows and a
`gb\t/bin/gameboy` line in the carried-forward user table. A test that
neither runs nor passes guards nothing — the 0072 openwith surface
(resolver order, picker persistence, default.gui) is currently unprotected.

Note the contradiction for the fix: `todos/done/0075`'s early Status line
says "gameboy … still the .gb/.gbc default", but the final call (HANDOFF
don't-re-litigate, CLAUDE.md, and the actual `os/image.json` seed) is
**sameboy is the default**. The image seed is the truth; realign the test
to it, not the other way around.

## Plan

- Update the drifted expectations: `.gb` opens → a SameBoy window (title?
  check `vendor/sameboy`'s window title), `conf1` carries
  `gb\t/bin/sameboy` forward.
- Add `['test_openwith_e2e.js', IMG]` to the run.js manifest with a
  one-line comment (0072: resolver order, picker, persistence).
- While there: eyeball the other never-registered test files —
  `ls tests/kernel/test_*.js` vs the manifest — and register or delete any
  other orphans found.

## Acceptance

- `node tests/kernel/test_openwith_e2e.js` passes on a clean checkout.
- `node tests/kernel/run.js --filter=openwith` runs it (proof of
  registration) and passes.
