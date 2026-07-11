# Handoff — start of thread (updated 2026-07-11; 0094 sound scheme closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0094 (sound scheme) is CLOSED**; image is **v55**. Dev log
`logs/2026-07-11/0094-sound-scheme.md`; item at
`todos/done/0094-sound-scheme.md`; design record in WIN32.md's 0094
paragraph + CLAUDE.md's os/ section. What landed, in one breath: the OS
makes noise now — `os/sounds.h` (header-only scheme core: store =
first-existing of `~/.config/sounds`, `/etc/sounds`,
`/usr/share/sounds/scheme`; `none` per-event, `mute on` global), real
`PlaySound` in winmm.c, `MessageBeep`/MessageBox-icon beeps in user32.c,
the wm.c SystemStart boot chime, four SYNTHESIZED clips
(`tools/mksounds.js` → committed `os/sounds/*.wav`), a ctlpanel Sounds
applet (mute toggle + Test — "Sounds" ≠ "Sound", the volume knob), and a
kernel pump fix (dying streams with a stranded non-integer-ratio
resample tail now reclaim — was one leaked stream per one-shot clip).

**Verified**: `test_sounds_e2e` (16 checks) + full kernel suite green,
`os-sounds.mjs` browser ALL OK (chime pre-gesture in the output ring,
plays once on the resume gesture, About-box beep, applet mute/unmute).

**Follow-ups filed by 0094**: **0113** (P2, queue tail — preset schemes,
per-event applet UI, SND_LOOP: v1 plays looped clips ONCE; SND_RESOURCE
stays 0068's silent success deliberately). The **0064** operator
checklist grew the sound LISTEN check (clips are ring-math-verified but
nobody has heard them) next to the still-owed pointer-lock human check.

**Concurrent-session note**: 0112 (mGBA core) was added to the queue by
another session mid-thread (d60713f) — the wc-fork memory rule applies:
verify todos/ freshness, stage only your own files.

**Next in queue**: `node todos/queue.js list` — **0095 (Aero Snap)**
leads, then 0096 (screensaver), 0098 (Start menu Win7 pane), 0101,
0102, 0103, 0104, 0105, 0106 (fileman navigator v2), 0111 (win32
cmdline abs-path), 0107 (paint), … tail: 0113, 0112.
**Do NOT pipe `queue.js list` through `head`** — EPIPE crash (known,
harmless, noisy; fix is 0099).

## Gotchas carried forward (trimmed to the live ones)

- **0094 NEW: `SDL_Delay` THROWS in this runtime** (no JSPI — the host
  import is `sdlDelayUnsupported`). Blocking waits in veneer/app code
  use `usleep`. Bit the PlaySound SND_SYNC path mid-thread.
- **0094 NEW: `SND_RESOURCE` (0x00040004) contains the SND_MEMORY bit**
  — test with `(flags & SND_RESOURCE) == SND_RESOURCE`, never truthy-`&`.
- **0094 NEW: browser-test audio asserts** — the wm worker boots ~1s
  AFTER `__osState === 'ready'`; WAIT for output-ring bytes
  (`__osAudioSab` words), don't sample instantly. The producer cursor
  (word 0) only moves when the mixer writes — it's the "did it play /
  is it muted" probe; the receiver drains only after a user gesture.
- **0094: mixer "dry" ≠ queued==0** — dying streams reclaim when they
  can't back another output frame (kernel.js pump snapshot loop); live
  streams keep their fractional tail. Don't "fix" a lingering 2-byte
  queued on a live stream.
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
  are. Bump `image.json` `version` (now **55**) when an interactive
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

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0094's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090 (clipboard = ONE kernel slot, format-tagged); 0091 (fixed item
lists, ONE flyout, gray rows never fire); 0092 (ops core header-only +
shared; DnD non-goal); 0093 (trash store layout; delete-in-store
permanent; bin icon pinned to grid TAIL); 0108 (sameboy IS the baked
.gb/.gbc default); **0094's calls (scheme store is openwith-shaped
first-existing whole-file; clips synthesized not vendored; SND_RESOURCE
silent success; SND_LOOP once until 0113; the chime is per-WM-START not
per-boot; host-browser clipboard/audio bridges stay unwired)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0095 Aero Snap
leads, then 0096/0098, 0101–0107, 0111; 0064 WM sweep round 3 owes the
pointer-lock human check AND now the 0094 sound listen)."
