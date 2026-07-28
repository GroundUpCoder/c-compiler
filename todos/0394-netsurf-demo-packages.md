# 0394 — NetSurf D: gucman-installable packages for the more involved demos + corpus showcase pages, browsable in-OS

- **Status**: open
- **Priority**: 2
- **Difficulty**: medium
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **D**).
- **Provenance**: 🔴 **jku EXPLICITLY ASKED FOR THIS** (2026-07-28, second turn): *"add the more
  involved demos as installable packages so it's easy to check them from within gucOS itself."*
  Router `019fa6e2` → meta-gucos `019fa6e6` → filed by master cont-130.

## Goal
Make the heavier NetSurf demos and the corpus showcase pages **installable through gucman** and
**browsable from inside gucOS**, so the capability can be checked in-OS rather than by reading a
test log.

## What exists today
`packages/netsurf-demos.json` ships **7 small demos** — `counter`, `events`, `hello-js`,
`paint`, `sketch`, `stopwatch`, `todo` — as editable copies under
`~/Desktop/Presentations/samples/Web Demos/`.

⚠️ **Verify that shape before changing it** — it is the pattern to follow, not to replace.

## Plan
1. Ship the **more involved** demos (the ones not in the current 7) as installable package(s).
2. Ship the **corpus showcase pages** — **Acid1 / Acid2** (from `0389`) plus a heavier
   real-page set — the same way.
3. Keep the **same self-contained-folder shape** as `packages/netsurf-demos.json`. One package
   or several is a judgement call; state which you chose and why.

## Acceptance
- The packages **install via gucman** and the pages are **browsable in-OS**, demonstrated — not
  asserted.
- Same self-contained-folder shape as the existing demos package; no new bespoke mechanism.
- Acid1/Acid2 are reachable in-OS as showcase pages.
- ⭐ This is the one item on the NetSurf list with a **user-visible** deliverable — it is a
  quick win jku asked for directly, which is why it is P2 rather than P3.
- `todos/LIABILITIES.md` re-anchored or retired in the same commit.
