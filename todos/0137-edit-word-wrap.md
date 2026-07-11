# 0137 — EDIT control word-wrap + horizontal-scroll rendering

- **Status**: open
- **Design**: `todos/WIN32.md` (EDIT status). Umbrella 0133. Soft-after 0136
  (interactive scrollbars) — both touch the line/scroll model, and this
  builds on the `scrollX`-honouring multiline draw 0136 lands.

## Goal

The heavy end of the EDIT-completeness set: make long lines behave.
Notepad's Format → Word Wrap toggle recreates the EDIT with
`EDIT_STYLE_WRAP`, but `edit_proc` (`os/win32/user32.c`) has **no wrap
logic** — lines split on `'\n'` only — so with wrap ON long lines are not
wrapped, they run off the right edge and clip. And with wrap OFF a multiline
EDIT still can't scroll horizontally (the draw offset is hard-wired to
`EDIT_PAD` for multiline; `scrollX` only applies to single-line), so long
lines are unreachable either way. Both halves live here.

## Plan

- **Wrap-off horizontal reach** (if not already landed by 0136): honour
  `scrollX` in the multiline draw path and let the caret drive it, so a long
  unwrapped line scrolls into view. Coordinate with 0136 so this seam isn't
  done twice.
- **Word wrap** on `ES_MULTILINE | ES_AUTOVSCROLL`-style wrap mode: introduce
  a *visual line* layer over the logical (`\n`-delimited) lines — compute
  wrap points at the client width (break on whitespace where possible, hard
  break mid-token when a word exceeds the width), and render/caret-navigate/
  hit-test in visual-line space while all `EM_*` line APIs
  (`EM_GETLINECOUNT`/`EM_LINEINDEX`/`EM_LINEFROMCHAR`) keep their
  **logical-line** contract. Recompute on text change and on width change
  (WM_SIZE / TIOCSWINSZ-style reflow via `SetWindowSize`).
- With wrap ON, disable the horizontal scrollbar and suppress `scrollX`
  (Windows behaviour); vertical scroll (0136) now counts *visual* lines.
- Keep it O(text) on edit where feasible (reflow only the affected logical
  paragraph), but correctness first — a full reflow on width change is
  acceptable for v1 given notepad-sized documents.

## Acceptance

- e2e: a line wider than the client area wraps to multiple visual rows with
  wrap ON (caret/hit-test land on the right character); `EM_GETLINECOUNT`
  still reports logical lines; toggling wrap OFF makes the same line one row
  that scrolls horizontally into view.
- Manual: notepad's Format → Word Wrap wraps long lines and back; resizing
  the window reflows; wrap-off long lines scroll horizontally.
- No regression in the caret/selection/scroll (0136) or `EM_*` line-API legs.
