# 0371 — Rebuild the software manager on the real ListView (THE consumer of 0370)

- **Status**: open
- **Difficulty**: medium (≈1–1.5 lane-days for the rebuild + ≈1 for tests/e2e)
- **Blocked by**: `0370` (hard — the control and its agent seam must exist)
- **Design**: `todos/SOFTWARE-NATIVE.md` on `origin/design-software-win32`
  @ `487f8b70`. **Read it in full before scoping.**
- **Provenance**: jku, 2026-07-28 — redesign the software manager to look
  native win32; the Fable design pass confirmed Reading A (**idiom, not
  substrate**) *by verification, not assumption*: `os/image.json` seeds exactly
  one `/usr/bin/software` and gucman is CLI-only by locked contract, so
  Reading B collapses.

## Goal

`os/win32/software.c` (972 lines) renders the package catalogue as a
**storefront of `PkgCard` HWNDs**. Replace the presentation layer with a real
`SysListView32` report view (name / version / state / size columns,
sort-by-column, selection-driven actions) so the app reads as a native Windows
utility.

The **model and job engine survive verbatim** — roughly 350 UI lines are
replaced by ~400. This is a presentation change, not an engine change.

## Locked contracts that MUST survive (from `software.c`'s header comment)

Every one of these is a hard contract; a rebuild that breaks any of them is a
failed rebuild, not a trade-off:

- **gucman IS the engine** — no payload fetching, no `/opt` writes, no
  duplicated install logic in the app.
- Install state comes from the `/var/lib/gucman/<name>.json` DB.
- The `FS_WATCH` liveness behaviour is preserved.
- **One job at a time.**
- **No synthesized "installed" claims.**
- **Offline still lists the installed set.**

## Plan

1. Land `0370` first. Do not start on a stubbed control.
2. Replace the `PkgCard` storefront with a `SysListView32` report view.
3. Rewire actions to selection instead of per-card buttons.
4. Update `tests/browser/test_software_e2e.js` — ⭐ its
   `punesBtn = 2 + sortedIndex` ordinal arithmetic **should disappear**, since
   `0370`'s `AQM_FINDLABEL` lets a row be addressed by name. If that arithmetic
   survives the rebuild, the `0370` seam did not do its job — say so rather
   than papering over it.
5. os-minimal leg + flake gate + image bump (master assigns the version).

## Out of scope

**No keeping the card storefront as an alternate view** — no zombie fallbacks.
No gucman/engine changes. No progress control unless
`msctls_progress32` has landed by then (today's status-line STATIC fed by
tailing gucman's output stays until it does).

## Acceptance

- The software manager presents as a columned report view; sort-by-column
  works; actions are selection-driven.
- **Every locked contract above still holds** — demonstrated, not asserted.
- **Every existing `test_software_e2e.js` leg still passes, ideally with its
  ordinal arithmetic deleted in favour of by-name addressing.** Every package
  and every action remains `wmctl`-addressable.
- Kernel + sweep green; image bumped (master assigns).
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
