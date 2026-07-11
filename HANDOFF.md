# Handoff — start of thread (updated 2026-07-11; 0104 dialog keyboard closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0104 (user32 dialog keyboard) is CLOSED**; image bumped **v63 → v64**
(seeded `user32.c`/`ctldemo.c` + the new `ctldemo.res` changed). Dev log
`logs/2026-07-11/0104-dialog-keyboard.md`; item at
`todos/done/0104-win32-dialog-keyboard.md`; design write-up in
`todos/WIN32.md` (the 0104 paragraph before "Corpus status"). One breath:
**`IsDialogMessageW` became the real dialog manager** — **Tab/Shift+Tab**
(`GetNextDlgTabItem`, WS_TABSTOP walk), **Alt+mnemonic** (`&`-marked
control; button presses, static hands focus to the next tabstop), **Enter**
= the DEFPUSHBUTTON (or a focused pushbutton, or a newline in a multiline
edit), **Esc** = IDCANCEL, **arrows** within a WS_GROUP radio run
(`GetNextDlgGroupItem`) — all over a new **`WM_GETDLGCODE`** across every
standard control, wired into **both** modal loops (DialogBoxParamW +
MessageBox) and DefDlgProc (DM_GETDEFID/SETDEFID/WM_NEXTDLGCTL). Rendering
followed: mnemonic-underlined labels + the black default-button outline;
LISTBOX gained PageUp/PageDown. All in `os/win32/user32.c` +
`os/win32/include/windows.h` (the DLGC_*/DM_* defines).

**The acceptance surface is a NEW template dialog in ctldemo:**
`os/win32/ctldemo.rc` → `ctldemo.res` (WRES sidecar via `tools/win32rc.js`,
seeded `/usr/bin/ctldemo.res` in image.json) is an "Options" dialog with
mnemonic'd `&Name`/`&Verbose`/`&OK`/`&Cancel`; ctldemo grew an **Options**
button (140,284) + `OptProc`. It's a real `DialogBoxParamW` template — the
first non-corpus app to carry its own `.res`.

**The two load-bearing subtleties (see the dev log):**
1. **edit_proc already had a `case WM_GETDLGCODE` returning `4`**
   (DLGC_WANTALLKEYS) — "always wants all keys", the reason the OLD
   IsDialogMessageW let Enter fall through to edits. I removed it; single-
   line edits no longer claim Enter, so it reaches the default button.
2. **The disabled modal owner keeps a stale ` focus` mark** (its
   `top->focus` still points at the button that opened the dialog), so
   `wmctl tree` shows TWO ` focus` lines while a modal is up — pick focus
   **by control id inside the `#32770` subtree**, never by grepping
   ` focus` globally.

**Verified**: `node tests/kernel/run.js` **53/0** over a fresh v64 bake.
`test_user32_e2e.js` grew a **session B** (Options dialog: Tab walk,
Shift+Tab reverse, Alt+N static mnemonic, type+Alt+V-toggle+Enter default →
`opt-ok name='hi' verbose=1`, Esc + Alt+C → IDCANCEL) plus a MessageBox
keyboard leg. winmine e2e stays green.

**Manual browser tier NOT run this session** (no Playwright in this env):
`tests/browser/os-user32.mjs` grew a 0104 leg (REAL page keyboard: open
Options, type into the edit, Alt+V, Enter → the shell `opt-ok` marker;
reopen, Esc). **The operator should run `node tests/browser/os-sweep.mjs
--filter=os-user32` to eyeball it** — same standing as the prior browser
legs. Headless mnemonic driving = `wmctl key SID SC SYM MOD`, **MOD 256 =
LALT**.

**Next in queue**: `node todos/queue.js list` — 0105–0107 (desktop-icon
details/multi-select tail) lead, then 0112, … 0116 (title-bar right-click
sysmenu). 0064 (WM sweep round 3) still owes the operator the pointer-lock
human check, the 0094 sound listen, the 0095 snap feel, the 0096 saver
eyeball, the 0101 taskbar leg, the 0102 os-wm leg, the 0103 os-shell leg,
and now the 0104 os-user32 leg.

## Gotchas carried forward (trimmed to the live ones)

- **0104: ctldemo now carries a `.res` sidecar** (`ctldemo.res`, committed;
  seeded `/usr/bin/ctldemo.res`). Regenerate with `node tools/win32rc.js
  os/win32/ctldemo.rc -o os/win32/ctldemo.res` after editing the `.rc`. The
  loader finds it by argv0 → `/bin/<name>.res` (merged-usr symlink). Editing
  the `.rc` needs an image bump to reach a persistent browser tab.
- **0104: the disabled owner's stale ` focus` mark** — modal tests pick
  focus by id inside the `#32770` subtree, not by grepping ` focus`.
- **0104: `wmctl key` carries a 5th MOD arg** (SDL keymod; 256 = LALT) —
  the only way to drive Alt+mnemonic headless. It rides both the down and
  up edges.
- **0103: the icon menu is 6 rows (120x116)** — OPEN / --- / CUT / COPY /
  DELETE / RENAME. RENAME was appended, so DELETE (row4, y=82) keeps its Y.
  The inline editor is a `desk_edit >= 0` modal branch in `desk_key`; the
  `desk_edit_armed` flag is load-bearing for the menu-path focus race.
- **0102: the sysmenu popup IS the key grabber** — during Move/Size the
  "ctxmenu" window stays up and holds focus. `ctx_key` Down skips SEP but
  NOT GRAY.
- **0101: the clock moved 14px LEFT** (Show Desktop sliver took the far
  right). Sample the clock cell against `clock_left() = bar_w - SHOWDESK_W -
  CLOCK_W`. A clicked (pinned) datepop lingers until clicked away.
- **0098: recents only record launches THROUGH the wm** (`activate()`) — a
  shell `winbox &` does NOT. Left-pane geometry is FIXED (290×234); clear
  `~/.config/recent` to make it deterministic. Esc from a FLYOUT closes the
  whole menu; headless flyout nav backs out with **Left**, not Esc.
- **0114: OPFS image filenames stayed `os-*.v5.img`** — content is
  version-gated, so persistent browser images re-fetch on a version bump
  without orphaning root volumes. The 5×7 wm.c font is A–Z uppercase-only.
- **0096: the saver default timeout is 900s ON PURPOSE** (above the 600s
  kernel-runner cap). Per-window INJECT_KEY/INJECT_POINTER do NOT stamp the
  idle clock. Browser-test VT1 typing needs ~800ms between lines.
- **0095: EV_SNAP_DROP fires at every title-drag end THAT MOVED** (past the
  4px slop). Headless chrome gestures = `wmctl sdown/smove/sup` (screen
  coords). `SDL_Delay` THROWS in this runtime (no JSPI) — use `usleep`.
- **0093: the Recycle Bin icon sorts LAST on the desktop**; seeded desktop
  = 8 icons. **fileman hides dotfiles**. The ops core is `os/fileops.h`.
  AQ_CLICK prefers an ENABLED match (modal-over-modal drivable).
- **0091: `wmctl list` is Z-ORDERED — pick rows by sid.** Browser popup
  tests quiesce ~1.5s after the VT2 settle.
- **0090: browser keyboard pacing** — type with `{delay: 50-60}`; chords as
  explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes)` fires
  on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`). (2) Pause ~800ms after `&` jobs and after any typed line
  with `$(wmctl …)`. (3) The desktop tab is the DEFAULT after ready (0070)
  — `setVt(1)` before typing shell lines.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (`git diff --stat` should be
  empty). Hit again on 0104. Stage ONLY your own files; concurrent
  sessions exist.
- **`--filter` is single-valued** — passing it twice keeps only the LAST.
  Run separately.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`,
  `vendor/` are. Bump `image.json` `version` (now **64**) when an
  interactive browser tab must pick up seeded-source edits. Delete
  `os/os-system.img` + `os/os-root.img` to force a rebake.
- **New-runner habits**: check `build/test-*/summary.json` + per-file logs
  after an interrupted run; `--resume` picks up. Sweep is serial by design
  (0045). The kernel runner is a MANIFEST — new test files must be added to
  `tests` in run.js. `--filter` is a SUBSTRING on the file name.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. NB list order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0103's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item lists,
ONE flyout, gray rows never fire); 0092 (ops core header-only + shared; DnD
non-goal); 0093 (trash store layout; delete-in-store permanent; bin icon
pinned to grid TAIL); 0108 (sameboy IS the baked .gb/.gbc default); 0114's
calls (the OS is gucOS; OPFS image filenames stay `os-*.v5.img`); 0098's
calls (Start-menu root is a fixed two-pane panel); 0101's calls (the strip
menu is wm.c policy over the 0091 furniture); 0102's calls (the sysmenu is
the EV_CYCLE chord pattern; title-bar right-click deferred to 0116); 0103's
calls (F2 + icon-menu Rename cover the intent; the `desk_edit_armed` flag);
**0104's calls (IsDialogMessageW is the real dialog manager over
WM_GETDLGCODE, wired into BOTH modal loops; Enter=default-button /
Esc=IDCANCEL / Alt=mnemonic; ctldemo carries its own `.res` as the dialog
acceptance surface; notepad Save As rides the same generic path — its
comdlg32 dialog is a #32770, no bespoke work needed)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0104 dialog keyboard
just landed; 0105–0107 desktop-icon details/multi-select tail lead now,
then 0116 the title-bar right-click sysmenu; 0064 WM sweep round 3 owes the
operator the pointer-lock check, the 0094 sound listen, the 0095 snap feel,
the 0096 saver eyeball, and the 0101/0102/0103/0104 browser legs)."
