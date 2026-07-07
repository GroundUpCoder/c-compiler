# Handoff — start of thread (updated 2026-07-08, after 0019 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Windows are resizable.** This thread landed **0019** — client resize on
the reserved `SURFACE_CONFIGURE` opcode (design + status: WM.md
"Implementation status — client resize"; dev log
`logs/2026-07-08/surface-resize.md`). Shape: resize is KERNEL-initiated —
request = `WINDOW_RESIZED` (0x206) input-ring record; ack =
`SURFACE_CONFIGURE` (0x1005) RPC whose NEW fb SAB (riding `{type:'wm-sabs'}`
like at create) already holds the first frame at the new size, swapped
atomically kernel-side → tear-free by construction. host.js routes old-size
in-flight presents into the OLD (still displayed) SAB, so slow adopters
stay live; pre-0019 binaries just keep their geometry. Latest-wins
coalescing: stale acks are accepted + the configure re-issued. Kernel
chrome grew a 4px frame (E/S/SE drag zones, 16px SE grip, rubber-band
outline, ONE configure at release — Win95 outline semantics). SDL layer
grew `SDL_EVENT_WINDOW_RESIZED` (0x202–0x207 block), `SDL_WindowEvent`,
`SDL_GetWindowSize`, and in-place surface re-derive with HIGH-WATER pixel
allocation (stale-size drawing can't corrupt the heap). Exposures:
`wmResize` / WMP `RESIZE`+`EV_CONFIGURED` / `wmctl resize`. winbox +
gpubox handle resize (gpubox: reconfigure surface + rebuild depth — the
canonical webgpu.h dance); image.json is **v13**.

Decisions made in 0019 (don't re-litigate): kernel-initiated only (a
client `SURFACE_CONFIGURE` with nothing pending is EINVAL —
`SDL_SetWindowSize` would land as a new request path, not a bare ack);
left/top borders are focus-only (moving-edge resize defers); outline-drag
not live-resize (no per-motion SAB churn); ack accepted even when stale.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓ (test_wm renegotiation section, test_wm_policy
RESIZE/EV_CONFIGURED, test_wm_e2e real-C resize leg, test_gpubox_dawn_e2e
320x200 resize leg), browser os-boots✓ + os-wm✓ (real-mouse drag-resize
240x160→300x200) + os-doom✓ + os-gpubox✓.

## The queue (todos/README.md is authoritative)

1. **`0018` quake windowed** — relative-mouse/pointer-lock surface flag +
   pak0.pak seeding (trivial via `bin` entries)
2. `0020` wasm terminal + ptys
3. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **os-gpubox.mjs is environmentally flaky**: WebGPU adapter availability
  in headless Chromium comes and goes (the PRE-change tree failed 3/3 in
  one window, passed in another; failure mode is "cube never composited",
  upstream of everything 0019 touched). Retry before suspecting a
  regression; when an adapter appears the whole test passes.
- Compositor ImageData cache must key on dims, not just frameSeq — a
  resize ack swaps in a FRESH SAB whose seq restarts (fixed; keep in mind
  for any other seq-keyed cache).
- The chrome frame moved pixels: anything sampling "just outside a
  window" needs to clear `WM_BORDER` (os-wm.mjs placement probe moved
  from 3px to 7px out).
- host.js's renegotiation is gated on `hooks.surfaceConfigure` existing —
  pre-0019 embedders simply never renegotiate.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v13 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP) ↔ os/wm_proto.h ↔
  test_wm_policy.js; surface/ring layout kernel.js (SH_*/IR_*) ↔ host.js
  (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event values in
  compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js (AU_*) ↔
  host.js createSharedAudioBuffer/audioRingPush; SDL audio format words ↔
  <SDL3/SDL_audio.h> in compiler.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox after touching os/, kernel.js, host.js SDL/webgpu/fd/audio
  paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0014/0015/0016/0017's decisions, 0019's decisions above.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0018 (quake windowed), a lingering item, or something else."
