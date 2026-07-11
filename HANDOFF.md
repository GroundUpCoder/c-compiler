# Handoff — start of thread (updated 2026-07-11; 0092 fileman ops closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0092 (File manager operations) is CLOSED**; image bumped **v52 → v53**.
Dev log `logs/2026-07-11/0092-fileman-ops.md`; item at
`todos/done/0092-fileman-file-ops.md`; durable notes in CLAUDE.md (os/
section) and WIN32.md ("0092 (fileman file operations…)"). What landed:

- **`os/fileops.h`** — the ONE file-ops core (header-only, the openwith.h
  precedent), shared by fileman.c AND wm.c: recursive copy (symlinks copy
  AS links; refuses dir-into-itself), move (rename + EXDEV fallback,
  refuses EEXIST — no silent overwrite), recursive delete, the "Copy of
  N"/"New Folder N" uniquifiers, and the **clipboard file list** (format-2
  payload on the ONE 0090 kernel slot → cut/copy/paste crosses
  fileman↔fileman↔desktop). shell32 re-exports it as VENEER-LOCAL
  `SHFile*`/`SHClip*` (NOT real SHFileOperation).
- **fileman.c**: right-click menu (Open/Open With[dir-gray]/Cut/Copy/
  Rename/Delete/Properties on a row; Paste[clip-gated]/New Folder/Refresh
  on the pane) over 0091's TrackPopupMenu; F2/Del/^C/^X/^V accelerators
  (listbox-focus gated so the path EDIT keeps its text chords); a rename
  dialog (Enter/Esc from the message loop, EEXIST keeps it open); delete
  confirm (MB_YESNO) + Properties (stat) MessageBoxes; EROFS surfaced
  cleanly (delete under /bin → /usr RO fails, no crash).
- **wm.c desktop menus**: icon Cut/Copy (the selection set) + desktop
  Paste, over the SAME fileops.h list.
- **Fell out**: user32 AQ_CLICK now prefers an **ENABLED** match
  (`agent_find_ex`, `Find.wantEnabled`) so modal-over-modal (an error box
  over the rename dialog) is agent-drivable; new `AppendMenuA`,
  `CreateAcceleratorTableA`+ACCEL/FVIRTKEY, `LB_ITEMFROMPOINT`.

**Tests**: new `tests/kernel/test_fileman_ops_e2e.js` (22 checks; registered
in run.js — the kernel runner is a MANIFEST, add new files to `tests`) +
`tests/browser/os-fileman.mjs`. ctxmenu goldens MOVED with the grown menus:
desktop menu **120x116** (PASTE row), icon menu **120x76** (Cut/Copy) —
updated in test_ctxmenu_e2e.js + os-ctxmenu.mjs. Green: fileman_ops,
ctxmenu, user32, fileman, notepad, calc, winmine, clipboard, wm_service
kernel e2e; os-shell/os-user32/os-ctxmenu/os-fileman browser legs.

**Filed by the 0092 closeout audit** (both committed):
- **0108** — `test_openwith_e2e.js` was NEVER in the run.js manifest (so it
  silently never runs) and is red on baseline: it still expects Peanut-GB
  for `.gb` while the baked seed routes `gb → /bin/sameboy` (the recorded
  0075 call; the done-file's early Status line contradicts it — the seed
  is the truth). Queued at pos 2, right after 0093.
- **0109** — desktop icon Properties popup (fileman got Properties, the
  wm.c icon menu deliberately didn't — no dialog furniture there yet).
  Soft-dep after 0103.

**Next in queue**: `node todos/queue.js list` — **0093 (Recycle Bin)** leads
and builds directly on 0092 (delete is PERMANENT until it reroutes; the
fileops.h delete path is the seam). Then 0108 (openwith test rot), 0094
(sound scheme), 0095 (Aero Snap), 0096 (screensaver), 0098 (Start menu Win7
pane), 0101 (taskbar-strip menu), 0102 (window system menu), 0103
(desktop-icon rename — the desktop menu has Cut/Copy but not Rename yet,
deliberately), 0106 (fileman navigator v2: multi-select/details/F5 — builds
on 0092's verbs), 0109 (desktop icon Properties, after 0103). **Do NOT
pipe `queue.js list` through `head`** — EPIPE crash (known, harmless, noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds, a MUST for WM sweep round 3 (`0064`), which also carries the
0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0092 NEW: the fileman ops core is `os/fileops.h`** — header-only,
  shared by fileman.c AND wm.c; a new file op goes THERE, not in one
  consumer. The clipboard file list is **format 2** on the 0090 slot
  (fmt 1 = text); last-write-wins across formats.
- **0092 NEW: AQ_CLICK prefers an ENABLED match** (`agent_find_ex`) — a
  disabled same-labelled button no longer shadows the live one, so
  modal-over-modal is drivable. `gettext`/`settext` still find disabled
  controls (only clicks prefer enabled).
- **0092 NEW: a real browser right-click's screen→surface offset is
  imprecise for ROW selection** — os-fileman.mjs proves the RENDER with a
  real mouse but drives row-precise ops through `wmctl click $SID x y 3`
  (surface coords). fs effects verified through the VT1 shell.
- **0092 NEW: ctxmenu goldens are 120x116 (desktop) / 120x76 (icon)** — if
  you grow those menus again, the constants live in wm.c MENU_*/CTX_W and
  the goldens in test_ctxmenu_e2e.js + os-ctxmenu.mjs (move together).
- **0091: `wmctl list` is Z-ORDERED** — pick rows by sid (lowest = oldest),
  not position. `wmctl tree` dumps every window's menu BAR before the
  `popupmenu` section — scope popup-item asserts to after `popupmenu\n`.
- **0091: browser popup tests must quiesce ~1.5s after the VT2 settle** —
  a late screen-resize's EV_SCREEN dismisses popups.
- **0090: browser keyboard pacing** — type with `{delay: 50-60}`; chords as
  explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes(...))`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`) or `GOT-…-END` wrappers. (2) Typing right after a `&`
  job races hush's job notice — `waitForTimeout(800)` first.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
- **CONFIRMED AGAIN 0092: `queue.js done` staged a PRE-EDIT blob** of the
  done file — after `done`, `git add todos/done/<file>` again (the Status
  edit was missing; `git show :todos/done/<file>` to confirm). Stage ONLY
  your own files; concurrent sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **53**) when an interactive browser
  tab must pick up seeded-source edits. Delete `os/os-system.img` +
  `os/os-root.img` to force a rebake after a shared-source change (user32,
  fileops.h, etc.) or the fixture serves a stale binary.
- **New-runner habits**: check `build/test-*/summary.json` (`status:
  'pass'`) + per-file logs after an interrupted run; `--resume` picks up.
  Sweep is serial by design (0045).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. **`queue.js add --help` is NOT a help flag** — it ADDS an
  item named "untitled" (fix queued as 0099).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise;
  headers are compiler.js built-ins or include-path resolved.
- For the long tail (WRES v2, argv0, TrackPopupMenu coords, 0069 unmapped
  semantics, MAKEINTRESOURCE stack caveat, shebang one-optarg, 0040 image
  pairing, MUST-MATCH block list): see `todos/done/0048`'s Status,
  `logs/2026-07-10/0048-closeout.md`, and the CLAUDE.md sections — the
  durable copies.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0091's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0072's calls (openwith store FIRST-FILE-WINS, resolver stays header-only);
0090's calls (the clipboard is a KERNEL slot — one slot, no history,
last-write-wins, **format-tagged**); 0091's calls (fixed item lists NOT
directory scans; ONE flyout depth; gray rows never fire and leave the menu
open; taskbar CLOSE is request-close); **0092's calls (the ops core is
header-only `os/fileops.h` shared by fileman + wm.c; the clipboard file
list is format-2 textual CF_HDROP on the ONE 0090 slot; shell32's SHFile*
are VENEER-LOCAL not real SHFileOperation; move refuses EEXIST — no silent
overwrite; copy preserves symlinks AS links; delete is PERMANENT until
0093; AQ_CLICK prefers an enabled match; multi-select/details = 0106,
desktop-icon rename = 0103, DnD = non-goal)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0093 Recycle Bin
leads and builds directly on 0092's delete path, then 0094–0096, 0098,
0101–0106; 0064 WM sweep round 3 still owes the pointer-lock human check)."
