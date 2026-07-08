# Handoff — start of thread (updated 2026-07-08, after 0024 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Fixed-size windows scale.** This thread landed **0024** — viewport
scaling (design: WM.md "Screen, VTs, and scaling fixed-size clients"
scaling block; dev log `logs/2026-07-08/viewport-scaling.md`). Shape:

- Per-surface **dst viewport** (`dstW/dstH`, default = buffer) in the
  kernel scene; buffer untouched, app oblivious. One op set:
  `wmSetDst` / WMP **SET_DST 0x17** (+ **EV_SCALED 0x88** echo) /
  `wmctl scale SID W H`. The window record grew **72 → 80 bytes**
  (dst_w/dst_h after frame_seq, title at offset 48) — MUST MATCH:
  kernel.js WMP ↔ os/wm_proto.h ↔ test_wm_policy.js. `wmctl list`
  gained a DST column ("-" when unscaled) between GEOMETRY and Z.
- Geometry (hit-test, chrome, drag/screen clamps, both composites) runs
  on dst dims; client-bound pointer input inverse-maps to buffer coords
  (`wmInjectPointer` stays buffer-coords by design). Browser compositor:
  scratch-canvas cache + `drawImage` src→dst, smoothing off (re-set per
  frame — canvas resize resets ctx state); headless: NN loop, integer
  scales replicate exactly.
- Frame drags on non-resizable surfaces rubber-band (0019 mechanism)
  and emit **EV_SCALE_REQ 0x89** at release; **wm.c** answers with an
  aspect-fit SET_DST, integer-snapped within 15% (floors the SCALE, not
  dims); no WM subscribed → kernel applies the raw box. Resizable keeps
  0021 configure semantics — **SET_DST on resizable refuses**, and a
  SET_FLAGS bit2 grant snaps dst back to buffer (exclusive modes;
  don't re-litigate — 0025 dispatches on the same bit).
- `winbox fixed` (title "fixbox", no RESIZABLE) is the fixed-size
  acceptance app. **image.json is v18.**

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓ (0024 legs in test_wm/test_wm_policy/test_wm_service_e2e;
the FLAGS column moved to split('\t')[5] in test_os_apps_e2e), browser
os-boots✓ + os-wm✓ + **os-scale✓ (new, 17 checks)** + os-vt✓ + os-doom✓
+ os-quake✓ (grip leg now asserts the SCALE, 400x250 aspect fit)
+ os-gpubox✓ + os-term✓ + os-screen✓ — run serially.

## The queue (todos/README.md is authoritative)

1. `0025` maximize/restore — title double-click, dispatch on 0021's
   resizable bit: SURFACE_CONFIGURE to the work area (screen minus
   taskbar) for resizable windows, 0024 scale-to-fit for fixed-size
   ones; restore returns to saved geometry. Nearly pure wm.c policy now.
2. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- `_wmDestroySurface` emits **EV_FOCUS before EV_DESTROYED** — order
  matters to scripted protocol clients.
- Anything parsing `wmctl list` positionally: columns are now
  SID PID GEOMETRY **DST** Z FLAGS TITLE. The grep-title$ +
  leading-digit-sed idiom survives; `split('\t')[4]`-style FLAGS
  indexing does not (it's [5] now).
- The compositor's `imageSmoothingEnabled=false` must be re-set every
  frame: the 0023 screen-resize recreates canvas context state.
- DOOM still presents 1280×800 (its own `WINDOW_SCALE 2` CPU pre-scale);
  presenting 640×400 raw and letting the compositor scale is now
  possible but was deliberately NOT touched (vendor-source change —
  candidates for a small follow-up if wanted).
- 0023's gotchas still apply to browser tests: derive geometry from the
  live canvas rect / `__osScreen`, wait for the VT2 settle before
  capturing the rect, wm placement is async (wait for it before
  geometry-dependent probes), keep the browser sweep serial.
- The IDE's clangd flags os/*.c (SDL.h not found etc.) — noise; those
  headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log
  per landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v18 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP incl. SET_DST/
  EV_SCALED/EV_SCALE_REQ; 80-byte record) ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js (SH_*/IR_*) ↔
  host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event
  values in compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js
  (AU_*) ↔ host.js; SDL audio format words ↔ <SDL3/SDL_audio.h>;
  SI_* tty header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-scale/
  os-doom/os-gpubox/os-quake/os-term/os-vt/os-screen (serially!) after
  touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0023's decisions, 0024's decisions (dst-vs-configure
  exclusive per the resizable bit, SET_DST-refuses-resizable, injection
  in buffer coords, integer-snap in wm.c policy not the kernel,
  buffer-res `wmctl shot SID`).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0025 maximize, a WebGPU app port, the doom present-640x400
follow-up, or something else."
