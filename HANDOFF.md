# Handoff — start of thread (updated 2026-07-11; 0099 queue.js CLI hardening closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0099 (queue.js: --help must print usage, not scaffold) is CLOSED**; image
stays **v58** (no bake inputs touched — queue.js/tests/docs only). Dev log
`logs/2026-07-11/0099-queuejs-help-flag.md`; item at
`todos/done/0099-queuejs-help-flag.md`. One breath: `-h`/`--help` anywhere
in argv now prints usage and exits 0 BEFORE dispatch (an `add --help` can
never scaffold an "untitled" item again); every subcommand parses flags
against an allowlist, so an unknown `--flag` is a usage error — exit 2,
nothing written (the root cause: mutation commands no longer guess); and
`list | head` no longer crashes — EPIPE from an early-closing consumer is
treated as normal termination. Contract in queue.js's header + README §1.

**Verified**: `node todos/queue.test.js` 22/22 (3 new cases, each checked
to FAIL on the pre-fix CLI — the EPIPE test needs >64KB output and stderr
captured OUTSIDE the pipeline or it passes vacuously; the dev log records
both traps); acceptance re-run in the real repo, `check` OK on close.

**Follow-ups filed by 0099**: none.

**Next in queue**: `node todos/queue.js list` (piping through `head` is
fine now) — **0114 (gucOS rebrand)** leads (queued deliberately right
after 0096), then 0098 (Start menu Win7 pane), 0101–0107, … tail: 0113,
0112, 0115.
0064 (WM sweep round 3) still owes the operator the pointer-lock human
check, the 0094 sound listen, the 0095 snap feel, and the 0096 saver
eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0111: `GetCommandLineW` args after argv0 are ALWAYS quoted** —
  any new port that hand-parses its command line must take the
  quote-strip path (notepad's `cmdline[0]=='"'` branch is the pattern);
  the wwinmain.c shim already handles a quoted argv0.
- **0096: the saver default timeout is 900s ON PURPOSE** — above the
  600s kernel-runner cap, so no headless e2e can have the saver raise
  mid-test. Tests that want it write a short `~/.config/screensaver`.
  Also: per-window INJECT_KEY/INJECT_POINTER do NOT stamp the idle clock
  (only wmKey/wmPointer paths do, INJECT_SCREEN included) — agent pokes
  don't wake it, and `wmctl smove` is the headless dismiss-and-reset.
- **0096: SET_LAYER's stable normalize does NOT raise** — a window
  entering the +1 band lands UNDER earlier top-layer windows (the
  taskbar). Furniture that must cover the bar needs an explicit
  FOCUS/raise after SET_LAYER (the saver does; the start menu never
  overlaps the bar so it never noticed).
- **0096: browser-test VT1 typing needs ~800ms between lines** — the
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
  are. Bump `image.json` `version` (now **58**) when an interactive
  browser tab must pick up seeded-source edits. Delete `os/os-system.img`
  + `os/os-root.img` to force a rebake after a shared-source change
  (user32, fileops.h, sounds.h, saver.h, kernel32.c, …) or the fixture
  serves a stale binary.
- **New-runner habits**: check `build/test-*/summary.json` + per-file
  logs after an interrupted run; `--resume` picks up. Sweep is serial by
  design (0045). The kernel runner is a MANIFEST — new test files must
  be added to `tests` in run.js or they silently never run. `--filter`
  is a SUBSTRING on the file name, not a regex.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. NB list order is PRIORITY-BUCKETED (P0–P3) — a P2 item
  ignores `--pos` relative to P1s. Since 0099 an unknown `--flag` exits 2
  and `--help` is safe on every subcommand.
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
at release; halves/quarters only); 0096's calls (the idle clock is
kernel mechanism, the timeout is wm.c policy; the saver KEEPS focus —
that's the dismissal mechanism; store is the openwith/sounds shape;
default 900s protects the test suite; no lock screen, no .scr plug-ins,
no GPU savers — Mystify/pipes live in 0115); 0111's call (cmdline
quoting is the veneer's job — every arg after argv0 quoted; ports keep
their Windows `/`-option parsers unpatched); **0099's calls (usage
errors exit 2 vs validation's 1; help is checked before dispatch,
"anywhere in argv" on purpose; EPIPE on stdout/stderr = exit 0)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0114 gucOS rebrand
leads, then 0098 Start menu Win7 pane; 0064 WM sweep round 3 owes the
pointer-lock human check, the 0094 sound listen, the 0095 snap feel, and
the 0096 saver eyeball)."
