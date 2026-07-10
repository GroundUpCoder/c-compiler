# 0073 — desktop apps behavior bug sweep

- **Status**: open
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

## Acceptance

- Dev-log entry with findings and a fixed/deferred split.
- New regression tests committed for everything fixed.
- Known-issues lists updated (entries added / re-dated / retired).
- Unit, blockfs, kernel, and browser suites green at close.
