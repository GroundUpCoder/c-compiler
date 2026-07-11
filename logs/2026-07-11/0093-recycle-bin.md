# 0093 — Recycle Bin: trash, restore, empty

Delete stops being permanent: fileman's Del and the desktop's new DELETE
route through a trash store, the most iconic Win95 desktop object gets
its icon, and Restore/Empty close the loop. Durable copies: WIN32.md
("0093 (Recycle Bin...)"), WM.md ("Recycle Bin, desktop side"), CLAUDE.md
os/ section. Tests: `tests/kernel/test_recycle_e2e.js` (34 checks, in the
run.js manifest) + `tests/browser/os-recycle.mjs` (sweep-discovered).

## Shape of the store

`/root/.recycle/files/` + `/root/.recycle/info/`, one sidecar per stored
entry under the SAME name (line 1 = original absolute path, line 2 =
delete time in Unix seconds). Alternatives considered:

- **Flat store with `.info` suffix sidecars** — rejected: a trashed file
  literally named `x.info` collides with metadata. The files/info split
  (the XDG trash layout, and in spirit Win95's INFO2) makes collision
  impossible by construction.
- **Name clashes**: `fo_new_dest` reuse — "dup.txt", "dup.txt 2", ...
  The stored name is cosmetic; restore always uses the sidecar path.

Everything lives in `os/fileops.h` (the 0092 rule: a new file op goes in
the shared core, not in one consumer), shell32 re-exports as veneer-local
`SHFileTrash`/`SHTrashEmpty`/… for fileman.

## Decisions & gotchas

- **The bin icon is a real file, pinned to the grid tail.** A
  `/root/Desktop/Recycle Bin` launcher script (`#!/bin/sh` → `fileman
  /root/.recycle/files`) recreated by wm.c's `ensure_recycle()` every
  start: double-click needs ZERO wm.c launch code (activate() runs
  scripts), old images grow a bin without reseeding, and deleting the
  bin heals on the next wm start. The alternative — synthesizing a
  virtual icon in wm.c — would have special-cased hit-testing,
  selection, marquee, and `.icons` persistence. The TAIL pin (an entcmp
  special case) is the load-bearing trick: 'R' sorts before every
  lowercase seed name, so a normally-sorted bin would have shifted
  every desktop icon down one cell and broken the icon-index math in
  five test files (os-shell, os-drop, wm_service, ctxmenu, fileman_ops).
  With the pin, only os-drop's "last cell" signal moved.
- **fo_trash sweeps its own EXDEV wreckage.** Trashing under /bin:
  rename → EXDEV (cross-volume), fo_move falls back to copy(+succeeds,
  the store is writable)+delete(fails EROFS). Without a sweep the failed
  trash STRANDS a copy in the store. `fo_trash` lstat's the dst on
  fo_move failure and deletes it — the e2e asserts `S0-END`.
- **Sidecar write failure rolls the move back** — an entry without its
  original path could never be restored, so it must not enter the store.
- **Permanent delete in-store must drop the sidecar** (`fo_trash_forget`)
  — caught by the first e2e run: SHFileDelete alone orphaned
  `info/dup.txt 2`, which a later same-name trashing would have silently
  adopted as its own (wrong restore path).
- **fileman now hides dotfiles** (refill skips `.`-prefixed names). The
  .recycle store showing up in every /root listing broke
  test_fileman_e2e's row math and is exactly what 0106 anticipated
  ("dotfiles hidden — closer to Explorer and to the eventual Recycle-Bin
  dotdir, 0093"). Navigation by path still reaches dot dirs — that's how
  the bin launcher and the tests get in. 0106 keeps the View-menu toggle.
- **Confirm wording is the dispatch signal in tests**: "send 'x' to the
  Recycle Bin?" (trash) vs "delete 'x'?" (permanent — Shift+Del, or any
  delete inside the store). Titles stay "Confirm File/Folder Delete" so
  os-fileman.mjs's `grep -q Confirm` survived untouched.
- **wm.c side ships without confirms** (desktop DELETE/Del key trash
  silently — recoverable; bin-menu EMPTY fires directly — the one
  destructive exception). wm.c has no dialog furniture; fileman's flows
  all confirm. Recorded in WM.md and owned by **0110** (after 0109,
  which wants the same furniture).
- **Goldens moved with the menu** (the 0092 rule): icon ctx menu
  120x76 → 120x96 (DELETE row) in test_ctxmenu_e2e; the bin's own menu
  is 120x56. os-ctxmenu.mjs never asserted the icon-menu size — only the
  kernel golden moved.

## Verification

Full kernel suite green after the change (49 passed, incl. the new
test_recycle_e2e's 34 checks); browser legs all PASS: os-recycle (new),
os-fileman, os-ctxmenu, os-shell, os-drop. Image version 53 → 54 (seeded
sources changed: wm.c, fileman.c, shell32.c, fileops.h, shellapi.h).

Two browser-test traps hit writing os-recycle.mjs (new 0089-family):

- **Typing after a `$(wmctl …)` substitution races the prompt** — the
  next line's leading keystroke lands before hush prints `~ #` and gets
  eaten (`wmctl` became `mctl`). Pause ~800ms after EVERY typed shell
  line that runs a command, not just after `&` jobs.
- **The tail-pinned bin MOVES ROWS when the desktop count changes** — a
  restored file re-enters the sorted grid above the bin, pushing it one
  row down; glyph pixel probes must track the current entry count (the
  final probe reads row 8, not 7, after the restore).
