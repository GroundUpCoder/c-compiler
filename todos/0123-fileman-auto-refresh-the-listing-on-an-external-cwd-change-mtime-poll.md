# 0123 — fileman: auto-refresh the listing on an external cwd change (mtime poll)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WIN32.md`. The one explicitly-*optional* half of 0106
  left unbuilt: 0106 landed manual F5/refresh (and refresh-after-every-op),
  but not the "unprompted" auto-refresh. Low priority — F5 already covers
  the need; this is a polish tick.

## Goal

fileman's listing goes stale when a file is created/removed in the cwd by
another process; today only F5 (or a mutating op) re-lists. Make external
changes appear without a keystroke.

## Plan

- Piggyback the existing 500ms reap `WM_TIMER` (todos/0048): stat the cwd
  each tick and re-`refill()` only when `st_mtime` (or `st_size`/`st_nlink`)
  changed since the last listing — cheap, no readdir on the steady state.
- Preserve the selection/caret across the auto-refill where the names still
  exist (0106's set is index-based, so a bare refill resets it — carry the
  marked *names* over, re-mark by name after the rebuild).

## Non-goals

- inotify-style push (no such kernel facility); a coarse poll is enough.

## Acceptance

- Headless (a `test_fileman_nav_e2e` leg): `touch` a file in the cwd with
  NO F5 — within ~1s the row appears; a multi-selection of surviving rows
  is still marked after the auto-refill.
