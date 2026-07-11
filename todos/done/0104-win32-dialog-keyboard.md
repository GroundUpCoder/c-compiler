# 0104 — user32 dialog keyboard: Tab order, mnemonics, default button

- **Status**: DONE (2026-07-11). IsDialogMessageW became the real dialog
  manager — Tab/Shift+Tab (GetNextDlgTabItem), Alt+mnemonic, Enter=default
  button, Esc=IDCANCEL, radio-group arrows (GetNextDlgGroupItem), all over a
  new WM_GETDLGCODE across the standard controls, wired into both modal loops
  (DialogBoxParamW + MessageBox) + DefDlgProc DM_GETDEFID/SETDEFID/
  WM_NEXTDLGCTL. Mnemonic-underline + default-button-outline rendering,
  LISTBOX PageUp/Down. Acceptance surface: os/win32/ctldemo.rc → ctldemo.res
  (Options template dialog). Tests: test_user32_e2e.js session B (kernel
  INJECT_KEY path) + MessageBox leg + os-user32.mjs browser leg (page
  keyboard, operator-run); winmine e2e stays green. comdlg32's WCFileDlg
  (Save As/Open) + WCFindDlg (Find/Replace) — bespoke, NOT #32770 — got
  WS_TABSTOP + a default button + loop wiring, so notepad's Save As is fully
  keyboard-driven end to end (test_notepad_e2e.js keyboard leg: type name +
  Enter default → file written). Image v63→v64. Dev log
  logs/2026-07-11/0104-dialog-keyboard.md. No follow-ups filed — full
  Acceptance (Tab order, mnemonics, default button, Esc, notepad Save As,
  winmine stays green) satisfied; the radio-group "Tab-enters-at-checked-
  member" refinement is punted per the item's "keep v1 simple" note (no
  radio-group dialog exists in the corpus; arrows-within-group DID land).
- **Design**: `todos/WIN32.md` (USER32 surface). Filed by the 0076 parity
  sweep; this is the 0058 descope ("no Tab-order navigation
  (IsDialogMessage)" — user32.c's own header) coming due, plus the two
  keyboard affordances that make dialogs feel native.

## Goal

Dialogs are mouse/agent-only today: `IsDialogMessageW` handles exactly
VK_ESCAPE, the modal `DialogBoxParamW` loop doesn't even call it, Tab
does nothing, Enter doesn't press the default button, and `&`
mnemonics are stripped for agent matching but never rendered underlined
or matched against Alt+letter (0076 survey; the 0073 sweep flags the
same). Every port with a dialog (notepad Save As, calc, winmine custom
board) is keyboard-dead. Standard Win95 dialog keyboard: Tab/Shift+Tab
walk WS_TABSTOP controls, Alt+mnemonic jumps/presses, Enter = default
pushbutton, Esc = IDCANCEL.

## Plan

- **Tab order** — implement `GetNextDlgTabItem` (child walk in creation
  order, WS_TABSTOP + visible + enabled, wrap) and make
  `IsDialogMessageW` translate VK_TAB → SetFocus(next/prev). Radio
  groups: Tab enters the group at the checked member; arrows move
  within (WS_GROUP walk) — keep v1 simple, record what's punted.
- **Default button** — track DM_SETDEFID / BS_DEFPUSHBUTTON per dialog;
  VK_RETURN presses it (WM_COMMAND with its id) unless focus sits on a
  button (then that button) or a multiline EDIT (then newline). Esc →
  IDCANCEL (keep the existing WM_CLOSE mapping as the fallback).
- **Mnemonics** — Alt+letter matches the `&`-marked char of a control
  label (buttons: press; STATIC: focus the next control — the Win32
  rule); render the mnemonic underlined in BUTTON/STATIC paint (the
  `strip_amp` seam already finds the char; gdi32 text can underline the
  one glyph with a 1px line).
- **Wire the modal loop** — `DialogBoxParamW`'s internal pump calls
  IsDialogMessageW first (the fix for Esc-in-modal too); MessageBox
  inherits (it's a "#32770" dialog): Tab cycles its buttons, Enter
  presses the default, Esc = IDCANCEL where present.
- LISTBOX VK_PRIOR/VK_NEXT (PageUp/Down) can ride along — same
  keyboard-parity class, two cases in the existing WM_KEYDOWN switch.

## Acceptance

- Headless (`test_user32_e2e.js` legs): in ctldemo's dialog, injected
  Tab walks the expected control sequence (agent tree shows focus),
  Shift+Tab reverses, Alt+mnemonic presses the labelled button, Enter
  fires the default id, Esc returns IDCANCEL; notepad's Save As dialog
  is fully keyboard-driven end-to-end.
- The 0068 winmine acceptance stays green (its custom-board dialog gains
  Tab/Enter without regressing mouse/agent paths).
