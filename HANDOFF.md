# Handoff — start of thread (updated 2026-07-11; 0098 Start-menu Win7 two-pane closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0098 (Start menu: Win7 two-pane stage) is CLOSED**; image bumped
**v59 → v60** (seeded `wm.c` changed). Dev log
`logs/2026-07-11/0098-start-menu-win7-two-pane.md`; item at
`todos/done/0098-start-menu-win7-pane.md`. One breath: the Start menu's
ROOT ("startmenu") is now a fixed **290×234 two-pane panel** — LEFT pane =
pinned (`~/.config/pinned`) + **MRU recents** (`~/.config/recent`, pushed
by the shared `activate()` on every real launch, dedup, cap 8) + an **All
Programs** row, with a **live search box** at its foot that filters a flat
recursive walk of the menu tree (Enter launches the top hit; the root
holds kernel focus so typing goes to search). RIGHT pane = the fixed
places (SETTINGS → /bin/ctlpanel, RUN… → the "startrun" dialog). **All
Programs** cascades the tree via the unchanged 0078 flyout machinery —
startmenu2 lists the GROUPS, startmenu3 a group's leaves (one level deeper
than 0078). The Win95 **sidebar band** and below-programs
separator/fixed-section are **gone** (`draw_vtext_s` deleted). All in
`os/wm.c` only — no kernel/protocol change; `mcol[0]` still owns the root
WINDOW, only its contents moved to the `sm_*` globals, so EV_CREATED park,
`menu_owns_sid`, EV_FOCUS dismiss, and the Ctrl+Esc chord all work
verbatim.

**Verified**: `node tests/kernel/run.js` **53/0** (over a fresh v60 bake),
`node tests/browser/os-shell.mjs` **PASS (61 ok)**, `node
tests/kernel/test_ctxmenu_e2e.js` PASS. The two big Start-menu test files
(`test_wm_service_e2e.js`, `os-shell.mjs`) were rewritten for the two-pane
geometry.

**Follow-ups filed by 0098**: none (non-goals — jump lists / tiles /
fs-search / menu glass — recorded, not built).

**Next in queue**: `node todos/queue.js list` — **0101 (taskbar-strip
context menu)** leads now, then 0102–0107 (context-menu tail + desktop-icon
rename + details view), 0112, … 0064 (WM sweep round 3) still owes the
operator the pointer-lock human check, the 0094 sound listen, the 0095 snap
feel, and the 0096 saver eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0098: recents only record launches THROUGH the wm** (`activate()`) — a
  shell `winbox &` does NOT. Tests wanting a recent must launch via the
  menu or desktop. Left-pane geometry is FIXED (290×234, 10 left rows +
  search box) so it never shifts with the recents count — clear
  `~/.config/recent` to make the left pane deterministic ([All Programs] at
  row 0).
- **0098: Esc from within a FLYOUT still closes the whole menu** (the 0078
  rule); only Esc from the root-with-a-search clears-then-closes. Headless
  flyout nav must back out with **Left**, not Esc. The search highlight
  paints the row navy with WHITE text — sample the navy background PAST the
  label (x≈100), not over the glyphs.
- **0098: the two-pane legs spawn several winboxes** (recents/search/
  override launches); `os-shell.mjs` closes them all before the desktop
  section so term is the sole taskbar button. A browser helper reading
  `window.__osOut` must go through `page.evaluate`, not Node scope.
- **0114: OPFS image filenames stayed `os-*.v5.img`** — the store format
  didn't change, only version-gated content, so persistent browser images
  re-fetch on a version bump without orphaning root volumes. The 5×7 wm.c
  font is A–Z uppercase-only.
- **0111: `GetCommandLineW` args after argv0 are ALWAYS quoted** — any new
  port that hand-parses its command line must take the quote-strip path.
- **0096: the saver default timeout is 900s ON PURPOSE** (above the 600s
  kernel-runner cap). Per-window INJECT_KEY/INJECT_POINTER do NOT stamp the
  idle clock; `wmctl smove` is the headless dismiss-and-reset.
- **0096: SET_LAYER's stable normalize does NOT raise** — a window entering
  the +1 band lands UNDER earlier top-layer windows (the taskbar).
  Furniture that must cover the bar needs an explicit FOCUS/raise.
- **0096: browser-test VT1 typing needs ~800ms between lines**; VT1 typing
  is tty input, invisible to the wm idle clock.
- **0095: EV_SNAP_DROP fires at every title-drag end THAT MOVED** (past the
  4px slop); a motionless title click emits nothing.
- **0095: headless chrome gestures = `wmctl sdown/smove/sup`** (screen
  coords, full hit-test path); `wmctl drag` (0077) is client-local.
- **0094: `SDL_Delay` THROWS in this runtime** (no JSPI) — use `usleep`.
- **0093: the Recycle Bin icon sorts LAST on the desktop**; seeded desktop
  = 8 icons. **fileman hides dotfiles**.
- **0092: the fileman ops core is `os/fileops.h`**. AQ_CLICK prefers an
  ENABLED match (modal-over-modal drivable).
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
  to confirm). Hit again on 0098. Stage ONLY your own files; concurrent
  sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **60**) when an interactive browser
  tab must pick up seeded-source edits. Delete `os/os-system.img` +
  `os/os-root.img` to force a rebake after a shared-source change.
- **New-runner habits**: check `build/test-*/summary.json` + per-file logs
  after an interrupted run; `--resume` picks up. Sweep is serial by design
  (0045). The kernel runner is a MANIFEST — new test files must be added to
  `tests` in run.js. `--filter` is a SUBSTRING on the file name.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. NB list order is PRIORITY-BUCKETED (P0–P3). Since 0099 an
  unknown `--flag` exits 2 and `--help` is safe on every subcommand.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0096's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item lists,
ONE flyout, gray rows never fire); 0092 (ops core header-only + shared; DnD
non-goal); 0093 (trash store layout; delete-in-store permanent; bin icon
pinned to grid TAIL); 0094's calls; 0108 (sameboy IS the baked .gb/.gbc
default); 0095's calls; 0096's calls; 0111's call; 0099's calls; 0114's
calls (the OS is gucOS; OPFS image filenames stay `os-*.v5.img`);
**0098's calls (the Start-menu root is a fixed two-pane panel; recents +
pins live in `~/.config`; recents record only wm `activate()` launches;
All Programs cascades the tree via the unchanged 0078 flyouts; the Win95
sidebar band + separator/fixed-section are gone; jump lists/tiles/
fs-search/menu glass are non-goals)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0101 taskbar-strip
context menu leads now that 0098 Start-menu Win7 two-pane landed; 0064 WM
sweep round 3 owes the pointer-lock human check, the 0094 sound listen, the
0095 snap feel, and the 0096 saver eyeball)."
