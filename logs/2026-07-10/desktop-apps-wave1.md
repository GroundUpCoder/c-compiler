# Desktop apps wave 1 — calc, notepad, fileman, ctlpanel (todos/0048)

Four commits, one per app, per the item's landing rule. Minesweeper — the
fifth wave-1 target — was already playable from 0068, and this item gave
it (and everything else) its Start-menu entry. Image went v39 → v42.

## Shape of the work

0048 was reframed (2026-07-09) from hand-written microui/MVU apps to
**real ReactOS ports over the Win32 veneer** plus native veneer apps
where no port fits. That reframing paid off exactly as WIN32.md
predicted: calc and notepad landed as *veneer growth* driven by
PORTS.md's missing-symbol log (15 + 26 symbols), not as app code — and
the two native apps (fileman, ctlpanel) came out at ~200 lines each
because the toolkit was already there.

## calc (189d956)

- **The clipboard is a file** — `$HOME/.clipboard`, UTF-8 bytes, the
  advapi32 `.win32reg` pattern. Cross-process copy/paste falls out of the
  brokered fs for free; CF_TEXT and CF_UNICODETEXT are two views of the
  same bytes. GetClipboardData handles are clipboard-owned (cached, freed
  on the next Get/Empty/Set), Windows-style.
- **Keyboard translation** (GetKeyboardState/MapVirtualKeyExW/ToAsciiEx)
  needs almost nothing here: SDL3 keysyms are modifier-applied, so
  punctuation VKs *are* their characters and only the US digit-row shift
  pairs and ^A..^Z need reproducing. MapVirtualKeyEx's VK→scan is a
  synthetic identity — its one consumer feeds it straight to ToAsciiEx.
- **TrackPopupMenu rides the 0068 overlay machinery** — `barIdx == -1`
  marks a standalone popup, with its own modal pump. Coordinates are the
  owner's SURFACE space, which is also what the new WM_RBUTTONUP →
  WM_CONTEXTMENU synthesis hands out, so calc's pass-the-lParam pattern
  round-trips without either side knowing about kernel windows. Open
  popups are agent targets (`popupmenu` in the tree, items fire by
  label) — TrackPopupMenu keeps the OS.md drivability pillar.
- **WRES bumped to v2**: RT_DIALOG records carry `u16 menuId`. Calc's
  dialog templates attach menus via the rc `MENU` statement, which the v1
  format simply dropped — the bug surfaced as "calc runs but has no menu
  bar". The dialog window grows by MENU_BAR_H so the template's client
  area is preserved. tools/win32rc.js ↔ user32.c `res_*` stay the
  MUST-MATCH pair; winmine.res regenerated.
- **wmctl click one-arg is always a label now.** Calc's keypad buttons
  are literally named "7"; the old is-it-numeric heuristic sent digit
  labels down the SID path. Nothing is lost — a pixel click always
  carries X Y.
- rc-compiler growth for real-world .rc files: `\`-newline splices,
  `|`/`,` continuation lines, the `<dlgs.h>` id vocabulary, i16 wrap for
  `CW_USEDEFAULT16`.

## notepad (74d7f24)

- **EM_GETHANDLE/EM_SETHANDLE** is the interesting one: ReactOS notepad
  manages the edit buffer as an HLOCAL of WCHARs (reads files into one,
  SETHANDLEs it in; saves via GETHANDLE + LocalLock). Internal storage
  stays UTF-8; the external view materializes on demand at
  `(utf8len+1) * sizeof(WCHAR)` capacity — deliberately over-sized so
  callers that size writes by GetWindowTextLength (UTF-8 units on this
  veneer) never overread; the tail is zeroed. Ownership follows the
  app's protocol: SETHANDLE adopts, the app frees what it replaced,
  destroy frees the rest. ASCII documents round-trip exactly; non-ASCII
  saves may carry NUL padding (recorded, not fixed — the corpus is
  ASCII-tested).
- **comdlg32 file dialogs are real** — readdir LISTBOX, dirs-first,
  OK-on-directory navigates, MUSTEXIST/OVERWRITEPROMPT/DefExt honored.
  OFN hooks/templates are deliberately NOT run (notepad's encoding combo
  degrades to its previous value): a hook needs the explorer-dialog
  notify protocol; grow on demand.
- **Find/Replace speak the real protocol**: modeless dialogs fill the
  app's FINDREPLACEW and send RegisterWindowMessageW's atom to the owner
  with FR_* flags. Both protocol ends live in one process, so per-process
  atom registration suffices.
- **MB_YESNOCANCEL**: the old MessageBox flag tests read type 0x3 as
  OKCANCEL (bitwise & on a nibble enum) — notepad's save prompt was the
  first three-button caller. Button sets now dispatch on the type nibble.
- **kernel32 argv0 fix riding this**: proc_info_init cwd-joined a bare
  argv0, but bare names come from PATH spawns — GetModuleFileNameW
  answered `/root/notepad` for a menu-launched notepad and New Window
  spawned a ghost. It now re-runs the PATH search (falls back to
  cwd-join for relative-with-slash). The res-pack sidecar probe gets the
  real path too.
- Notepad normalizes documents to CRLF internally (the Windows EDIT
  contract) — e2e assertions must expect `\r\n`.

## fileman (fd85358) + ctlpanel (1c3febc)

- fileman mirrors wm.c's `activate()` verbatim (0066: dirs navigate,
  `\0asm`/`#!` spawns own-pgroup with the desktop env, else `term vi`) —
  wm.c's comment had already reserved the seat ("any future file browser
  — 0048"). Keyboard row selection (HOME/arrows) keeps the e2e free of
  row-height pixel math.
- ctlpanel scopes the item's "small kernel addition": **AUDIO_GAIN
  (0x2003)** — master mixer gain in percent (0..200), applied in
  audioPump between the stream sum and the clamp, queried with gain<0.
  System-wide by design (the slider is the physical knob); per-source
  gain can grow on the same opcode later. Reaches C as host.js's
  `__audio_gain` import; the no-mixer env branch remembers locally.

## Fallout repaired along the way

758dd6e (gameboy Desktop launchers, a concurrent landing) swept this
item's in-progress image.json seeding + v39 bump into its diff and left
`vendor/calc/calc.res` dangling at HEAD, plus two test failures from the
shifted desktop icon grid. The calc commit restored bake-ability and the
furniture tests now DERIVE geometry from entry lists (menu + desktop) —
adding a menu entry is a one-line list edit, not coordinate archaeology.

## Testing

Per app: `test_calc_e2e.js` (17), `test_notepad_e2e.js` (18),
`test_fileman_e2e.js` (11), `test_ctlpanel_e2e.js` (7), all in the kernel
suite; `test_audio.js` grew 4 exact-value gain checks. Full kernel suite
(39 files) green at close. The 14-leg browser sweep ran serially:
**13/14** — os-shell and os-drop had hardcoded the pre-758dd6e
desktop-icon grid, were repaired in-place (geometry now derives from
entry lists) and PASS; **os-doom fails deterministically** (identical
region hash across runs — not the known load-flake; doom itself
composites fine when driven manually, and headless doom is green).
Root-cause + the 0048 queue-close are `todos/0074`; 0048 stays open
until it lands. PORTS.md: all six targets `links`.
