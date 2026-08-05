# #515 — bake Noto Sans Symbols (1): U+2303 ⌃, the sixth Mac modifier glyph

Follow-up to #435, authorised by jku's 2026-08-05 ruling ("Add symbol 1").
#435 baked Noto Sans Symbols 2 and measured that it does not map U+2303 —
that glyph lives in Noto Sans Symbols (1), a separate family the original
ruling conflated. This ticket appends that family to the baked fallback
chain #435 created. Strictly additive: one vendored TTF, one manifest bin
entry, one list line.

## Measurements (all carried figures re-measured on this tree)

- Symbols 2 cmap (vendored file at `5d628291`): 2318→1012, 2325→1011,
  21E7→104, 232B→1007, 23CE→1013, **2303→0**. Matches #435's report.
- Symbols (1) (`notofonts.github.io` hinted/ttf, fetched 2026-08-05,
  226,980 B, 846 glyphs, upem 1000, glyf outlines): **2303→265**, and
  glyph 0 for ALL FIVE of Symbols 2's modifiers. The two families are
  exactly complementary — chain order carries no coverage ambiguity, and
  each face is load-bearing for its own glyphs.
- U+0378/U+0379 are glyph 0 in Symbols (1) too, so the test's vacuity
  controls survive the append unchanged.
- The OFL from the source repo (`notofonts/symbols` hosts both families)
  is byte-identical to `OFL-NotoSansSymbols2.txt`; vendored alongside as
  `OFL-NotoSansSymbols.txt` anyway — one licence file per face, the #435
  convention.
- Built minimal image: 16,477,296 B at `5d628291` → 16,721,304 B with
  #515 = **+244,008 B** (the 226,980 B TTF plus block overhead).
  Cloudflare cap 26,214,400 B ⇒ **9,493,096 B headroom**.

## The true-comment-turned-false sweep

#435 deliberately recorded "U+2303 is NOT covered" in three places; all
three went false the moment this landed and all three were corrected:
the `vendor/fonts/README.md` Symbols 2 row (+ the closing baked-faces
paragraph), the baked fallback-list comment inside `os/image.json`, and
the `test_symbolfont_e2e.js` header (fixed in the red-control commit,
where the test grew the U+2303 legs). `os/os-common.js`'s "the base
image bakes ONE chain face" note was the fourth casualty — now names
both faces. The #435 dev log keeps its original wording: a journal
records what was true at the time.

## Red control

Test-first per the #97 standard: `cb438971` extends the e2e (test file
only — the test was already registered in `tests/kernel/run.js`, so
kernel membership stays 164) and is measured RED on the unfixed tree in
exactly the predicted shape: symbols.ttf absent, no list line, notepad's
gdi32 report names U+2303 instead of U+0378, and the ⌃ term cell is
byte-identical to the tofu box, while every #435 leg stays green. The
fix commit turns all five legs green with zero test edits.
