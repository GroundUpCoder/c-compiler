# 0145 — comdlg32 silent no-ops: give feedback or document

- **Status**: open
- **Design**: this file. From the 2026-07-12 notepad menu audit
  (`logs/2026-07-12/queue-hardening-and-keymap.md`). Sibling of the 0073
  apps-sweep, which surfaced the class.

## Goal

Three notepad menu items are **silent no-ops** — the user clicks and nothing
happens, no dialog, no error. They read as "broken" even though the code
"succeeds" (the comdlg32 stub returns FALSE → "user cancelled"):

- **File → Print** (`PrintDlgW` returns FALSE, `os/win32/comdlg32.c:437`)
- **File → Page Setup** (`PageSetupDlgW`, `comdlg32.c:438`)
- **Format → Font** (`ChooseFontW`, `comdlg32.c:436`)

Also from the same audit:

- **File → Save As** opens and saves, but the **Encoding/EOLN comboboxes never
  appear** — the OFN hook/template path (`DIALOG_FileSaveAs_Hook`) is dead code
  (`comdlg32.c:13` header note).
- **About box `\r\n`** renders `\r` as a literal `r` — a STRINGTABLE escape bug
  in `tools/win32rc.js` (STRING_NOTEPAD_AUTHORS).

## Plan

Per item, decide **surface-a-feedback vs formally-document-as-known-issue**
(don't leave silent no-ops):

- Cheapest honest fix: a "not implemented in this build" MessageBox from the
  stub paths, so the click has visible feedback — OR implement a minimal
  ChooseFont (a font-family/size picker over the freetype list). Print/Page
  Setup are the hardest (no print backend) — likely document + feedback.
- Fix the `win32rc.js` `\r` escape (real bug, cheap).
- Save As combos: either wire the OFN template notify protocol (bigger) or
  record it in WIN32.md known-issues with the repro.

## Acceptance

- No notepad menu item is a *silent* no-op — each either works or says why.
- Regression tests (see 0073's audit list): the `\r\n` escape; Save-As tree
  has no COMBOBOX (catches a future hook impl); the feedback path fires.
- WIN32.md known-issues updated for anything deliberately deferred.
