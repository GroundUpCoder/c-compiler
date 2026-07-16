# 0230 — fileman status strip: font-derived height (the 0229 disease, next site)

> **SUPERSEDED same day** — this fix was a shortcut (a private copy of
> height-derivation) and was redone onto comctl32's shared STATUSBAR:
> see [fileman-statusbar-0230-redo.md](fileman-statusbar-0230-redo.md).

Same disease family as [0229](statusbar-font-height-0229.md), different
control and layer: fileman's status strip is a plain STATIC sized by a
hardcoded `STATUS_H 18` (Win95 MS-Sans-Serif arithmetic), and user32's
STATIC paint top-aligns its text with no vertical centering — so the strip
budgeted 18 rows for the 19px stock-font glyph cell.

## The lever: fileman-local, zero blast radius

0230 recorded two candidate levers; the shared one (DT_VCENTER in user32's
STATIC paint) changes every STATIC in the corpus (winmine/calc/ctldemo
labels, multiline STATICs) and would need a full audit. The landed fix is
the other lever: `status_h()` in fileman.c derives the strip height from
`GetTextMetrics` (tmHeight + 2px breathing), with the old 18 kept only as a
fontless fallback, cached after the first successful derivation.
`relayout()` uses it for both the list-area bottom and the strip's
MoveWindow. Nothing outside fileman.c changes — the exact shape of the
0229 mechanism/policy lesson: the app that owns the furniture derives the
furniture's size from the font it will render with.

Strip is now 21px (19px cell + 2) at the stock font; image v106.

## Honest empirical finding: the old geometry was an exact-fit razor edge

The todo said "descenders clip at the strip's bottom edge". Measured
(per-row ink profile of a real shot, old vs new build): with the CURRENT
stock font the deepest descender row ('j', parens in "N object(s)") lands
exactly ON the old strip's last row — rows +4..+17 of an 18-row strip. So
no descender row was visibly lost *today*; the clip was one font-hinting or
size change from visible. The fix is still the honest one (the height must
derive from metrics, not luck), but the test had to encode that reality:
ink touching the clip edge is indistinguishable from a clipped render, so
"unclipped" is only provable as CLEARANCE.

## The red→green leg (tests/kernel/test_fileman_ops_e2e.js)

Shot leg at the top of the ops script (notepad's 0229 parsePpm/maxInkRow
pattern), all geometry anchored on the live STATIC rect from `wmctl tree`
(never a hardcoded 18/21). The tree round-trip doubles as the paint
barrier — the agent socket answers from the GetMessage idle loop, after
any pending WM_PAINT. Three checks:

- height >= 21 (the 0229-style geometry pin; old 18 → FAIL),
- 'j' ink reaches >=3 rows below the 'ect' x-height glyphs (descenders
  really render; column windows from the 8px-advance mono cell),
- the descender bottom clears the strip's clip edge by >=2 rows (the
  pixel half of the red→green: old geometry had 0 clearance → FAIL).

Verified both ways: old fileman.c + new leg = 2 FAIL; fixed = suite PASS,
and stable 3/3 under `--repeat 3 --under-load`.
