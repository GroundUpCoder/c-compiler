# 0390 — NetSurf A2: libcss upstream test/data parse+select conformance (engine-level, no pixels)

- **Status**: open
- **Priority**: 2
- **Difficulty**: medium
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **A2**).
- **Provenance**: jku human-origin 2026-07-28 → router `019fa6e2` → meta-gucos `019fa6e6` →
  filed by master cont-130.
- **Cross-refs**: `0290`, `0317`. Sibling corpus gates: `0389` (A1), `0391` (A3).

## Goal
Turn **"CSS 2.1 + selected CSS3"** from a reputation claim into **a measurement**. Run
**libcss's own upstream `test/data`** — the **parse** and **select** suites — against our
vendored libcss.

⭐ **This is engine-level and produces NO pixels.** That is exactly why it is cheap and belongs
here rather than in the reftest lane. The visual W3C CSS2.1 reftest suite is a **separate P3
lane** (`0395`) — 🔴 **do not bundle them.**

## Why the data isn't already here
Same seam as `0389`: fetch upstream **at the rev already pinned in
`vendor/netsurf/UPSTREAM.json`** (not a bump). `vendor/netsurf/update.sh` **`rm -rf`s
`test/`/`tests/`/`docs/`** (lines 83/95/97), so the data was never vendored.

## Plan
1. Preserve libcss's `test/data` through `update.sh` at the pinned rev.
2. Wire parse + select runners into the headless monkey/node harness shape.
3. Emit **per-suite PASS/FAIL counts**.

## Acceptance
- Gate runnable + wired; **per-suite PASS/FAIL COUNTS** reported.
- 🔴 **CORE PRINCIPLE — no "ran 200 of 6000 and called it done."** Any coverage bound —
  skipped categories, unsupported at-rules, selector levels not exercised — is **stated LOUDLY
  IN NUMBERS**, in the output and in this ticket.
- The resulting number is what replaces the prose CSS claim in `0392`'s support statement.
- Additive only; no kernel/VT2 risk.
- `todos/LIABILITIES.md` re-anchored or retired in the same commit.
