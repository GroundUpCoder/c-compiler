# 0164 — Recycle Bin e2e: derive bin grid row (Notepad icon broke row-7 hardcode)

- **Status**: done
- **Design**: todos/done/0093 (Recycle Bin)

## Goal

`tests/kernel/test_recycle_e2e.js` was failing 6 checks on clean `main`
(the bin's OPEN/EMPTY menu, double-click → fileman-at-store, and the
empty↔full glyph pixels). Investigation showed the Recycle Bin FEATURE is
fine — no wm.c/product regression. The tests hardcoded the bin at desktop
**row 7** (`y=494`, glyph pixels `482`/`474`), which was correct when the
seeded desktop had 7 launchers + the tail-pinned bin. Commit `785eca2`
("add Notepad desktop icon") seeded an 8th launcher, so the bin (entcmp
tail-pin, 0093) now sits at **row 8** and every hardcoded probe missed it —
`y=494` landed on the `term` icon (hence the stray `term`/`File Manager -
/bin` windows and the wrong-menu evidence).

The browser twin `tests/browser/os-recycle.mjs` had the identical
row-7/row-8 hardcode and was silently broken the same way (it is
manual/optional, so not caught in CI).

## Plan

Fix test-first / hardening: derive the bin's row from the LIVE desktop
instead of hardcoding it, per the repo's "derive geometry from live state,
never constants" rule — so a future seed-icon addition can't silently
re-break it.

- Kernel e2e: compute `BINROW=$(( $(ls /root/Desktop | wc -l) - 1 ))` in the
  base state (seeded launchers + bin, no junk), `BINY=16+BINROW*64+30` for
  clicks/dblclick, echo `==binrow` so the JS glyph-pixel math reads the row
  (center `+18`, rim `+10`).
- Browser sweep: read the count off the VT1 shell (split-quote marker so
  `waitOut` fires on the output, not the typed-line echo), compute
  `binRow`/`cellTop`, use `rimY`/`cenY`/`clkY`; after Restore the bin drops to
  `binRow+1`.

## Acceptance

- `node tests/kernel/test_recycle_e2e.js` → PASS (derives row 8 today).
- `node tests/browser/os-recycle.mjs` → PASS on the real compositor.
- No product code touched; both suites become robust to added desktop icons.
