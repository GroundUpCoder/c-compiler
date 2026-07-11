# Handoff — start of thread (updated 2026-07-11; 0096 screensaver closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0096 (screensaver) is CLOSED**; image is **v57**. Dev log
`logs/2026-07-11/0096-screensaver.md`; item at
`todos/done/0096-screensaver.md`; design record in WM.md "Implementation
status — screensaver" + CLAUDE.md's os/ section. One breath: leave the
desktop alone for the configured idle interval and /bin/wm covers the
screen with a classic — scrolling marquee or starfield — dismissed by any
input, focus restored. The 0025/0032/0095 mechanism/policy split again:
the kernel only stamps `_wmLastInput` at wmKey/wmPointer and answers WMP
GET_IDLE 0x1E → R_IDLE 0x44 (`wmctl idle`; new reply TYPE so wm.c's
fire-and-forget drain routes it — the R_SHOT precedent) plus SAVER 0x1F →
EV_SAVER 0x90 (`wmctl saver` = the ctlpanel Preview event, EV_MENU
rules); wm.c owns the timeout, the config store (os/saver.h —
~/.config/screensaver → /etc → baked /usr/share; saver/timeout/text;
default starfield/900s), the fullscreen top-layer focus-KEEPING
"screensaver" window, and the marquee/starfield draw routines. The
Control Panel grew a Screen Saver applet (radios + Apply write the store
with carry-forward; Preview raises it live).

**Verified**: `test_saver_e2e` (25 checks, registered in run.js) + FULL
kernel suite green (53/53 incl. the new file), `os-saver.mjs` browser ALL
OK (real idle → black + row-diff animation probe, mouse dismissal, no
re-raise inside a fresh interval, wmctl-saver + key dismissal), plus
os-wm/os-shell re-run green after the wm.c frame-loop changes.

**Follow-ups filed by 0096**: **0115** (Mystify + 3D-pipes savers, P3
tail) and one more operator entry on the **0064** checklist (saver
look-and-feel: star density/speed, marquee zoom/legibility, applet
sanity). Recorded trims (WM.md + dev log, deliberately un-queued):
EV_SCREEN dismisses the saver instead of re-fitting (idle re-raises);
hidden-tab vsync parking pauses the animation (0100 honest-pause); VT1
tty typing is not wm input so it never feeds the idle clock.

**Next in queue**: `node todos/queue.js list` — a concurrent session
reordered mid-thread: **0111 (win32 cmdline abs-path)** leads, then 0099
(queue.js EPIPE quick win), 0114 (gucOS rebrand — queued deliberately
right after 0096), 0098 (Start menu Win7 pane), 0101–0107, … tail:
0113, 0112, 0115.
**Do NOT pipe `queue.js list` through `head`** — EPIPE crash (known,
harmless, noisy; fix is 0099).

## Gotchas carried forward (trimmed to the live ones)

- **0096 NEW: the saver default timeout is 900s ON PURPOSE** — above the
  600s kernel-runner cap, so no headless e2e can have the saver raise
  mid-test. Tests that want it write a short `~/.config/screensaver`.
  Also: per-window INJECT_KEY/INJECT_POINTER do NOT stamp the idle clock
  (only wmKey/wmPointer paths do, INJECT_SCREEN included) — agent pokes
  don't wake it, and `wmctl smove` is the headless dismiss-and-reset.
- **0096 NEW: SET_LAYER's stable normalize does NOT raise** — a window
  entering the +1 band lands UNDER earlier top-layer windows (the
  taskbar). Furniture that must cover the bar needs an explicit
  FOCUS/raise after SET_LAYER (the saver does; the start menu never
  overlaps the bar so it never noticed).
- **0096 NEW: browser-test VT1 typing needs ~800ms between lines** — the
  next command's first keystroke races the returning prompt ("rintf").
  And VT1 typing is tty input, invisible to the wm idle clock — jiggle
  the mouse on VT2 to arm a known-fresh idle interval (os-saver.mjs is
  the pattern).
- **0095: EV_SNAP_DROP fires at every title-drag end THAT MOVED** (past
  the 4px WM_SNAP_SLOP; edge 0 = drag-off) with a WM subscribed; a
  motionless title click emits nothing. Scripted-WM tests with a moving
  title drag must consume the extra frame after the drag-end EV_MOVED.
- **0095: headless chrome gestures = `wmctl sdown/smove/sup`** (screen
  coords, full hit-test path); `wmctl drag` (0077) is client-local and
  can never grab a title bar. The Win chord swallows GUI+arrow but NOT
  the GUI keydown (winbox flips fill once per chord).
- **0094: `SDL_Delay` THROWS in this runtime** (no JSPI) — blocking waits
  use `usleep`. Browser audio asserts wait on `__osAudioSab` words.
- **0108: the openwith default.gui leg is loose on purpose** — the
  file-load half is broken until 0111 (fix the veneer, not the test).
- **0093: the Recycle Bin icon sorts LAST on the desktop**; seeded
  desktop = 8 icons. **fileman hides dotfiles** — drive tests into dot
  dirs via `wmctl settext EDIT:0 <path>` + Go.
- **0092: the fileman ops core is `os/fileops.h`** — new file ops go
  THERE. AQ_CLICK prefers an ENABLED match (modal-over-modal drivable).
- **0091: `wmctl list` is Z-ORDERED — pick rows by sid.** Browser popup
  tests quiesce ~1.5s after the VT2 settle or a late EV_SCREEN dismisses
  the popup.
- **0090: browser keyboard pacing** — type with `{delay: 50-60}`; chords
  as explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes)`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`). (2) Pause ~800ms after `&` jobs and after any typed
  line with `$(wmctl …)` — both race the prompt. (3) The desktop tab is
  the DEFAULT after ready (0070) — `setVt(1)` before typing shell lines.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (`git show :todos/done/<file>`
  to confirm). Stage ONLY your own files; concurrent sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **57**) when an interactive
  browser tab must pick up seeded-source edits. Delete `os/os-system.img`
  + `os/os-root.img` to force a rebake after a shared-source change
  (user32, fileops.h, sounds.h, saver.h, …) or the fixture serves a stale
  binary.
- **New-runner habits**: check `build/test-*/summary.json` + per-file
  logs after an interrupted run; `--resume` picks up. Sweep is serial by
  design (0045). The kernel runner is a MANIFEST — new test files must
  be added to `tests` in run.js or they silently never run.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. NB list order is PRIORITY-BUCKETED (P0–P3) — a P2 item
  ignores `--pos` relative to P1s.
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0096's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item
lists, ONE flyout, gray rows never fire); 0092 (ops core header-only +
shared; DnD non-goal); 0093 (trash store layout; delete-in-store
permanent; bin icon pinned to grid TAIL); 0094's calls (scheme store is
openwith-shaped first-existing whole-file; clips synthesized not
vendored; SND_LOOP once until 0113); 0108 (sameboy IS the baked
.gb/.gbc default); 0095's calls (snap is mechanism/policy split; a click
is not a drag; top snap IS the 0025 maximized state; drag-off restores
at release; halves/quarters only); **0096's calls (the idle clock is
kernel mechanism, the timeout is wm.c policy; the saver KEEPS focus —
that's the dismissal mechanism; store is the openwith/sounds shape;
default 900s protects the test suite; no lock screen, no .scr plug-ins,
no GPU savers — Mystify/pipes live in 0115)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0111 win32
cmdline abs-path leads, then 0099, 0114 gucOS rebrand, 0098; 0064 WM
sweep round 3 owes the pointer-lock human check, the 0094 sound listen,
the 0095 snap feel, and now the 0096 saver eyeball)."
