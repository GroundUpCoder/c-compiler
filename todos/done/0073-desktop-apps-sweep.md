# 0073 — desktop apps behavior bug sweep

- **Status**: done (2026-07-15) — MERGED into `todos/0127-manual-ux-sweep.md`
  by the queue reconciliation (seven overlapping human-sweep items → one).
  0127 carries this item's app-behavior checklist as its "0073 slice" and
  the still-live seeded findings (EM_GETHANDLE padding, OFN hooks,
  MessageBox BTNSETS, size grip, the notepad-open lock-in test, ctlpanel
  master-only volume); the EDIT-undo line is owned by todos/0135 and the
  fileman gaps shipped in done/0092/0106. No sweep was executed under this
  id.
- **Design**: `todos/WM.md` / `todos/WIN32.md` bug-sweep block (the
  repeatable dogfood format established by todos/done/0033; WM rounds
  0039 / 0064 are the siblings).

## Goal

A dedicated dogfood/verification pass over the **desktop apps'
behavior** (calc, notepad, fileman, ctlpanel, minesweeper, gameboy,
term) — the Unix/Win95-correctness details that individual feature items
skip. Output is repro tests + fixes + an updated known-issues list, not a
new feature. Prompted by the tty Ctrl+D bug (0071): "it behaves wrong
vs other Unix terminals" is exactly the class this sweep hunts.

Do this **after** 0071 (tty VEOF) and 0072 (openwith) land, so the sweep
covers their new behavior too. Not gated on them.

## Plan

- Drive each app through realistic sessions and note anywhere the
  behavior diverges from the equivalent Unix/Win95 app:
  - **term**: control chars (^C/^D/^Z/^\), EOF vs shell exit (0071),
    resize/SIGWINCH reflow, alt-screen restore, job control interplay.
  - **notepad / calc / fileman / ctlpanel**: keyboard focus & tab order,
    clipboard, dialog cancel paths, window close vs app quit, error
    dialogs on bad input.
  - **gameboy**: ROM open via association (0072), input focus, exit.
- Every finding becomes a MINIMAL repro test FIRST (conformance-corpus
  rule), then a fix as its own commit referencing this item.
- Verified-but-unfixed issues → the relevant known-issues list
  (`WM.md` / `WIN32.md`) with a repro, not silently dropped.

## Seeded findings (known at 0048's landing — start here)

Deliberate v1 shortcuts recorded in the 0048 code/dev log; each is
sweep fodder to either fix or formally accept into a known-issues list:

- **EDIT has no undo buffer**: EM_CANUNDO answers FALSE, so notepad's
  Undo menu item is permanently grayed (honest, but a real editor wants
  at least single-level undo).
- **EM_GETHANDLE non-ASCII padding**: the materialized WCHAR view is
  sized by the UTF-8 length (tail-zeroed), so notepad saves of
  non-ASCII documents can append NUL padding — ASCII round-trips
  exactly (user32.c edit_sync_handle comment).
- **OFN hooks/templates are not run**: notepad's Save As encoding/EOLN
  combos never appear; encoding silently stays at its previous value.
  Growing this means the explorer-dialog notify protocol (comdlg32.c
  header records the call).
- **MessageBox knows OK/OKCANCEL/YESNOCANCEL/YESNO only** —
  ABORTRETRYIGNORE falls back to a bare OK (user32.c BTNSETS).
- **Status bar draws no size grip** (SBARS_SIZEGRIP accepted, ignored);
  IsDialogMessageW is ESC-only (no Tab order — the 0058 simplification).
- **fileman**: no rename/delete/copy — it is a navigator/launcher only;
  Enter in the LISTBOX doesn't Open (button/double-click only).
- ~~**notepad shows an ERROR dialog opening an existing text file**~~
  **FIXED / stale** (verified 2026-07-12 notepad menu audit — see
  `logs/2026-07-12/queue-hardening-and-keymap.md`): `notepad
  /root/notes.txt` now loads the file cleanly ("notes.txt - Notepad",
  content in the EDIT, correct status bar, no ERROR window). Add the
  lock-in regression test (title + EDIT content + no `#32770`) and
  retire this line.
- **Notepad menu audit done 2026-07-12** — full findings in
  `todos/0145` (the silent Print/Page Setup/Font no-ops + Save-As
  encoding combos + the About `\r\n` escape bug). Everything else in
  notepad's menus WORKS. This sweep should still cover calc / fileman /
  ctlpanel / term / winmine / gameboy at the same depth.
- **ctlpanel**: volume is master-only (per-source gain can grow on the
  same AUDIO_GAIN opcode if a mixer panel wants it).

## Acceptance

- Dev-log entry with findings and a fixed/deferred split.
- New regression tests committed for everything fixed.
- Known-issues lists updated (entries added / re-dated / retired).
- Unit, blockfs, kernel, and browser suites green at close.
