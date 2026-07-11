# Handoff — start of thread (updated 2026-07-11; 0095 Aero Snap closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0095 (Aero Snap) is CLOSED**; image is **v56**. Dev log
`logs/2026-07-11/0095-aero-snap.md`; item at
`todos/done/0095-aero-snap.md`; design record in WM.md "Implementation
status — Aero Snap" + CLAUDE.md's os/ section. One breath: drag a title
bar to a screen edge and a translucent preview (an 0063 alpha window,
"snappreview") shows the tile — drop commits left/right halves, corner
quarters, top = the 0025 maximize; drag a snapped window off and its
floating size restores at the release; Win+arrow does halves (wrap-
across), maximize, restore/minimize from the keyboard. Mechanism/policy
split per 0025/0032: the kernel only reports zones and drops (WMP
EV_SNAP_EDGE / EV_SNAP_DROP {sid,edge,preX,preY} / EV_SNAP_KEY, SNAP =
`wmctl snap`), wm.c owns all state + geometry. NEW agent tier: `wmctl
sdown|smove|sup|sdrag` (WMP INJECT_SCREEN) injects SCREEN coords through
the full wmPointer chrome path — the first headless driver for title
drags; the kernel drag state is global, so separate wmctl calls compose
a held-open drag (mid-drag `wmctl list`/`shot screen` works).

**Verified**: `test_snap_e2e` (22 checks, registered in run.js) + FULL
kernel suite green (52/52 incl. the new file), `os-snap.mjs` browser
ALL OK (real-mouse edge drags with the preview pixel-asserted mid-drag
via exact 0063 src-over values, Meta+arrow chords);
os-wm/os-scale/os-shell re-run green after the title_activate refactor
— the re-run is what caught the click-is-not-a-drag bug (see gotchas).

**Follow-ups filed by 0095**: none queued — the **0064** operator
checklist grew the snap FEEL check (zone size, preview latency, the
at-release drag-off) next to the pointer-lock and sound-listen checks.
Recorded simplifications (WM.md + dev log, deliberately un-queued):
drag-off restores at RELEASE not mid-drag; border-resize of a snapped
window keeps the snap state; corner zones are 8x8px.

**Next in queue**: `node todos/queue.js list` — **0096 (screensaver)**
leads, then 0098 (Start menu Win7 pane), 0101, 0102, 0103, 0104, 0105,
0106 (fileman navigator v2), 0111 (win32 cmdline abs-path), 0107
(paint), … tail: 0113, 0112.
**Do NOT pipe `queue.js list` through `head`** — EPIPE crash (known,
harmless, noisy; fix is 0099).

## Gotchas carried forward (trimmed to the live ones)

- **0095 NEW: EV_SNAP_DROP fires at every title-drag end THAT MOVED**
  (past the kernel's 4px WM_SNAP_SLOP; edge 0 = the drag-off signal) with
  a WM subscribed. A motionless title click emits nothing — without that
  gate the dblclick's first click drag-off-restored maximized windows
  (bit os-wm/os-scale mid-thread). A scripted-WM test whose title drag
  moves must consume the extra frame after the drag-end EV_MOVED.
- **0095 NEW: the Win chord swallows GUI+arrow, NOT the GUI key** —
  the Meta/Win keydown still reaches the focused app (winbox toggles
  its fill on any keydown: one orange↔green flip per chord; os-snap.mjs
  tracks the parity).
- **0095 NEW: headless chrome gestures = `wmctl sdown/smove/sup`**
  (screen coords, full hit-test path). `wmctl drag` (0077) remains
  client-local post-hit-test injection — it can never grab a title bar.
- **0094: `SDL_Delay` THROWS in this runtime** (no JSPI). Blocking waits
  in veneer/app code use `usleep`.
- **0094: browser-test audio asserts** — wait for output-ring bytes
  (`__osAudioSab` words), don't sample instantly; producer cursor
  (word 0) is the "did it play" probe.
- **0108: the openwith default.gui leg is loose on purpose** —
  `/Notepad$/` only guards launch; the file-load half is broken until
  0111 (fix the veneer, not the test).
- **0093: the Recycle Bin icon sorts LAST on the desktop**; seeded
  desktop = 8 icons. **fileman hides dotfiles** — drive tests into dot
  dirs via `wmctl settext EDIT:0 <path>` + Go.
- **0092: the fileman ops core is `os/fileops.h`** — new file ops go
  THERE. AQ_CLICK prefers an ENABLED match (modal-over-modal drivable).
- **0091: `wmctl list` is Z-ORDERED — pick rows by sid.** Browser popup
  tests quiesce ~1.5s after the VT2 settle or a late EV_SCREEN
  dismisses the popup.
- **0090: browser keyboard pacing** — type with `{delay: 50-60}`; chords
  as explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes)`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`). (2) Pause ~800ms after `&` jobs and after any typed
  line with `$(wmctl …)` — both race the prompt.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (`git show :todos/done/<file>`
  to confirm). Stage ONLY your own files; concurrent sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **56**) when an interactive
  browser tab must pick up seeded-source edits. Delete `os/os-system.img`
  + `os/os-root.img` to force a rebake after a shared-source change
  (user32, fileops.h, sounds.h, …) or the fixture serves a stale binary.
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0095's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item
lists, ONE flyout, gray rows never fire); 0092 (ops core header-only +
shared; DnD non-goal); 0093 (trash store layout; delete-in-store
permanent; bin icon pinned to grid TAIL); 0094's calls (scheme store is
openwith-shaped first-existing whole-file; clips synthesized not
vendored; SND_LOOP once until 0113); 0108 (sameboy IS the baked
.gb/.gbc default); **0095's calls (snap is mechanism/policy split — the
kernel keeps NO snap state and commits NO geometry; EV_SNAP_DROP on
every drag end that MOVED past the slop — a click is not a drag; top
snap IS the 0025 maximized state, one shared
floating rect; drag-off restores at release; halves/quarters only — no
Win11 zones, no multi-monitor, shake-to-minimize stays 0076)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0096 screensaver
leads, then 0098, 0101–0107, 0111; 0064 WM sweep round 3 owes the
pointer-lock human check, the 0094 sound listen, and now the 0095 snap
feel check)."
