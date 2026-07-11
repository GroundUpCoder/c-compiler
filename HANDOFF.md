# Handoff — start of thread (updated 2026-07-11; 0101 taskbar polish closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0101 (taskbar polish: strip menu, Show Desktop, clock date) is CLOSED**;
image bumped **v60 → v61** (seeded `wm.c` changed). Dev log
`logs/2026-07-11/0101-taskbar-polish.md`; item at
`todos/done/0101-taskbar-menu-show-desktop.md`. One breath: right-clicking
the taskbar strip (empty run / clock / Show-Desktop region — anything past
the Start strip that isn't a drawn button) now raises a **taskbar-strip
menu** — Cascade / Tile / Minimize All / Properties(→ctlpanel) — over the
0091 popup furniture (`ctx_open_taskbar`); Cascade/Tile are wm.c policy
loops (resizable → real MOVE+RESIZE uniform-box / near-square grid,
fixed-size → cascaded positions, **never sheared** — the 0021 rule). A
narrow **Show Desktop** sliver at the far right (`SHOWDESK_W`; the clock
now budgets against `clock_left() = bar_w - SHOWDESK_W - CLOCK_W`) toggles
minimize-all / restore, stashing the sids it minimized (`sd_stash`) so a
second click restores **exactly** that set (windows minimized before the
toggle stay down). Hovering (or clicking, agent parity) the clock raises a
**"datepop"** date tooltip (the Aero-Peek borderless mechanism — hover
idle-dismisses, click pins). Right-button routing at `bar_rclick`;
left-click byte-identical. All in `os/wm.c` — no kernel/protocol change.

**Verified**: `node tests/kernel/run.js` **53/0** over a fresh v61 bake,
with new 0101 legs in `test_wm_service_e2e.js` (strip-menu open, Minimize
All, Show Desktop toggle, Cascade uniform 614×427 box, datepop) and
`test_ctxmenu_e2e.js` updated (empty-bar right-click now opens the strip
menu — the Start strip is the surviving reserved slot).

**Manual browser tier NOT run this session** (no playwright in this env):
`tests/browser/os-shell.mjs` grew a taskbar-local 0101 leg (strip-menu
face, clock datepop face, Show Desktop sliver pressed/raised). **The
operator should run `node tests/browser/os-sweep.mjs` (or just
`os-shell.mjs`) to eyeball it** — same standing as 0064's pending checks.

**Follow-ups filed by 0101**: none (non-goals — Quick Launch strip,
notification tray, button grouping, moving the bar — recorded, not built).

**Next in queue**: `node todos/queue.js list` — **0102** leads now
(window system menu + keyboard move/resize, Alt+Space), then
0103–0107 (desktop-icon rename + details view), 0112, … 0064 (WM sweep
round 3) still owes the operator the pointer-lock human check, the 0094
sound listen, the 0095 snap feel, the 0096 saver eyeball, and now the 0101
browser leg.

## Gotchas carried forward (trimmed to the live ones)

- **0101: the clock moved 14px LEFT** (the Show Desktop sliver took the far
  right). Anything sampling the clock cell must budget against
  `clock_left() = bar_w - SHOWDESK_W - CLOCK_W`, not `bar_w - CLOCK_W`.
- **0101: a clicked (pinned) datepop lingers on the top layer** until
  clicked away — a left-click in the clock cell toggles it. Tests that click
  the clock to prove "no button" must toggle it back off, or a later z-order
  leg sees the datepop wedged under the bar.
- **0101: the ctx popup height is `2*MENU_PAD + Σrows`** (8 + Σ), not just
  Σrows — the 5-row strip/button menus are 96 tall, not 88.
- **0101: right-click the strip at a FIXED x is unsafe** when the button run
  is long — target the clock cell (always past the buttons); the strip menu
  clamps to the right edge (`x = scr_w - CTX_W`).
- **0098: recents only record launches THROUGH the wm** (`activate()`) — a
  shell `winbox &` does NOT. Left-pane geometry is FIXED (290×234); clear
  `~/.config/recent` to make it deterministic ([All Programs] at row 0).
- **0098: Esc from within a FLYOUT closes the whole menu**; only Esc from
  the root-with-a-search clears-then-closes. Headless flyout nav backs out
  with **Left**, not Esc.
- **0114: OPFS image filenames stayed `os-*.v5.img`** — content is
  version-gated, so persistent browser images re-fetch on a version bump
  without orphaning root volumes. The 5×7 wm.c font is A–Z uppercase-only
  (+ digits, `-`, `.`).
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
  to confirm). Hit again on 0101. Stage ONLY your own files; concurrent
  sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **61**) when an interactive browser
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0098's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item lists,
ONE flyout, gray rows never fire); 0092 (ops core header-only + shared; DnD
non-goal); 0093 (trash store layout; delete-in-store permanent; bin icon
pinned to grid TAIL); 0108 (sameboy IS the baked .gb/.gbc default); 0111's
call; 0114's calls (the OS is gucOS; OPFS image filenames stay
`os-*.v5.img`); 0098's calls (Start-menu root is a fixed two-pane panel);
**0101's calls (the strip menu is wm.c policy over the 0091 furniture;
Cascade/Tile never shear fixed-size windows; Show Desktop stashes by sid so
pre-toggle-minimized windows stay down; the date tooltip is the Aero-Peek
borderless mechanism; the Start strip stays the reserved bar slot, title
bars go to 0102)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0102 window system
menu / Alt+Space leads now that 0101 taskbar polish landed; 0064 WM sweep round
3 owes the pointer-lock check, the 0094 sound listen, the 0095 snap feel,
the 0096 saver eyeball, and now the 0101 browser leg)."
