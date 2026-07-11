# 0133 — user32 EDIT control → real multiline editor (notepad completeness)

- **Status**: open
- **Design**: `todos/WIN32.md` (the user32 EDIT status thread — 0048 landed
  the around-a-file tail, 0090/0091 the clipboard + context menu). This is
  the umbrella that tracks closing the remaining EDIT-control gaps a
  dogfooded notepad exposes.

## Goal

Dogfooding notepad (2026-07-12) surfaced that our multiline EDIT control
(`edit_proc` in `os/win32/user32.c`) is a *minimal* implementation — draw +
caret + selection + the `EM_*` around-a-file tail — and several standard
plain-EDIT behaviours are absent. Notepad itself is faithful to real
ReactOS notepad: it delegates all of these to the EDIT control and adds no
code of its own, so every gap below is a **veneer** gap, not a notepad gap.
Fixing them in the shared control benefits every EDIT consumer (notepad,
fileman's path/rename boxes, ctldemo, any future text app).

This item is the tracking/verification umbrella — it closes when the four
child items land and notepad drives clean end-to-end. It does not itself
carry code.

## The gap assessment (2026-07-12)

Confirmed by tracing each behaviour through `edit_proc`
(`os/win32/user32.c`), cross-checked against `vendor/notepad/`:

1. **Mouse wheel** — `edit_proc` has no `WM_MOUSEWHEEL` case; the event is
   correctly produced by every layer (os.html → compositor → kernel ring →
   SDL veneer → user32 message loop posts `WM_MOUSEWHEEL` to the EDIT HWND)
   and then dropped. LISTBOX already handles it (`lb_proc`) — the precedent
   exists. → **0134** (light).
2. **Undo** — `EM_CANUNDO`/`EM_UNDO` hard-return `FALSE`,
   `EM_EMPTYUNDOBUFFER` is a no-op, `EM_REPLACESEL`'s undoable flag is
   ignored, and the context-menu "Undo" is permanently grayed. There is no
   undo state in `EditState` at all. Notepad's `DIALOG_EditUndo` is a bare
   `SendMessage(hEdit, EM_UNDO, …)`, so it works verbatim once the control
   grows a buffer. (Redo is *correctly* absent — plain Win32 EDIT never had
   it; that's a RichEdit `EM_REDO` feature and no corpus app uses RichEdit.)
   → **0135** (medium).
3. **Interactive scrollbars** — the control requests `WS_VSCROLL`/
   `WS_HSCROLL` but `edit_proc` handles no `WM_VSCROLL`/`WM_HSCROLL` and
   never calls `SetScrollInfo`; scrolling is caret-driven only. You cannot
   click or drag a scrollbar to move through a long document. → **0136**
   (medium).
4. **Word wrap + horizontal scroll rendering** — notepad's Word-Wrap toggle
   recreates the EDIT with `EDIT_STYLE_WRAP`, but the control has no wrap
   logic (lines split on `'\n'` only) so long lines run off the right edge
   and clip; and in the wrap-OFF case a multiline EDIT can't horizontally
   scroll either (`scrollX` applies to single-line only), so long lines are
   still unreachable. → **0137** (heavy, soft-after 0136).

### Notepad-facing gaps OUTSIDE the EDIT control (sibling items, not blockers)

These are comdlg32/gdi32 veneer stubs, tracked separately so this umbrella
stays scoped to the EDIT control:

- **Format → Font** — `ChooseFontW` returns `FALSE` (honest cancel); the
  font picker never opens. → **0138** (medium).
- **Printing / Page Setup / Print Preview** — `PrintDlgW`/`PageSetupDlgW`
  return `FALSE` and the `StartDoc` family fails loud; File → Print does
  nothing. Needs a whole print target, so it's background. → **0139**
  (heavy, P3).

### Known limitations left unscheduled (documented, not owned by an item)

- **Save As encoding combo** (ANSI/UTF-8/UTF-16) is inert because OFN hook/
  template callbacks aren't run (0048 scope, noted in
  `vendor/notepad/README.md`). Low impact; revisit only if a corpus app
  needs custom OFN templates. Fold into 0138/0139 if convenient there.

## Plan

- Land 0134–0137 (the four EDIT-control children).
- When they're in, drive notepad manually + via `wmctl`: wheel-scroll a long
  file, Ctrl+Z after edits (menu un-grays), drag both scrollbars, toggle
  Word Wrap and confirm long lines wrap / that wrap-off scrolls horizontally.
- Update the `todos/WIN32.md` EDIT-status thread with the completed behaviour
  and drop this umbrella's residue notes (font/printing/encoding) into their
  owning items.

## Acceptance

- 0134, 0135, 0136, 0137 are in `todos/done/`.
- A notepad dogfood pass (headless `wmctl` + a browser `os-*.mjs` leg where
  it adds signal) shows wheel scroll, working Undo, draggable scrollbars, and
  a functional Word Wrap toggle — no regressions in the existing
  `test_user32_e2e.js` / notepad legs.
- `todos/WIN32.md` reflects the new EDIT-control state.
