# 0139 — Win32 printing pipeline (PrintDlg / PageSetup / StartDoc rendering)

- **Status**: open
- **Design**: `todos/WIN32.md` (comdlg32 + gdi32 status — the `PrintDlg/
  PageSetupDlg as honest cancels` + `StartDoc family fails loud` threads
  from 0048). Sibling of umbrella 0133, not a blocker (comdlg32/gdi32, not
  the EDIT control). The heavy end of the notepad-completeness set.

## Goal

File → Print / Page Setup / Print Preview all do nothing: `PrintDlgW` and
`PageSetupDlgW` (`os/win32/comdlg32.c:446`) return `FALSE` (honest cancels),
and the whole `StartDoc`/`StartPage`/`EndPage`/`EndDoc`/`AbortDoc` family
(`os/win32/gdi32.c:1442`) returns `SP_ERROR` via `print_stub` (there is no
printer). Notepad's `printing.c` is otherwise complete: `DIALOG_FilePrint`
(`vendor/notepad/printing.c:565`) calls `PrintDlg` for an `HDC`, then drives
`StartDoc` → per-page `StartPage`/`TextOut`/`EndPage` → `EndDoc`
(`printing.c:429`), with header/footer and page-fit math already written.
So the app is ready; the veneer has no output device.

**Reality check first (do this before scoping anything):** this OS has no
physical printer, so "printing" has to mean rendering pages to something the
user can actually see or keep. Decide the honest v1 target — the natural fit
for a browser OS is **print-to-preview** (render each page into a GDI memory
DC / surface and show it in a preview window) and/or **print-to-file** (emit
the rendered pages as image(s) or a document under the user's home). Do NOT
build a fake spooler that drops output on the floor — pick a destination the
result lands in and is inspectable.

## Plan

- Give `PrintDlgW`/`PageSetupDlgW` a real modal `#32770` dialog (the
  MessageBox / template-dialog host exists), filling the caller's
  `PRINTDLG`/`PAGESETUPDLG` (`hDC`, `hDevMode`, `hDevNames`, margins) with a
  synthetic printer whose `HDC` is a gdi32 memory DC sized to the chosen page.
- Make the `StartDoc`/`StartPage`/`EndPage`/`EndDoc` family real over that
  memory-DC device: `StartPage` clears the page bitmap, notepad's `TextOut`
  draws into it, `EndPage` flushes that page to the chosen destination
  (preview surface and/or a saved image/file), `EndDoc` finalizes.
  `AbortDoc`/`SetAbortProc` honour cancellation.
- Wire the destination: a preview window (own surface, page-nav) is the
  richest; a save-to-file path (`~/Documents/…` or a Save-As leg) is the
  simplest testable one. Land at least one end-to-end.
- Update `vendor/notepad/README.md` + `os/win32/PORTS.md` + WIN32.md to
  retire the "printing stays an honest cancel" note, recording exactly what
  the v1 device does vs defers.

## Acceptance

- e2e: a driven notepad with known text runs File → Print to the chosen
  destination and the rendered page(s) contain that text (agent-visible via
  the destination file/surface or a pixel leg), with `StartDoc`→`EndDoc`
  returning success.
- Page Setup round-trips margins/orientation into the `PAGESETUPDLG` and the
  page geometry the print path uses reflects them.
- Manual: File → Print produces visible output (preview window or a saved
  document the user can open); Cancel truly cancels with no partial output.
- Honest scope recorded in-item + README/PORTS/WIN32.md: which of
  preview/print-to-file is live, and what stays deferred (real spooling,
  multi-printer selection, EMF).
