# Handoff — start of thread (updated 2026-07-08, after 0021 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Fixed-res windows can no longer be sheared.** This thread landed **0021**
— `SDL_WINDOW_RESIZABLE` honored end to end (design bullet: WM.md
"Implementation status — client resize"; dev log
`logs/2026-07-08/resizable-gating.md`). Shape:

- host.js maps SDL flag 0x20 → kernel surface-flag **bit2** at create
  (borderless 0x10 → bit0 as before); `SURFACE_SET_FLAGS` carries it too
  (the word is replaced whole — host.js's `kFlagsBySid` preserves bits
  across the relative-mouse call, so real apps never lose it).
- kernel.js dispatches on `surf.resizable` everywhere resize can start:
  frame hit-test has NO E/S/SE drag zones on a non-resizable surface (the
  whole frame is focus-only, like left/top edges), and `wmResize` / WMP
  `RESIZE` / `wmctl resize` refuse with an error, leaving no pending
  configure. WMP window record flag **bit4** (`WMP_F_RESIZABLE`,
  `R` in `wmctl list` — FLAGS column is now 5 chars).
- winbox/term already declared the flag; **gpubox now does**; doom/quake/
  gameboy stay `flags=0` = fixed, per real SDL3. **image.json is v16**
  (gpubox.c + wmctl.c are seeded sources).

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓ (incl. new gating legs in test_wm.js/test_wm_policy.js, the
wmctl-resize-refused doom leg in test_os_apps_e2e.js, `f---R` in
test_wm_service_e2e.js), browser os-boots✓ + os-wm✓ + os-doom✓ +
os-quake✓ (new SE-grip no-op leg) + os-gpubox✓ + os-term✓.

## The queue (todos/README.md is authoritative)

1. `0022` VT switching tty ↔ desktop (item file exists; design in WM.md
   "Screen, VTs, and scaling fixed-size clients")
2. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **`SURFACE_SET_FLAGS` replaces the whole flag word.** A raw-RPC caller
  toggling bit1 must carry bit2 along or it revokes resizability — that
  deadlocked test_wm_policy.js's resize leg (an EV_CONFIGURED that can
  never come). Real apps are immune via host.js's kFlagsBySid.
- Anything parsing `wmctl list`'s FLAGS column must expect 5 chars now
  (`f---R`, `f..r-\t` regexes were updated in test_wm_service_e2e.js and
  os-quake.mjs).
- doom's 1280x800 window clips its frame off the 800x500 screen, so
  browser no-resize-drag coverage lives in os-quake.mjs (320x200, grip
  visible); doom gets the `wmctl resize`-refused check headless.
- The vi/os-boots timing guards from 0018/0020 still apply: wait for
  `/~ #/` in `__osOut` before typing in browser tests; os-gpubox stays
  environmentally flaky (headless WebGPU adapter availability).
- The IDE's clangd flags os/*.c (SDL.h not found etc.) — noise; those
  headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v16 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP) ↔ os/wm_proto.h ↔
  test_wm_policy.js (record flags: focused/min/borderless/relmouse/
  resizable = bits 0–4); surface/ring layout kernel.js (SH_*/IR_*) ↔
  host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event
  values in compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js
  (AU_*) ↔ host.js; SDL audio format words ↔ <SDL3/SDL_audio.h>; SI_* tty
  header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox/os-quake/os-term after touching os/, kernel.js, host.js
  SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0020's decisions, 0021's decisions (resizable =
  surface-flag bit2 / record bit4; non-resizable frames are focus-only;
  RESIZE refusal leaves no pending state; SET_FLAGS stays whole-word).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0022 (VT switching), a WebGPU app port, a lingering item, or
something else."
