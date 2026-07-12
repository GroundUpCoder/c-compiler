# 0135 — EDIT control undo buffer (EM_UNDO / EM_CANUNDO)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WIN32.md` (EDIT status — the "no-undo honesty" note at
  the 0048/0091 threads is what this item retires). Umbrella 0133.

## Goal

Ctrl+Z does nothing in notepad and the Edit → Undo / context-menu Undo item
is permanently grayed. Cause: the EDIT control has no undo state —
`EM_CANUNDO`/`EM_UNDO` hard-return `FALSE`, `EM_EMPTYUNDOBUFFER` is a no-op,
and `EM_REPLACESEL` ignores its undoable-flag `wParam` (all in `edit_proc`,
`os/win32/user32.c`; `EditState` has no undo field). Notepad and the 0091
context menu are already correct — `DIALOG_EditUndo` is a bare
`SendMessage(hEdit, EM_UNDO, …)` and the menu gates on `EM_CANUNDO` — so
they light up for free once the control tracks edits.

Redo is explicitly out of scope and correct to omit: plain Win32 EDIT has no
redo (it's a RichEdit `EM_REDO` feature) and no corpus app uses RichEdit.

## Plan

- Give `EditState` a single-level undo record — the Win95 plain-EDIT model
  (ONE undo step, not a stack): capture the pre-edit text span + selection
  and the inverse op (type = insert/delete/replace) at each mutating edit.
  The single-level model keeps memory bounded and matches the reference
  control; a multi-level stack is a deliberate non-goal for v1.
- Populate it at every user edit path in `edit_proc`: WM_CHAR insert,
  Backspace/Delete, WM_PASTE/WM_CUT/WM_CLEAR, and `EM_REPLACESEL` **when its
  `wParam` (can-undo) is true** (programmatic `EM_SETTEXT`/handle swaps clear
  it, per Windows).
- Implement `EM_CANUNDO` (true iff a record exists), `EM_UNDO` (apply the
  inverse, then store the inverse-of-inverse so a second Ctrl+Z redoes the
  undo — Windows' undo/undo toggle), and make `EM_EMPTYUNDOBUFFER` /
  `EM_SETHANDLE` / `WM_SETTEXT` actually clear the record.
- Un-gray the context-menu Undo (the 0091 menu already reads `EM_CANUNDO`;
  just confirm it flips) and confirm the ^Z chord in the control routes to
  the same path.

## Acceptance

- `test_user32_e2e.js` (or a focused EDIT e2e): type, `EM_CANUNDO` → true;
  `EM_UNDO` restores the prior text+selection; a second `EM_UNDO` re-applies
  (undo/undo toggle); `EM_EMPTYUNDOBUFFER` and a programmatic set clear the
  record. `EM_REPLACESEL` with can-undo=false leaves nothing to undo.
- Manual: in notepad, edit → Ctrl+Z reverts and the Edit menu / right-click
  Undo item is enabled after an edit, grayed after undo-to-clean.
- No regression in existing notepad / context-menu legs.
