# notepad menu audit — every item exercised, the silent tail made loud (todos/0222)

User-flagged: "I don't think everything works" in notepad's menus. Full
sweep of the real menu tree (24 items, `vendor/notepad/lang/en-US.rc`)
driven agent-side in the booted OS.

## Inventory & verdicts

| Item | Verdict |
|------|---------|
| File: New, New Window, Open..., Save (both paths), Save As..., Exit | PASS |
| File: Page Setup..., Print... | were SILENT no-ops → loud `win32: unsupported` cancels (fixed) |
| Edit: Cut, Copy, Paste, Delete, Select All, Time/Date | PASS |
| Edit: Find..., Find Next, Replace..., Go To... (+ out-of-range box) | PASS |
| Edit: Undo | grayed via EM_CANUNDO once a popup opens (correct); ^Z accelerator was a silent dead key → loud EM_UNDO report (todos/0135 is the real fix) |
| Format: Word Wrap | PASS (checkmark, Go To grays, EDIT re-create keeps the buffer; visual wrap layout itself stays a 0133/0211-remainder gap) |
| Format: Font... | was a SILENT cancel → loud; real dialog filed as todos/0223 (needs WM_SETFONT plumbing through control paint paths — user32 ignores it entirely today) |
| View: Status Bar | PASS (hide/show) |
| Help: View Help | correctly grayed at WM_CREATE (no HTML Help) |
| Help: About Notepad | PASS — exposed the win32rc `\r` bug below |

## Fixes

- **comdlg32.c**: ChooseFontW / PrintDlgW / PageSetupDlgW keep returning
  FALSE (no printing subsystem; no font dialog yet) but now report
  `win32: unsupported ...` once per site — a menu click landing there reads
  as a missing feature, not a dead click (0211 policy).
- **user32.c EDIT WM_SETTEXT**: caret parked at the END of the new text;
  real EDIT resets caret AND view to the START. Fixed (`st->caret =
  st->anchor = 0`). This was why a menu-driven Find after programmatic
  settext found nothing (search runs down from the caret). ctldemo's
  scroll selftest had ENCODED the old behavior ("vbar pos at end") — updated
  to the corrected contract (pos at top; SB_BOTTOM leg covers EN_VSCROLL).
- **user32.c EM_UNDO**: loud `win32: unsupported EDIT EM_UNDO` (once) — the
  ^Z accelerator path bypasses the menu's EM_CANUNDO gray.
- **tools/win32rc.js**: `\r` in an .rc string leaked a literal `r`
  (About showed "Palamarchukr"). Escapes now include `\r`, and finished
  strings normalize `\r\n` / lone `\r` → `\n` (the res pack is a text-in
  path; gucOS is LF-native, 0210). `notepad.res` regenerated (1 byte
  smaller — the leaked 'r').
- **tests/run.js**: `tools/win32rc.js` was UNMAPPED in the RULES table →
  now maps to the kernel suite (the win32 e2es consume the .res packs).

## The regression e2e

`tests/kernel/test_notepad_menu_e2e.js` — clicks EVERY menu item and asserts
its effect or its loud refusal (68 checks): full inventory presence, the
WM_SETTEXT caret contract, all edit ops, both find paths + replace-all +
goto (+ error box), wrap/status-bar toggles with popup-state dumps, the
three loud cancels, the grayed items refusing agent clicks, About (with the
\r fix pinned), open/save/save-as, New Window, Exit. Menu popups are opened
by a self-locating bar click (poll open-popup gettext across candidate x
positions) so no font-metric coordinates are baked in.

Gotchas for future drivers: WM_INITMENUPOPUP only fires when a popup
actually opens — agent clicks by label use the item's LAST computed state,
so gray/check assertions must bar-click the popup open first. And a
Find/Replace "Cannot find" MessageBox is owned by the FIND dialog — it
disables the dialog's own buttons, so a stray Cancel click cascades into
wrong-widget territory (probe round 1 taught this the hard way).

Deferred (pre-existing, already filed): 0135 undo buffer, 0133 EDIT wrap
layout; new: 0223 ChooseFontW + WM_SETFONT.

Two tests had ENCODED the old WM_SETTEXT scroll-to-end behavior and were
updated to the corrected contract: ctldemo's scroll selftest (vbar at top;
SB_BOTTOM leg keeps EN_VSCROLL covered) and os-touch.mjs's two-finger-pan
leg (dense lines first + pan UP, same repaint-marker shape).

Image v101 → v102 (notepad.res + ctldemo are baked). Gates: mkimage v102
sealed; kernel suite 74/74; browser sweep 27/27 (os-touch re-run green
after the contract update, the other 26 passed the same v102 sweep);
projects 26/26; the new e2e stable 3/3 under load (flake 0%).
