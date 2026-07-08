# Handoff — start of thread (updated 2026-07-08, after the queue/design docs round)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

Code is unchanged since the desktop-shell round 0028–0033 landed
(2026-07-08; all suites green at that landing — unit 697✓, blockfs✓,
kernel✓, full serial browser sweep incl. os-shell.mjs✓, storms clean;
image.json is **v25**). The thread after it was **docs/queue only**
(commit `3f1e9a1`, dev log `logs/2026-07-08/disk-image-design.md`):

- **0038 queued** — WM known-issues fixes: the one fixable 0033 finding
  (taskbar not always-on-top) graduated off WM.md's standing list; fix
  shape (wm.c re-raise policy vs kernel layer bit) decided in-item,
  test-first.
- **0039 queued** — WM bug sweep round 2 per the repeatable 0033 format;
  MUST include the pointer-lock HUMAN check round 1 skipped, plus
  re-verifying 0038 under storm.
- **DISK-IMAGE.md landed (design, settled) + 0040 queued** — the
  read-only system image: mkimage-baked RO blob mounted at /usr,
  merged-usr `/bin → /usr/bin`, `/usr/local → /var/local`,
  systemd-style /etc (defaults in /usr/share, empty /etc boots,
  factory reset = wipe /etc+/var), upgrade = swap the blob. Subsumes
  the old unnumbered mkimage entry; decisions are SETTLED — don't
  re-litigate (overlayfs copy-up explicitly rejected).

## The queue (todos/README.md is authoritative)

Next up: `0038` WM known-issues fixes, `0039` WM sweep round 2, then
`0034` coreutils batch 2, `0035` spawn-capable applets, `0036` seed the
REPLs, `0037` wasm module cache, the WebGPU app port (WEBGPU.md), and
`0040` read-only system image (DISK-IMAGE.md). (`0006` threads+atomics
stays deferred indefinitely.)

## Gotchas carried forward (0038/0039 will hit these)

- Browser pixel tests: "empty desktop" asserts must tolerate the 0029
  icon grid, and the desktop layer's teal is IDENTICAL to the
  compositor background teal — assert the layer via icons or `wmctl
  list`, never fill color.
- hush `kill` is cooperative SIGTERM: after killing the wm, barrier on
  its surfaces vanishing (taskbar pixel → teal) before asserting no-WM
  behavior — the subscription outlives the kill by a beat.
- Taskbar button coordinates sit right of the 50px Start button
  (button 0 spans x 56..160 at ≤8 windows); ≥9 windows at 1024 shrink
  them (btn_width()).
- wm.c wins[] is launch order (compaction since 0031) — button index ↔
  creation order; sids ascend with creation.
- Double-click detection needs `opts.t` timestamps in tests; wm.c work
  area is `scr_w x (scr_h - BAR_H - TITLE_H)` at (0, TITLE_H) with
  TITLE_H=28 (wm.c's, not the kernel's 24).
- Browser-test rules: derive geometry from `__osScreen`/live canvas
  rect, VT2 settle before pixel work, wm placement is async, keep the
  sweep serial.
- The IDE's clangd flags os/*.c and vendor SDL sources (SDL.h not
  found etc.) — noise; those headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v25 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP incl. CYCLE/EV_CYCLE;
  80-byte record) ↔ os/wm_proto.h ↔ test_wm_policy.js; surface/ring
  layout kernel.js (SH_*/IR_*) ↔ host.js (WMSH_*/WMIR_*); ring event
  numbers (WMEV) ↔ <SDL3> event values in compiler.js ↔ host.js WMEV_*;
  audio ring layout kernel.js (AU_*) ↔ host.js; SDL audio format words ↔
  <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run the full sweep incl.
  os-shell.mjs (serially!) after touching os/, kernel.js, host.js
  SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0033's decisions (incl. 0032's LRU-stamp cycling and
  no-subscriber passthrough; 0030's fit-gating; 0026's throw-and-retry
  escape / EXDEV / user volume skips /dev), DISK-IMAGE.md's settled
  layout/etc decisions.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0038 taskbar always-on-top (test-first), 0039 sweep round 2,
or something else."
