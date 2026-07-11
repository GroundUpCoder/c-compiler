# Handoff — start of thread (updated 2026-07-11; 0093 Recycle Bin closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0093 (Recycle Bin) is CLOSED**; image bumped **v53 → v54**. Dev log
`logs/2026-07-11/0093-recycle-bin.md`; item at
`todos/done/0093-recycle-bin.md`; durable notes in CLAUDE.md (os/
section), WIN32.md ("0093 (Recycle Bin…)"), WM.md ("Recycle Bin, desktop
side"). What landed:

- **Trash store in `os/fileops.h`** (the shared core, 0092's rule):
  `/root/.recycle/files/` moved entries (clashes → "x", "x 2"),
  `/root/.recycle/info/` one sidecar per entry (line 1 original absolute
  path, line 2 delete time). `fo_trash` refuses in-store paths and
  SWEEPS fo_move's EXDEV partial copy on failure (EROFS under /usr
  strands nothing); failed sidecar write rolls the move back;
  `fo_restore` → EEXIST on occupied target; `fo_trash_forget` drops the
  sidecar of a permanent in-store delete. shell32 re-exports
  (`SHFileTrash`/`SHTrashEmpty`/…, veneer-local).
- **fileman**: Del/menu Delete = confirmed trash ("send 'x' to the
  Recycle Bin?"), Shift+Del = confirmed permanent (FVIRTKEY|FSHIFT
  accelerator), in-store row menu Restore/Delete(permanent)/Properties
  — Restore prompts "Replace it?" on EEXIST — pane menu Empty Recycle
  Bin (confirmed, empty-grayed)/Refresh. **fileman now HIDES dotfiles**
  (refill skips `.`-names; navigation by path still reaches them) —
  the 0106-anticipated default; 0106 keeps the show-hidden toggle.
- **wm.c desktop**: the bin icon is a REAL `/root/Desktop/Recycle Bin`
  launcher script (`#!/bin/sh` → `fileman /root/.recycle/files`)
  recreated by `ensure_recycle()` at every wm start (old images heal;
  the bin can't be lost). It **pins to the grid's TAIL** (entcmp special
  case) so every other icon keeps its sorted cell — that's what kept the
  icon-index math in five test files valid. Basket glyph: center white
  empty / navy full (`desk_trash_full`, coarse-tick refresh). Icon menu
  grew DELETE (+ the Del key), both skip the bin; cut/copy skip it too;
  the bin's own menu is OPEN / EMPTY RECYCLE BIN (empty-grayed).

**Tests**: new `tests/kernel/test_recycle_e2e.js` (34 checks, in the
run.js MANIFEST) + `tests/browser/os-recycle.mjs` (sweep-discovered).
Goldens that MOVED: icon ctx menu **120x76 → 120x96** (DELETE row) in
test_ctxmenu_e2e.js (os-ctxmenu.mjs never asserted it); the bin's own
menu is 120x56. os-drop.mjs's "last cell" signal moved one row down
(the BIN const). test_fileman_e2e's /root listing golden survives via
the dotfile hiding; test_fileman_ops_e2e's delete-confirm assert now
matches the Recycle-Bin wording. Full kernel suite green post-change;
browser legs run: os-recycle, os-fileman, os-ctxmenu, os-shell, os-drop.

**Follow-ups filed by 0093**:
- **0110** (after 0109) — wm.c desktop confirm dialogs: bin-menu EMPTY
  fires unconfirmed (the one destructive exception; wm.c has no dialog
  furniture), desktop deletes don't confirm (recoverable, low stakes),
  no desktop Shift+Del bypass. Same furniture 0109 wants.
- 0106 already owned the fileman hidden-files toggle; its body now
  records that the hidden-by-default half landed with 0093.

**Next in queue**: `node todos/queue.js list` — **0108 (openwith test
rot: unregistered test_openwith_e2e.js, expects Peanut-GB for .gb while
the seed routes gb → sameboy)** leads, then 0094 (sound scheme), 0095
(Aero Snap), 0096 (screensaver), 0098 (Start menu Win7 pane), 0101
(taskbar-strip menu), 0102 (window system menu), 0103 (desktop-icon
rename), 0106 (fileman navigator v2), 0109 (desktop icon Properties,
after 0103), 0110 (wm confirms, after 0109). **Do NOT pipe `queue.js
list` through `head`** — EPIPE crash (known, harmless, noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds, a MUST for WM sweep round 3 (`0064`), which also carries
the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0093 NEW: the Recycle Bin icon sorts LAST on the desktop** (entcmp
  special case on the name "Recycle Bin") — desktop tests keep indexing
  the sorted seeds as before, but any test that asserts the LAST cell or
  a full grid must count the bin (os-drop.mjs's `BIN` const is the
  pattern). The seeded desktop is now 8 icons (7 seeds + bin row 7).
- **0093 NEW: fileman listings hide dotfiles** — drive tests into dot
  dirs by `wmctl settext EDIT:0 <path>` + Go, never by clicking rows.
- **0093 NEW: trash-vs-permanent is told by confirm WORDING** ("send
  'x' to the Recycle Bin?" vs "delete 'x'?"); box titles stay "Confirm
  File/Folder Delete" — os-fileman.mjs greps `Confirm` and survived.
- **0092: the fileman ops core is `os/fileops.h`** — a new file op goes
  THERE, not in one consumer. Clipboard file list = format 2 on the 0090
  slot; last-write-wins across formats.
- **0092: AQ_CLICK prefers an ENABLED match** — modal-over-modal is
  drivable; gettext/settext still find disabled controls.
- **0092: real-browser right-click row selection is imprecise** — prove
  the render with a real mouse, drive row-precise ops through
  `wmctl click $SID x y 3` (surface coords), verify fs via the VT1 shell.
- **0091: `wmctl list` is Z-ORDERED** — pick rows by sid. `wmctl tree`
  lists menu BARS before the `popupmenu` section.
- **0091: browser popup tests must quiesce ~1.5s after the VT2 settle** —
  a late EV_SCREEN dismisses popups.
- **0090: browser keyboard pacing** — type with `{delay: 50-60}`; chords
  as explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes(…))`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`). (2) Typing right after a `&` job races hush's job
  notice — `waitForTimeout(800)` first. (3) 0093 NEW: typing right after
  ANY `$(wmctl …)` substitution races the prompt the same way (the next
  line's leading keystroke gets eaten — `wmctl` became `mctl`); pause
  ~800ms after every typed shell line that runs a command.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (`git show :todos/done/<file>`
  to confirm). Stage ONLY your own files; concurrent sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **54**) when an interactive
  browser tab must pick up seeded-source edits. Delete `os/os-system.img`
  + `os/os-root.img` to force a rebake after a shared-source change
  (user32, fileops.h, etc.) or the fixture serves a stale binary.
- **New-runner habits**: check `build/test-*/summary.json` (`status:
  'pass'`) + per-file logs after an interrupted run; `--resume` picks up.
  Sweep is serial by design (0045). The kernel runner is a MANIFEST —
  new test files must be added to `tests` in run.js or they silently
  never run (0108's lesson).
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0092's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090's calls (the clipboard is a KERNEL slot — one slot, no history,
last-write-wins, format-tagged); 0091's calls (fixed item lists NOT
directory scans; ONE flyout depth; gray rows never fire and leave the
menu open); 0092's calls (ops core header-only + shared; format-2
textual CF_HDROP; SHFile* veneer-local; move refuses EEXIST; copy
preserves symlinks; DnD = non-goal); **0093's calls (the trash store is
`/root/.recycle` files/+info/ with textual sidecars — original path +
Unix seconds; delete-in-store is PERMANENT; the bin icon is a real
launcher script recreated every wm start and pinned to the grid TAIL;
no quota/auto-purge — unbounded until Empty; no /usr trashing — EROFS
is the answer; no dedicated bin app — it opens in fileman; wm.c-side
confirms deferred to 0110, fileman dotfile toggle to 0106)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0108 openwith test
rot leads, then 0094–0096, 0098, 0101–0106, 0109–0110; 0064 WM sweep
round 3 still owes the pointer-lock human check)."
