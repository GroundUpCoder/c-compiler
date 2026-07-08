# Handoff — start of thread (updated 2026-07-08, after 0023 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**The screen is dynamic.** This thread landed **0023** — dynamic screen
resolution (design: WM.md "Screen, VTs, and scaling fixed-size clients";
dev log `logs/2026-07-08/dynamic-screen-resolution.md`). Shape:

- VT2's desktop tracks the browser viewport (the `#desktop` pane; 1 CSS
  px = 1 screen px, DPR deliberately ignored). os.html measures on VT2
  entry + debounced resizes → `{type:'screen-resize'}` → the kernel
  worker resizes the OffscreenCanvas (a transferred canvas can't be
  resized from the page) + re-calls `wmSetScreen`.
- `wmSetScreen` is the modeset now: emits WMP **EV_SCREEN {w,h} (0x87)**
  (MUST MATCH: kernel.js WMP ↔ os/wm_proto.h ↔ test_wm_policy.js), then
  one-shot-clamps non-borderless windows (drag-clamp bounds) so the
  no-WM fallback stays usable after a shrink. Emit order: EV_SCREEN
  first, then the clamp's EV_MOVEDs.
- /bin/wm tracks geometry now (EV_MOVED/EV_CONFIGURED update its model);
  on EV_SCREEN it re-lays the taskbar by destroy+recreate (no
  client-initiated resize, 0019), restores the focus the create stole,
  and re-clamps taskbar-aware (clamp, never re-cascade).
- **image.json is v17** (wm.c/wm_proto.h are seeded). VT1/headless
  behavior unchanged: VT1 resizes only re-fit xterm; boot.js stays at
  the kernel default until an embedder calls `wmSetScreen`.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓, browser os-boots✓ + os-wm✓ + os-vt✓ + os-doom✓ + os-quake✓
+ os-gpubox✓ + os-term✓ + **os-screen✓ (new, 16 checks)** — run serially.

## The queue (todos/README.md is authoritative)

1. `0024` scaling fixed-size clients — per-surface dst rect
   (wp_viewport-style); DOOM fills the screen with zero source changes.
   With 0023 in, the screen can now be BIGGER than doom's 1280×800 too —
   both directions matter.
2. `0025` maximize/restore — title double-click, dispatch on 0021's
   resizable bit (configure vs 0024 scale-to-fit)
3. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **Browser tests must derive screen-edge geometry from the live canvas
  rect** — never 800×500 constants. Pattern: wait for the VT2-entry
  resize to settle (canvas `getBoundingClientRect()` ≈ `__osScreen`, the
  new page probe), then compute taskbar rows etc from that. Sample
  helpers size temp canvases from the rect too: the width/height
  ATTRIBUTES of a transferred placeholder canvas go stale.
- Tests that capture the canvas rect for mouse coords need the settle
  wait first — the canvas origin shifts when it stops being a centered
  800×500 and fills the pane (os-doom/os-quake/os-term/os-gpubox got it
  after their first `setVt(2)`).
- **wm placement is async**: a window renders at the kernel-cascade spot
  until /bin/wm's MOVE lands; geometry-dependent probes must wait for
  placement (os-gpubox's composite wait now also requires the corner
  clear color — that was a real flake, found once in ~3 runs).
- The wm's bar recreate on EV_SCREEN steals focus (surface create
  focuses); wm.c compensates by re-sending FOCUS — keep that if touching
  screen_changed().
- os-doom's `wmctl close` teal-wait can still exceed 30s if browser
  tests run concurrently with Node suites — keep the sweep serial.
- The vi/os-boots timing guards from 0018/0020 still apply: wait for
  `/~ #/` in `__osOut` before typing; quote-split echo needles
  (`echo VT1-O''K`); os-gpubox stays environmentally flaky on headless
  WebGPU adapter availability (distinct from the fixed flake above).
- The IDE's clangd flags os/*.c (SDL.h not found etc.) — noise; those
  headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v17 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP, EV_SCREEN included)
  ↔ os/wm_proto.h ↔ test_wm_policy.js; surface/ring layout kernel.js
  (SH_*/IR_*) ↔ host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔
  <SDL3> event values in compiler.js ↔ host.js WMEV_*; audio ring layout
  kernel.js (AU_*) ↔ host.js; SDL audio format words ↔
  <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox/os-quake/os-term/os-vt/os-screen (serially!) after touching
  os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0022's decisions, 0023's decisions (1 CSS px = 1
  screen px / no DPR, worker-side canvas resize, kernel clamps for the
  no-WM fallback + wm clamps for policy, clamp-not-recascade, VT1
  resizes never touch the screen).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0024 viewport scaling, 0025 maximize, a WebGPU app port, or
something else."
