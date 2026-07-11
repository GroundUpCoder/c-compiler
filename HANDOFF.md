# Handoff — start of thread (updated 2026-07-11; 0103 desktop icon rename closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0103 (desktop icon rename-in-place) is CLOSED**; image bumped **v62 →
v63** (seeded `wm.c` changed). Dev log
`logs/2026-07-11/0103-desktop-icon-rename.md`; item at
`todos/done/0103-desktop-icon-rename.md`. One breath: **F2** on a lone
desktop-icon selection — or the icon context menu's new **Rename** row —
opens a Win95 inline editor over the label (sunken white box + caret;
printable keys insert, Backspace deletes, **Enter commits `rename(2)`** on
`/root/Desktop`, **Esc cancels**, a desktop **click-away or focus-loss
commits**). Empty / `/`-bearing names and an **existing target (EEXIST —
both files kept)** leave the editor open; the 0077 `.icons` cell is carried
to the new name (`desk_icons_rename`); the **Recycle Bin is not renamable**.
All in `os/wm.c` (`desk_edit*`, the `draw_desk` editor box, the `CM_RENAME`
menu row) — no kernel change.

**The one subtlety — the focus race (see the dev log):** the icon-menu
Rename path dismisses the ctxmenu (which held focus) then re-focuses the
desktop; the teardown can emit a **transient EV_FOCUS to an app window**
before our `WMP_FOCUS(desk_sid)` lands, which a naive focus-loss commit
would use to close the just-opened editor. Gated by a **`desk_edit_armed`**
flag: `desk_edit_start` arms immediately on the F2 path (already focused)
but only on the **EV_FOCUS(desk)** echo for the menu path.

**Verified**: `node tests/kernel/run.js` **53/0** over a fresh v63 bake.
New rename leg in `test_wm_service_e2e.js` (F2 rename aaa→zzz,
EEXIST-keeps-both, Esc-cancel-untouched, icon-menu Rename aab→mmm). The
icon menu grew a row (**120x96 → 120x116**), so `test_ctxmenu_e2e.js` and
`test_recycle_e2e.js` geometry asserts were bumped (DELETE's row Y is
unchanged — their DELETE clicks still land).

**Manual browser tier NOT run this session** (no Playwright in this env):
`tests/browser/os-shell.mjs` grew a 0103 leg (F2 opens the white editor
box via a teal→white pixel transition, retype, the grid relabels, verified
on disk). **The operator should run `node tests/browser/os-sweep.mjs
--filter=os-shell` to eyeball it** — same standing as the 0102 os-wm leg.

**Descoped by design (no follow-up filed):** the click-pause-click rename
gesture the 0103 plan listed as *optional* — F2 + menu Rename fully cover
the rename-in-place intent, and slow-double-click-to-rename is a Win95
foot-gun.

**Next in queue**: `node todos/queue.js list` — 0104–0107 (desktop-icon
details/multi-select tail), 0112, … 0116 (title-bar right-click sysmenu),
0109/0110 (were "after 0103", now unblocked). 0064 (WM sweep round 3) still
owes the operator the pointer-lock human check, the 0094 sound listen, the
0095 snap feel, the 0096 saver eyeball, the 0101 taskbar browser leg, the
0102 os-wm leg, and now the 0103 os-shell leg.

## Gotchas carried forward (trimmed to the live ones)

- **0103: the icon menu is now 6 rows (120x116)** — OPEN / --- / CUT / COPY
  / DELETE / **RENAME**. RENAME was appended, so OPEN(row0)/DELETE(row4,
  y=82) keep their Y; only the total height changed. The inline editor is a
  `desk_edit >= 0` modal branch in `desk_key` + a white box in `draw_desk`
  (it `continue`s past the normal label draw). `desk_load`/`make_desk` bail
  or reset while `desk_edit >= 0` so the index can't go stale.
- **0102: the sysmenu popup IS the key grabber** — during Move/Size the
  "ctxmenu" window stays up and holds focus. `ctx_key` Down skips SEP but
  NOT GRAY. Row Y math: rows 0–4 are 20px, then an 8px SEP, then CLOSE.
- **0101: the clock moved 14px LEFT** (Show Desktop sliver took the far
  right). Sample the clock cell against `clock_left() = bar_w - SHOWDESK_W -
  CLOCK_W`. A clicked (pinned) datepop lingers until clicked away.
- **0098: recents only record launches THROUGH the wm** (`activate()`) — a
  shell `winbox &` does NOT. Left-pane geometry is FIXED (290×234); clear
  `~/.config/recent` to make it deterministic. Esc from a FLYOUT closes the
  whole menu; headless flyout nav backs out with **Left**, not Esc.
- **0114: OPFS image filenames stayed `os-*.v5.img`** — content is
  version-gated, so persistent browser images re-fetch on a version bump
  without orphaning root volumes. The 5×7 wm.c font is A–Z uppercase-only
  (+ digits, `-`, `.`) — the rename editor uppercases its display too.
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
  `done`, `git add todos/done/<file>` again (`git show :todos/done/<file>`
  to confirm). Hit again on 0103. Stage ONLY your own files; concurrent
  sessions exist.
- **`--filter` is single-valued** — passing it twice keeps only the LAST
  (`--filter=ctxmenu --filter=recycle` ran recycle only). Run separately.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **63**) when an interactive browser
  tab must pick up seeded-source edits. Delete `os/os-system.img` +
  `os/os-root.img` to force a rebake after a shared-source change.
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0102's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item lists,
ONE flyout, gray rows never fire); 0092 (ops core header-only + shared; DnD
non-goal); 0093 (trash store layout; delete-in-store permanent; bin icon
pinned to grid TAIL); 0108 (sameboy IS the baked .gb/.gbc default); 0114's
calls (the OS is gucOS; OPFS image filenames stay `os-*.v5.img`); 0098's
calls (Start-menu root is a fixed two-pane panel); 0101's calls (the strip
menu is wm.c policy over the 0091 furniture); 0102's calls (the sysmenu is
the EV_CYCLE chord pattern; Move/Size are wm.c-side modal arrow-key states
with the popup held up as the key grabber; title-bar right-click deferred
to 0116); **0103's calls (F2 + icon-menu Rename cover the intent —
click-pause-click descoped; the editor is a wm.c-side modal in `desk_key`
with no EDIT control; EEXIST keeps both files and leaves the editor open;
the `desk_edit_armed` flag is load-bearing for the menu-path focus race)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0103 desktop-icon
rename just landed; 0104–0107 desktop-icon details/multi-select tail lead
now, then 0116 the title-bar right-click sysmenu; 0064 WM sweep round 3
owes the operator the pointer-lock check, the 0094 sound listen, the 0095
snap feel, the 0096 saver eyeball, the 0101 taskbar leg, the 0102 os-wm
leg, and the 0103 os-shell leg)."
