# 0395 — NetSurf E: W3C CSS2.1 reftest suite as its OWN lane — visual/reftest, needs a golden-image harness

- **Status**: open
- **Priority**: 3
- **Difficulty**: heavy
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **A4/E**).
- **Provenance**: jku human-origin 2026-07-28 → router `019fa6e2` → meta-gucos `019fa6e6` →
  filed by master cont-130.
- **Siblings**: `0389`/`0390`/`0391` are the headless corpus gates. 🔴 **This is deliberately
  NOT bundled with them.**

## Goal
Run the **W3C CSS2.1 reftest suite** (**~9,000 tests**) — *the* corpus for the CSS level we
claim — as its **own lane**.

## Why it is separate, and P3
The A-stream gates are headless and machine-checkable against the existing monkey/node harness.
This one is **reftest/visual**: it needs a **golden-image harness** that does not exist yet.
That is a different kind of engineering with a different failure mode (flaky pixels, font
rendering, antialiasing), and folding it into `0390` would contaminate a cheap, reliable
engine-level number with an expensive, fragile visual one.

⭐ Its cost is dominated by the **harness**, not the corpus.

## Plan
1. Scope the golden-image harness first — capture, compare, tolerance policy, how goldens are
   baked and re-baked, and who is allowed to re-bake them.
   🔴 **Goldens rebaked blind is a known root miss on this codebase** — a re-bake that is not
   reviewed launders a regression into the baseline.
2. Only then decide how much of the ~9k suite to run.

## Acceptance
- 🔴 **The scope is stated as its OWN bound, in numbers** — ran N of ~9,000, skipped K, why.
  **CORE PRINCIPLE: no "ran 200 of 6000 and called it done."** With a corpus this size the
  temptation is maximal; a bare percentage is not acceptable.
- A golden-image harness with an explicit, written **re-bake policy**.
- Pixel-flake is distinguished from real failure, and the distinction is demonstrated.
- ⚠️ Do **not** let this lane's results silently restate `0390`'s CSS number — they measure
  different things and must be reported separately.
- `todos/LIABILITIES.md` re-anchored or retired in the same commit.
