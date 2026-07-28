# 0372 — Migrate fileman's space-padded details columns (and comdlg32's file list) onto SysListView32 — the proof of generality

- **Status**: open
- **Priority**: P2
- **Difficulty**: medium
- **Blocked by**: `0370` (hard)
- **Design**: `todos/SOFTWARE-NATIVE.md` — **NOW IN `main`** (merged by master cont-123 as
  `cf939313`; `487f8b70` verified an ancestor of main), section "Follow-on, soft".
  ⚠️ The old pointer to `origin/design-software-win32 @ 487f8b70` is **stale** — read the
  `main` copy, which is the one that absorbs later corrections.

## Goal

Retire the pre-`0370` approximations now that a real report view exists:

1. **fileman (`0106`, shipped)** — its details columns are `%-28s %10s %s`
   space-padding into a mono LISTBOX. Its own comment admits the workaround
   ("LB_SETTABSTOPS-free"). It works **only because the font is mono**,
   re-sorts by rebuilding every row string, and its "header" is a menu.
2. **comdlg32's file dialog (`0048`)** — another LISTBOX that would be a report
   view anywhere else. Plausible, not mandatory: judge at pickup whether the
   dialog's fixed geometry earns the migration.

## Why this ticket exists at all

`0370` claims its AQM agent seam is cut at the **user32↔control** boundary and
is therefore generic — that a second consumer, and later a `SysTreeView32`,
inherit drivability without touching user32 again. **That claim is untested
until a consumer that was not designed alongside the control adopts it.** This
ticket is that test. If migrating fileman requires reopening user32's seam, the
generality claim in `0370` was false and should be corrected in writing there,
not quietly worked around here.

## Also owed at pickup — an annotation, not a migration

⭐ **`0130` Default Programs** (re-opened 2026-07-27 by jku's cmdalt ruling) has
a *written plan* that says **"a LISTBOX of"** key→command pairs — two-column
data about to become the fifth padded-string hack. **Annotate `0130` so
whoever picks it up builds on `0370`'s control instead of its written plan.**
Do that annotation as soon as `0370` lands; it does not wait on this ticket.

## Acceptance

- fileman's details view is a real `SysListView32`; the `%-28s %10s %s`
  padding and the menu-as-header are **deleted**, not left as a fallback.
- Sorting is column-driven rather than row-string rebuilding; correctness no
  longer depends on a mono font.
- Every existing fileman e2e leg still passes, and rows are addressable by
  name.
- **The generality verdict is written down** either way: did `0370`'s seam
  suffice unchanged? If not, say exactly what it lacked.
- Image bump (master assigns); kernel + sweep green.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
