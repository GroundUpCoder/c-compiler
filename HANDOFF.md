# Handoff — start of thread (updated 2026-07-11; 0102 window system menu closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0102 (window system menu + keyboard move/resize, Alt+Space) is CLOSED**;
image bumped **v61 → v62** (seeded `wm.c`/`wmctl.c` changed). Dev log
`logs/2026-07-11/0102-window-system-menu.md`; item at
`todos/done/0102-window-system-menu.md`. One breath: **Alt+Space** (or
`wmctl sysmenu`) raises the classic Win95 window system menu
(Restore/Move/Size/Minimize/Maximize/Close) on the FOCUSED window — the
fifth rider on the EV_CYCLE chord seam (**WMP EV_SYSMENU 0x91 / SYSMENU
0x33**, subscriber-gated, keyup swallowed, no-WM pass-through, carries the
focused sid). wm.c's `ctx_open_sysmenu` reuses the 0091 popup furniture
anchored at the window's top-left, rows grayed per state (**Size only on a
resizable window** — fixed-size scales by pointer, 0024). **Move/Size are a
wm.c-side modal arrow-key state machine** (`sys_mode`/`sys_target`/
`sys_x0..h0`): picking the row keeps the popup up as the **key grabber**
(its root holds kernel focus), `ctx_key` routes to `sys_key` while the mode
is live — arrows nudge 8px via ordinary MOVE/RESIZE, **Enter commits, Esc
reverts** to the stashed rect. Restore/Min/Max/Close reuse the existing
chrome ops. All in `kernel.js` (the chord + `wmSysMenu`) and `os/wm.c` — the
protocol trio (kernel.js WMP ↔ `os/wm_proto.h` ↔ `test_wm_policy.js`) is in
sync.

**Verified**: `node tests/kernel/run.js` **53/0** over a fresh v62 bake,
with new legs in `test_wm_policy.js` (EV_SYSMENU chord round-trip) and
`test_wm_service_e2e.js` (real wm.c: sysmenu opens, Move+arrows relocate
+32/+16 & Enter commits, Esc reverts, Size grows the resizable winbox
+32/+32, Size disabled on fixbox, Close tears down).

**Manual browser tier NOT run this session** (no Playwright in this env):
`tests/browser/os-wm.mjs` grew a 0102 leg (Alt+Space opens the menu via a
VT1 wmctl check + fill-unchanged swallow proof, keyboard-only Move commits,
Close via the menu, and no-WM Alt+Space reaches the app). **The operator
should run `node tests/browser/os-sweep.mjs --filter=os-wm` to eyeball it**
— same standing as 0064's pending checks.

**Follow-up filed by 0102**: **todos/0116** — title-bar right-click to raise
the same sysmenu (the plan's "defer to keep this keyboard-only" option;
reuses EV_SYSMENU verbatim, so it's a clean standalone add).

**Next in queue**: `node todos/queue.js list` — 0103–0107 (desktop-icon
rename + details view), 0112, … 0116 (the title-bar right-click follow-up),
0064 (WM sweep round 3) still owes the operator the pointer-lock human
check, the 0094 sound listen, the 0095 snap feel, the 0096 saver eyeball,
the 0101 taskbar browser leg, and now the 0102 os-wm leg.

## Gotchas carried forward (trimmed to the live ones)

- **0102: the sysmenu popup IS the key grabber** — during Move/Size the
  "ctxmenu" window stays up (`wmctl list | grep ctxmenu$` present) and holds
  focus; injected keys target its sid. The popup stays VISIBLE during the
  mode (recorded v1 simplification — no rubber-band outline). `ctx_key` Down
  skips SEP but NOT GRAY, so nav lands on grayed rows (Enter there no-ops):
  Down×2 → MOVE, Down×6 → CLOSE.
- **0102: sysmenu row Y math** — rows 0–4 are 20px, then an 8px SEP, then
  CLOSE, so CLOSE's center is `4 + 5*20 + 8 + 10 = 122` (the e2e's
  `rowYsys(i)` handles the sep). `wmctl key` sends down THEN up; only the
  down edge nudges (one `wmctl key` = one 8px step).
- **0101: the clock moved 14px LEFT** (Show Desktop sliver took the far
  right). Sample the clock cell against `clock_left() = bar_w - SHOWDESK_W -
  CLOCK_W`, not `bar_w - CLOCK_W`. A clicked (pinned) datepop lingers until
  clicked away — toggle it back off in tests. The ctx popup height is
  `2*MENU_PAD + Σrows` (8 + Σ). Right-click the strip at the CLOCK cell
  (always past the buttons), not a fixed x.
- **0098: recents only record launches THROUGH the wm** (`activate()`) — a
  shell `winbox &` does NOT. Left-pane geometry is FIXED (290×234); clear
  `~/.config/recent` to make it deterministic. Esc from a FLYOUT closes the
  whole menu; headless flyout nav backs out with **Left**, not Esc.
- **0114: OPFS image filenames stayed `os-*.v5.img`** — content is
  version-gated, so persistent browser images re-fetch on a version bump
  without orphaning root volumes. The 5×7 wm.c font is A–Z uppercase-only
  (+ digits, `-`, `.`).
- **0096: the saver default timeout is 900s ON PURPOSE** (above the 600s
  kernel-runner cap). Per-window INJECT_KEY/INJECT_POINTER do NOT stamp the
  idle clock; `wmctl smove` is the headless dismiss-and-reset. SET_LAYER's
  stable normalize does NOT raise — a window entering the +1 band lands
  UNDER earlier top-layer windows (the taskbar); furniture that must cover
  the bar needs an explicit FOCUS/raise. Browser-test VT1 typing needs
  ~800ms between lines (tty input, invisible to the wm idle clock).
- **0095: EV_SNAP_DROP fires at every title-drag end THAT MOVED** (past the
  4px slop); a motionless title click emits nothing. Headless chrome
  gestures = `wmctl sdown/smove/sup` (screen coords); `wmctl drag` (0077) is
  client-local. `SDL_Delay` THROWS in this runtime (no JSPI) — use `usleep`.
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
  to confirm). Hit again on 0102. Stage ONLY your own files; concurrent
  sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **62**) when an interactive browser
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0101's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item lists,
ONE flyout, gray rows never fire); 0092 (ops core header-only + shared; DnD
non-goal); 0093 (trash store layout; delete-in-store permanent; bin icon
pinned to grid TAIL); 0108 (sameboy IS the baked .gb/.gbc default); 0114's
calls (the OS is gucOS; OPFS image filenames stay `os-*.v5.img`); 0098's
calls (Start-menu root is a fixed two-pane panel); 0101's calls (the strip
menu is wm.c policy over the 0091 furniture; Cascade/Tile never shear
fixed-size windows; Show Desktop stashes by sid); **0102's calls (the
sysmenu is the EV_CYCLE chord pattern; Move/Size are wm.c-side modal
arrow-key states with the popup held up as the key grabber; the popup stays
VISIBLE during the mode — no rubber-band outline; Size disabled on
fixed-size windows; title-bar right-click deferred to 0116)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0102 window system
menu just landed; 0103–0107 desktop-icon rename + details view lead now,
then 0116 the title-bar right-click follow-up; 0064 WM sweep round 3 owes
the pointer-lock check, the 0094 sound listen, the 0095 snap feel, the 0096
saver eyeball, the 0101 taskbar browser leg, and the 0102 os-wm leg)."
