# 0223 — win32: real ChooseFontW dialog + WM_SETFONT honored by the controls

- **Status**: done
- **Design**: `todos/WIN32.md` (comdlg32 section; EDIT umbrella 0133)

## Goal

Notepad's Format → Font... (and any future consumer of ChooseFontW) is an
honest-but-loud cancel today (`comdlg32.c`, made loud in the 0222 menu
audit). Make it real:

- **WM_SETFONT plumbing**: user32 ignores WM_SETFONT entirely — controls
  paint with the DC default font (`edit_line_h` → `GetDC` metrics). A
  per-HWND font handle selected into the wrapped DC at paint/measure time
  would let font size (and later style) changes actually take effect. gdi32
  already honors `lfHeight` (`CreateFontIndirect` → `FT_Set_Pixel_Sizes`),
  so the missing half is user32-side.
- **ChooseFontW**: a real modal dialog (the comdlg32 file-dialog shape) —
  face list (the one image font family today), size list, OK/Cancel —
  filling the LOGFONT and returning TRUE.

Notepad then gets a working Font... end to end: ChooseFont →
CreateFontIndirect → WM_SETFONT → the EDIT re-renders at the chosen size.

## Plan

- HWND grows an `hfont`; WM_SETFONT/WM_GETFONT store/report it; the
  `__gdi_dc_wrap` consumers (EDIT paint + measure, BUTTON/STATIC/LISTBOX
  label draw) select it before drawing. Watch `edit_line_h`/`edit_rows`/
  caret x math — all metrics must come from the selected font.
- ChooseFontW dialog over public user32 (the file_dialog precedent),
  agent-drivable (`wmctl click`/`settext`).
- Extend `test_notepad_menu_e2e.js`'s Font... leg from loud-cancel to the
  real dialog; a ctldemo/user32 leg for WM_SETFONT metrics.

## Acceptance

- Font size chosen in notepad's Font... dialog visibly changes the EDIT
  rendering (pixel-assertable: line height changes).
- The loud-cancel report is gone; suites green; image bumped.
