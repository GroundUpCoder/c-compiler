# 0389 — NetSurf A1: html5lib-tests tokenizer + tree-construction conformance vs libhubbub, plus Acid1/Acid2 headline

- **Status**: open
- **Priority**: 2
- **Difficulty**: heavy
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **A1**), companion
  `~/git/meta/notes/netsurf-corpus-kickoff.md`.
- **Provenance**: jku human-origin 2026-07-28 → meta-meta router `019fa6e2` → meta-gucos
  coordinator `019fa6e6` → filed by master cont-130.
- **Cross-refs**: `0290` (Lane D binding fills), `0317`. 🔴 **Do NOT duplicate them.**

## Goal
Turn "NetSurf parses HTML5" from reputation into **a number**. Run the upstream
**html5lib-tests** corpus — the JSON **tokenizer** tests and the **tree-construction** tests —
against our vendored **libhubbub**, and report a real HTML5-parse conformance figure.

Fold **Acid1 / Acid2** in here as a cheap **two-page headline signal** (upstream NetSurf passes
both) — they are a headline, not the measurement.

## Why the data isn't already here
Re-pulling test data means fetching upstream **at the revisions already pinned in
`vendor/netsurf/UPSTREAM.json`** — this is not a version bump. The reason it is absent is that
`vendor/netsurf/update.sh` currently **`rm -rf`s `test/`, `tests/` and `docs/`** (lines 83, 95,
97), so the corpus was never vendored in the first place. Fix that seam rather than
hand-copying files in.

## Plan
1. Stop `update.sh` from deleting the corpus for libhubbub (keep the pinned rev; do not bump).
2. Wire a headless, machine-checkable runner in the **existing monkey/node harness shape** —
   this is the same class of gate as the other corpus suites, not a bespoke script.
3. Run tokenizer + tree-construction; emit **per-corpus PASS/FAIL counts**.
4. Add Acid1/Acid2 as two pages with a pass/fail line each.

## Acceptance
- The gate is **runnable and wired**, not a one-off invocation.
- 🔴 **Reports PASS/FAIL COUNTS per corpus.** A result without a NUMBER is NOT A RESULT.
- 🔴 **CORE PRINCIPLE — no "ran 200 of 6000 and called it done."** If coverage is bounded (a
  subset, a skipped category, an unsupported feature class), **the bound is stated LOUDLY IN
  NUMBERS** in the output and in this ticket. A silent truncation reads as "we covered
  everything" when we did not.
- Acid1/Acid2 each report an explicit pass/fail.
- Additive only: new test data + harness under `vendor/netsurf`. **No `kernel.js` / VT2 risk.**
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or retire an
  anchored line in the same commit.
