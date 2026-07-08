# Handoff — start of thread (updated 2026-07-08, after the desktop-shell round)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

This thread landed the whole **desktop-shell round 0028–0033** (design:
`WM.md` "The desktop shell"; dev logs `logs/2026-07-08/start-menu.md`,
`desktop-icons.md`, `titlebar-boxes.md`, `taskbar-polish.md`,
`window-cycling.md`, `wm-bug-sweep-1.md`):

- **0028 Start menu** — wm.c Start button + borderless menu popup from
  seeded `/etc/menu`; posix_spawn children (own pgroup, cwd /root,
  WNOHANG reap); child stdio resolved: services get the system std OFDs
  and children inherit them. os-common gained an inline `content` seed
  kind.
- **0029 desktop icons** — fullscreen bottom-of-z layer from
  `/root/Desktop`; own timestamp-based double-click (the SDL clicks
  counter accumulates ACROSS windows — don't trust it); `wmctl
  dblclick`; desktop clicks now dismiss the menu.
- **0030 title-bar [min][max][close]** — min = kernel `wmMinimize`
  direct, max = EV_TITLE_ACTIVATE (one policy path with double-click and
  wmctl max); **fit-gating**: each box exists only if it fits the title
  (32px windows stay draggable); glyphs are flat rects in BOTH
  composites.
- **0031 taskbar polish** — HH.MM clock (45px right cell, real local
  time), launch-order-stable buttons (memmove compaction), overflow
  shrink left of the clock (btn_width() shared by draw + click map).
- **0032 window cycling** — kernel chord (Tab+Alt held; Ctrl optional,
  Shift reverses) at the wmKey seam → WMP EV_CYCLE 0x8B; CYCLE 0x19 /
  `wmctl cycle` is the second exposure; NO subscriber → no interception
  (key passes through). wm.c policy is LRU-stamp based (deliberate
  deviation from "z-order" — RESTACK has no event and Alt-Esc lowering
  would sink windows under the desktop layer).
- **0033 bug sweep round 1** — all suites + storms green; WM.md gained
  the standing **"Known issues"** list (taskbar not always-on-top —
  verified, deferred with repro; Dawn+SIGKILL caveat SHRUNK on current
  webgpu pkg; gpubox adapter flake quiet; pointer-lock still needs a
  per-round HUMAN check — Playwright can't grant the lock).

**image.json is v25.** All green at hand-off: unit 697✓ (3 pre-existing
skips), blockfs✓, kernel suite✓, browser sweep os-boots✓ os-wm✓
os-scale✓ os-doom✓ os-gpubox✓ os-quake✓ os-term✓ os-vt✓ os-screen✓ +
new os-shell✓ — run serially. Headless open-everything/kill-9/respawn
storm and a browser shrink/VT-flip/kill-mid-audio storm both clean.

## The queue (todos/README.md is authoritative)

Next up: `0034` coreutils batch 2, `0035` spawn-capable applets,
`0036` seed the REPLs, `0037` wasm module cache, then the WebGPU app
port (WEBGPU.md) and the 0026-unlocked `tools/mkimage.js`. (`0006`
threads+atomics stays deferred indefinitely.)

## Gotchas carried forward

- Browser pixel tests: "empty desktop" asserts must tolerate the 0029
  icon grid (bit os-doom/os-quake in the sweep — fixed to <2%/<5%
  thresholds), and the desktop layer's teal is IDENTICAL to the
  compositor background teal — assert the layer via icons or `wmctl
  list`, never fill color.
- hush `kill` is cooperative SIGTERM: after killing the wm, barrier on
  its surfaces vanishing (taskbar pixel → teal) before asserting no-WM
  behavior — the subscription outlives the kill by a beat.
- Taskbar button coordinates shifted right of the 50px Start button
  (button 0 spans x 56..160 at ≤8 windows); with ≥9 windows at 1024
  they shrink (btn_width()).
- wm.c wins[] is launch order (compaction since 0031) — button index ↔
  creation order; sids ascend with creation.
- 0025's: double-click detection needs `opts.t` timestamps in tests;
  wm.c work area is `scr_w x (scr_h - BAR_H - TITLE_H)` at (0, TITLE_H)
  with TITLE_H=28 (wm.c's, not the kernel's 24).
- 0023's browser-test rules: derive geometry from `__osScreen`/live
  canvas rect, VT2 settle before pixel work, wm placement is async,
  keep the sweep serial.
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
  escape / EXDEV / user volume skips /dev).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0034 coreutils batch 2, the WebGPU app port, or something
else."
