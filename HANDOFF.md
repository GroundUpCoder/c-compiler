# Handoff — start of thread (updated 2026-07-08, after 0027 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

The outer-geometry block (0022–0025) is complete; this thread landed the
small follow-up **0027** — DOOM presents 640×400 raw (dev log
`logs/2026-07-08/doom-native-present.md`): the vendor `WINDOW_SCALE 2`
CPU pre-scale is gone, the compositor's 0024 dst-rect scaling covers it
(drag/`wmctl scale`/0025 maximize). **image.json is v20.** DOOM's window
now FITS the desktop (640×400, no longer overflowing by design) — the
old "clipped close box" lore in comments/tests is retired; sample
regions in os-doom.mjs AND os-vt.mjs shrank to `[16,40,648,432]`.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓,
blockfs✓, kernel suite✓ (apps e2e asserts 640×400 window + shot),
browser sweep os-boots✓ os-wm✓ os-scale✓ os-doom✓ os-gpubox✓ os-quake✓
os-term✓ os-vt✓ os-screen✓ — run serially.

## The queue (todos/README.md is authoritative)

1. `0026` mount points: split system/user volumes — MountFS over N
   BlockFS volumes (`/` system, `/root` user); design in the item
2. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas carried forward

- 0025's: unfocused window emits EV_FOCUS before EV_TITLE_ACTIVATE;
  double-click detection needs `opts.t` timestamps in tests (dt >= 0
  guard, mixed clock origins never match); wm.c work area is
  `scr_w x (scr_h - BAR_H - TITLE_H)` at `(0, TITLE_H)` with TITLE_H=28
  (wm.c's, not the kernel's 24).
- 0023's browser-test rules: derive geometry from `__osScreen`/live
  canvas rect, VT2 settle before pixel work, wm placement is async,
  keep the sweep serial.
- The IDE's clangd flags os/*.c and vendor SDL sources (SDL.h not
  found etc.) — noise; those headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v20 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP incl. ACTIVATE/
  EV_TITLE_ACTIVATE; 80-byte record) ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js (SH_*/IR_*) ↔
  host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event
  values in compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js
  (AU_*) ↔ host.js; SDL audio format words ↔ <SDL3/SDL_audio.h>;
  SI_* tty header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-scale/
  os-doom/os-gpubox/os-quake/os-term/os-vt/os-screen (serially!) after
  touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0025's decisions (kernel keeps no maximize state,
  ACTIVATE-refuses-without-WM, snap-never-overflows the work area on
  maximize), 0027's (DOOM presents native res; "spawn maximized" would
  be wm.c policy, not vendor source).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0026 mount points, a WebGPU app port, or something else."
