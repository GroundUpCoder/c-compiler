# 0391 — NetSurf A3: test262 subset vs Duktape 2.7.0 — a measured ES level

- **Status**: open
- **Priority**: 2
- **Difficulty**: heavy
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **A3**).
- **Provenance**: jku human-origin 2026-07-28 → router `019fa6e2` → meta-gucos `019fa6e6` →
  filed by master cont-130.
- **Cross-refs**: `0290`, `0317`. Siblings: `0389` (A1), `0390` (A2).

## Goal
Replace **"ES5.1 we think"** with a measured ES level. Run a **test262 subset** against
**Duktape 2.7.0** (the engine NetSurf's JS rides on here).

⭐ **Duktape upstream already runs test262** — lean on its existing harness/known-fails rather
than inventing a runner. Check what upstream provides before building anything.

## Plan
1. Determine what Duktape 2.7.0 upstream already ships for test262 and reuse it.
2. Pull test262 at a **pinned** revision; record the rev in the ticket and in `UPSTREAM.json`
   style so the number is reproducible.
3. Define the subset **deliberately and in writing** — which chapters/features, and why.
4. Report **PASS/FAIL counts** and translate them into a defensible ES-level statement.

## Acceptance
- A **measured ES level**, expressed as counts, not an adjective.
- The **test262 revision is pinned and recorded** — an unpinned corpus makes the number
  unreproducible.
- 🔴 **CORE PRINCIPLE — this ticket is the single most likely place for the
  "ran 200 of 6000 and called it done" failure.** test262 is enormous; a subset is EXPECTED and
  legitimate — **but the subset must be named, justified, and its size stated LOUDLY IN
  NUMBERS** (ran N of M, skipped K, why). A bare pass-rate over an unnamed subset is not an
  acceptable deliverable.
- Distinguish **engine** failures from **harness/binding** failures — a test that fails because
  a NetSurf binding is a no-op is a `0392` finding, not an ES-level finding.
- `todos/LIABILITIES.md` re-anchored or retired in the same commit.
