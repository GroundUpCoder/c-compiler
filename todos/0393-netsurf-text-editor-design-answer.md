# 0393 — NetSurf C: text-editor design answer — confirm the walls and spec a gucOS-native file read/write seam, or overturn them with B evidence

- **Status**: open
- **Priority**: 2
- **Difficulty**: medium
- **Blocked by**: `0392` (B) — the walls must be measured before they are designed around.
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **C**).
- **Provenance**: jku human-origin 2026-07-28 ("could we write a custom text editor?") → router
  `019fa6e2` → meta-gucos `019fa6e6` → filed by master cont-130.
- **Cross-ref**: `0290`.

## Goal
🔴 **A WRITTEN DESIGN ANSWER — NOT A TOY.** Do not ship a demo editor. The deliverable is a
document that says what a real gucOS text editor on NetSurf would actually take, or why it is
the wrong artifact.

## The walls, as currently understood
- `getBoundingClientRect` / `offsetLeft`: **confirmed absent** (source-level).
- `querySelector`, canvas vector API, rAF: **confirmed no-op stubs** — but `0392` must confirm
  this at RUNTIME before it is load-bearing for a design.
- 🔴 **There is NO file I/O from JS today** — no `fetch`, no `File`, no storage. So a
  `textarea` editor **could type but could never open or save.** That, not layout, is the
  blocking wall.

## Plan
Take one of two positions, and say which:
1. **Confirm the walls** and spec what a gucOS-**NATIVE** seam would take — either a `file:`
   read/write binding, or an OS-launched editor page with content **injected** by the OS and
   handed back on save. Cost it honestly.
2. **Overturn a wall** with `0392`'s evidence, if the runtime probe contradicts the
   source-level reading — and then re-scope accordingly.

## Acceptance
- A written answer that a reader can act on: **what it would take, or why it is the wrong
  artifact.** Not a prototype, not a screenshot.
- Every wall it relies on is backed by `0392`'s **runtime** verdict, not by symbol presence.
- The proposed seam is specified concretely enough to become a ticket (or is explicitly
  declined with reasons).
- ⭐ **Build to the goal, not to the demo** — "a textarea that types but cannot save" is
  precisely the shortcut this ticket exists to refuse.
- `todos/LIABILITIES.md` re-anchored or retired in the same commit.
