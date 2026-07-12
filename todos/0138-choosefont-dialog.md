# 0138 — comdlg32 ChooseFont dialog (notepad Format → Font)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WIN32.md` (comdlg32 status — `ChooseFont/PrintDlg/
  PageSetupDlg as honest cancels`, 0048 thread). Sibling of umbrella 0133,
  not a blocker (comdlg32/gdi32, not the EDIT control).

## Goal

Format → Font in notepad opens nothing: `ChooseFontW` (`os/win32/
comdlg32.c`) returns `FALSE` (an honest cancel), so the app keeps its single
image font. `DIALOG_SelectFont` in `vendor/notepad/dialog.c` is otherwise
complete — it calls `ChooseFont` and applies the returned `LOGFONT` via
`CreateFontIndirect` (which is real in gdi32). This makes the picker real.

**Reality check first (do this before scoping the UI):** gucOS ships one
freetype face (`/etc/fonts/mono.ttf` + the baked fallback). A font *picker*
is only meaningful to the degree the EDIT/gdi32 stack can actually render a
chosen family/size/style. Decide the honest v1: at minimum a working
size/bold picker over the one family (real value — notepad's font size
matters); enumerate additional families only if/when more faces are baked.
Do NOT ship a picker whose selections don't change rendering.

## Plan

- Implement `ChooseFontW` as a real modal `#32770` dialog (the MessageBox /
  template-dialog host already exists): family list (from whatever faces are
  actually available), size list, bold/italic, and a preview string, filling
  the caller's `CHOOSEFONT`/`LOGFONT` on OK.
- Confirm gdi32 `CreateFontIndirect` + the freetype text path honour the
  returned size/weight so notepad's edit area visibly changes; if the EDIT
  control can't yet vary metrics per-control, scope that seam explicitly
  (may fold a small gdi32/EDIT change in, or note it as a follow-up).
- Persist notepad's chosen font the way it already does (settings.c /
  registry) so it survives relaunch.

## Acceptance

- e2e: `ChooseFontW` opens, a selection returns a populated `LOGFONT`, and
  a driven notepad reflects at least the chosen size (agent-visible via the
  edit metrics or a pixel leg).
- Manual: Format → Font opens a usable dialog and changes the editor font.
- Honest scope recorded in-item: exactly which font attributes are live vs
  deferred, with any deferral pointed at an owning note.
