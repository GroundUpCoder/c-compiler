# 0164 — Recycle Bin e2e was a brittle hardcode, not a product regression

`tests/kernel/test_recycle_e2e.js` was failing 6 checks deterministically on
clean `main` — all in the Recycle Bin desktop-icon path (the bin's own
OPEN/EMPTY menu, double-click → fileman-at-store, and the empty↔full glyph
pixels). The reported evidence looked like "wm.c no longer recognizes the
bin": a generic `120x116` icon menu instead of the bin's `120x56`, a stray
`term` window on the bin double-click, and the glyph rendering full while the
store was empty.

## What it actually was

Not a product bug. The Recycle Bin feature works perfectly. The test
hardcoded the bin at desktop **row 7** (`wmctl click 58 494`, glyph pixels at
`(58,482)`/`(58,474)`), which was right when the seeded desktop had **7**
launchers + the tail-pinned bin (entcmp, 0093) = 8 icons → bin at `k=7`,
row 7.

Commit `785eca2` ("os: add Notepad desktop icon") seeded an **8th** launcher.
The grid is column-major with 11 rows/column, so 8 launchers + bin = 9 icons
→ bin at `k=8`, **row 8** (`y≈558`). The hardcoded `y=494` now landed on the
`term` icon (row 7, sorted `…quake term [Recycle Bin]`) — hence the generic
menu, the stray `term` window, and the wrong pixels. Nothing in wm.c or
fileops.h changed.

Proof: copying the test and shifting only the bin's row-7 coords by +64 (one
cell) made all 6 checks pass with zero product change.

## The fix (test-first hardening)

Per the repo's own rule — *derive geometry from live state, never constants*
(CLAUDE.md says exactly this for browser screen geometry) — both recycle
suites now compute the bin's row at runtime instead of hardcoding it, so a
future seed-icon addition can't silently re-break them:

- **Kernel e2e**: `BINROW=$(( $(ls /root/Desktop | wc -l) - 1 ))` computed in
  the base state (launchers + bin, before the transient `junk.txt`),
  `BINY=16+BINROW*64+30` for the clicks/dblclick, and an echoed `==binrow`
  marker the JS glyph-pixel math reads (cell top `16+row*64`, center `+18`,
  rim `+10`).
- **Browser sweep** (`os-recycle.mjs`, which had the *same* row-7/row-8
  hardcode and was silently broken too — it's manual, so not in CI): reads the
  count off the VT1 shell and derives `binRow`/`cellTop`/`rimY`/`cenY`/`clkY`;
  after Restore the bin drops to `binRow+1`. Gotcha: the count echo must
  split-quote its end marker (`-EN""D`, the 0089 trap) or `waitOut` fires on
  the typed-line echo before the number prints.

## Gotcha for the future

Adding a desktop icon to `os/image.json`'s `user` section shifts the
tail-pinned Recycle Bin down a row. That used to be a landmine for any test
that probes the bin by pixel/coord; both suites are now count-derived, so the
landmine is defused. Verdict: `node tests/kernel/test_recycle_e2e.js` PASS
(derives row 8 today), `node tests/browser/os-recycle.mjs` PASS on the real
compositor.
