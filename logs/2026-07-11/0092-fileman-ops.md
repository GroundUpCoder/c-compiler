# 0092 — File manager operations (rename/delete/copy/cut/paste/properties)

**Date**: 2026-07-11
**Item**: `todos/done/0092-fileman-file-ops.md`
**Image**: v52 → v53

## What landed

fileman went from navigate-and-launch (0048) to a real Explorer, and the
Win95 desktop gained matching icon file ops — both over ONE shared core.

### `os/fileops.h` — the ops core (header-only, the openwith.h precedent)

The decision that shaped everything else: put the file operations in a
header-only module included by BOTH `os/win32/fileman.c` (a win32 app) and
`os/wm.c` (which is NOT — it's a raw-SDL kernel service). The two consumers
must behave identically, and a header keeps them so — exactly the argument
openwith.h (0072) already made for the association resolver.

Contents: recursive `fo_copy` (files by a 32KB read/write loop preserving
mode; directories entry-by-entry; **symlinks copied AS links** — a Desktop
launcher copies like a Windows shortcut, not its target; refuses
dir-into-itself so a paste can't recurse forever), `fo_move` (rename(2) with
an EXDEV copy+delete fallback, **refuses an existing destination = EEXIST**,
no silent overwrite — the 0103 rename rule applied here early), recursive
`fo_delete`, the `fo_paste_dest` "Copy of X" / "Copy (N) of X" clash
uniquifier and the `fo_new_dest` "New Folder N" one, and the **clipboard
file list**: a format-2 payload on the ONE 0090 kernel slot — a "cut\n" or
"copy\n" header then one absolute path per '\n'-terminated line (CF_HDROP,
kept textual). Because it rides the kernel slot, cut/copy/paste crosses
processes: fileman↔fileman↔desktop, last-write-wins against fmt-1 text.

`__clip_set`/`__clip_get` are re-declared in the header (imports dedup by
name, so redeclaring the __SDL.c imports is fine) — verified by compiling a
throwaway that includes both fileops.h and SDL.h.

### shell32 veneer — `SHFile*` / `SHClip*`

Thin exports over fileops.h. Deliberately **NOT** the real `SHFileOperation`
(the double-NUL `SHFILEOPSTRUCT` shape has no corpus consumer): these are
veneer-local helpers, named to read like the Windows shell but honest about
scope. `SHFileCopy/Move/Delete`, `SHPasteDest/SHNewDest`,
`SHClipSetFiles/HasFiles/LoadFiles/Path/Clear`.

### fileman.c

- **Context menu** over the 0091 `TrackPopupMenu` primitive, built at
  WM_CONTEXTMENU: on a row, Open / Open With (grayed for a dir) / Cut /
  Copy / Rename / Delete / Properties; on the empty pane, Paste (grayed
  unless a file list is on the clipboard) / New Folder / Refresh. The row
  under the pointer is selected first (Explorer rule) via
  `LB_ITEMFROMPOINT` → `LB_SETCURSEL`. Items are agent targets for free.
- **Accelerators**: F2/Del/^C/^X/^V through a runtime `ACCEL` table,
  `TranslateAcceleratorW` gated on `GetFocus()==listbox` so the path EDIT
  keeps its own ^C/^X/^V text chords.
- **Rename dialog**: the "Open with" picker pattern — a small top-level
  with the name EDIT + OK/Cancel; Enter/Esc route from the message loop
  (the single-line EDIT swallows both, and there's no IsDialogMessage in
  this veneer). EEXIST keeps the dialog open with an error box.
- **Delete** confirms with MB_YESNO; **Properties** is a stat() MessageBox
  (name/location/type/size/mtime); every failure surfaces
  `strerror(errno)` — deleting under /bin (→ /usr, RO, 0040) shows a clean
  EROFS box, no crash.

### wm.c desktop menus

The 0091 icon menu grew **Cut/Copy** (over the whole selection set → the
format-2 list) and the desktop menu grew **Paste** (gated on
`fo_clip_has()`, grayed for a text-only clipboard). Errors go to the
service log — wm.c has no dialog furniture (fileman owns the user-facing
errors). This is what makes desktop-copy → fileman-paste work: one slot.

## Friction that fell out

**Modal-over-modal wasn't agent-drivable.** The rename EEXIST path stacks a
MessageBox over the rename dialog; the box disables its owner. But
`agent_find` returned the FIRST visible label match in tree order — the
rename dialog's now-disabled OK — and AQ_CLICK then bailed on
`!hwnd_able`, leaving the error box up forever. Every downstream test step
wedged behind it.

Fix (a genuine agent-infra improvement, not a test hack): `Find.wantEnabled`
+ `agent_find_ex`, set only on the AQ_CLICK path, so a disabled match is
skipped and the live MessageBox OK wins. Clicking a disabled control is a
no-op anyway, so preferring enabled is strictly better for driving. This is
why the first headless run had 21/22 red with cascading failures — one root
cause, not twenty-one.

## New user32/windows.h surface

`AppendMenuA`, `CreateAcceleratorTableA` (+ `ACCEL`/`FVIRTKEY`/`FSHIFT`/…),
`LB_ITEMFROMPOINT`. PORTS.md regen showed no corpus change (none use them).

## Tests

- `tests/kernel/test_fileman_ops_e2e.js` (registered in run.js — the manifest
  is not a glob) — 22 checks: the file/pane menus, F2 rename + EEXIST + the
  message-loop Enter commit, recursive copy+paste with the uniquifier,
  cut+paste move + slot-clear re-gray, Del confirm No/Yes, EROFS box,
  New Folder uniquifier, dir/file Properties, and the wm.c desktop menus
  (text-clip PASTE stays grayed; icon copy→desktop paste; icon cut→fileman
  paste = cross-app move).
- `tests/browser/os-fileman.mjs` — real Chromium: the popup renders
  in-surface, Copy+Paste / F2 rename / Del all commit (fs effects checked
  through the VT1 shell). Row selection under a *real* right-click is
  screen→surface-offset-imprecise, so the browser leg proves the RENDER and
  drives the row-precise ops through wmctl surface coords.
- ctxmenu goldens moved with the grown menus: desktop menu 120x96→**120x116**
  (PASTE row added), icon menu 120x28→**120x76** (Cut/Copy added). Updated in
  `test_ctxmenu_e2e.js` + `os-ctxmenu.mjs`.

Regression: user32/fileman/notepad/calc/winmine/clipboard/wm_service/openwith
kernel e2e all green (the 3 openwith failures are pre-existing on baseline —
0075 made sameboy the default .gb handler + the ROM is gitignored); os-shell,
os-user32, os-ctxmenu, os-fileman browser legs all pass.

## Not done (all already queued — no new items filed)

- Delete → Recycle Bin is **0093** (delete is permanent for now, as the plan
  anticipated).
- Multi-select + details/columns view is **0106**.
- Desktop-icon rename-in-place is **0103** (the desktop menu has Cut/Copy
  but not Rename yet).
- Drag-and-drop within panes is a recorded non-goal.
