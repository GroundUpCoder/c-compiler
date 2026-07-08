# Handoff — start of thread (updated 2026-07-08, after 0025 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**The outer-geometry block is complete.** This thread landed **0025** —
maximize/restore (design: WM.md maximize block; dev log
`logs/2026-07-08/maximize.md`), the last piece after 0022/0023/0024.
Shape:

- Kernel = mechanism only: title-bar double-click detection in
  `wmPointer` (WM_DBLCLICK_MS 400 + 4px slop; `opts.t` timestamps —
  os.html sends `e.timeStamp` with mousedowns, routeInput threads it;
  dt must be >= 0, mixed clock origins must never match) → WMP
  **EV_TITLE_ACTIVATE 0x8A**, and NO drag on the activating down. New
  command **ACTIVATE 0x18** (`wmctl max SID`) re-emits the same event —
  one policy path; R_ERR with no subscriber (no WM = no maximize; the
  kernel keeps ZERO maximize state, unlike kernel-implemented minimize).
- wm.c = the policy: per-win `maximized` + saved geometry (w/h for
  resizable, dst for fixed). Dispatch on the RESIZABLE bit: resizable →
  MOVE(0,TITLE_H) + RESIZE to the work area (screen minus taskbar);
  fixed → centered aspect-fit SET_DST. Second activate restores;
  EV_SCREEN re-fits maximized windows instead of clamping. `fit_dst`
  grew an `allow_over` flag: the 0024 drag path may snap UP past the
  box (gameboy-at-2x, deliberate), maximize never overflows the work
  area (raw fit fallback). A wm restart forgets maximize state (fine —
  restart tidies the desktop by design).
- MUST-MATCH updated in all three places: kernel.js WMP ↔ os/wm_proto.h
  ↔ test_wm_policy.js. **image.json is v19** (wm.c/wmctl.c seeded).

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓,
blockfs✓, kernel suite✓ (0025 legs in test_wm/test_wm_policy/
test_wm_service_e2e — the last drives real wmctl max on both branches,
exact work-area + snapped-fit numbers), browser os-boots✓ + os-wm✓
(+ dblclick maximize/restore leg) + os-scale✓ (+ fixed-size
scale-to-fit maximize leg) + os-vt✓ + os-doom✓ + os-quake✓ + os-gpubox✓
+ os-term✓ + os-screen✓ — run serially.

## The queue (todos/README.md is authoritative)

1. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md
2. (idea, small) DOOM presents 1280×800 via its own `WINDOW_SCALE 2`
   CPU pre-scale; with 0024 it could present 640×400 raw and let the
   compositor scale — vendor-source change, never promoted to an item

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- An unfocused window emits **EV_FOCUS before EV_TITLE_ACTIVATE** (the
  activating down focuses first) — scripted protocol clients beware.
- Double-click detection compares consecutive title-DOWN timestamps:
  tests drive it with `opts.t`; two untimestamped (Date.now) clicks in
  fast test code WILL activate if same-sid within 4px — position test
  clicks accordingly (a real bite: test_wm_policy mixed origins, hence
  the dt >= 0 guard).
- wm.c's work area is `scr_w x (scr_h - BAR_H - TITLE_H)` at
  `(0, TITLE_H)` — TITLE_H is wm.c's 28, not the kernel's 24.
- Browser maximize legs derive EVERYTHING from `__osScreen` (0023 rule)
  and mirror wm.c's fit including the snap-fits check; float f32-vs-f64
  drift is possible in principle — sample pixels at centers, not edges.
- 0023's browser-test gotchas still apply (live canvas rect, VT2 settle,
  wm placement is async, keep the sweep serial).
- The IDE's clangd flags os/*.c (SDL.h not found etc.) — noise; those
  headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v19 now).
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
  invariants, 0013–0024's decisions, 0025's decisions (kernel keeps no
  maximize state, ACTIVATE-refuses-without-WM, snap-never-overflows the
  work area on maximize, no maximized record flag).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: a WebGPU app port, the doom present-640x400 follow-up, or
something else."
