# Handoff — start of thread (updated 2026-07-08, after 0018 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Quake is windowed and the WM acceptance test holds for all four vendor
apps.** This thread landed **0018** — relative mouse / pointer lock (design
+ status: WM.md "Implementation status — relative mouse / quake"; dev log
`logs/2026-07-08/quake-relative-mouse.md`). Shape:
`SDL_SetWindowRelativeMouseMode` → `SURFACE_SET_FLAGS` (0x1006; flag word
bit0 borderless, bit1 relative-mouse) → kernel WANTED state (focused
surface wants relative; `onPointerLock` tells the UI bridge on change) vs
ACTIVE state (bridge-reported via `wmPointerLockChanged`; only ACTIVE flips
routing). **The lock gesture is kernel-hit-tested**: a client-area click on
the focused relative surface RE-OFFERS wanted=true and os.html requests the
lock inside that click's transient activation — title/desktop clicks never
do, so windows stay draggable/closable unlocked (ESC drops the lock,
browser-enforced; next client click re-takes it). Locked routing: motion →
rel ring records (motion word [5]=1, [2]/[3] = f32 dx/dy) →
`__sdl_push_mouse_motion_rel_event` → SDL `xrel/yrel` with frozen x/y;
buttons land at the client center. Agent exposure: `wmInjectPointer 'rel'`
/ WMP INJECT_POINTER kind 4 / `wmctl relmove`; record flags bit3 (wmctl
list column is 4 chars now: `f---`). Standalone pages got the same SDL API
(`sdl-relative-mouse` notify + `SDL_WEB.mouseMoveRelMsg`). `/bin/quake`
seeds from `vendor/quake/bin.json` (os-common buildProject grew
`--allow-old-c` and now THROWS on unknown compilerArgs); pak0.pak (18MB) +
autoexec.cfg (now ships `+mlook`) land at `/root/id1`; **image.json is
v14**.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓ (test_wm relative-mouse section, test_wm_policy rel-inject +
flag bit3, test_wm_e2e RELMODE/MOTION legs, test_os_apps_e2e quake leg),
browser os-boots✓ + os-wm✓ + os-doom✓ + os-gpubox✓ + os-quake✓ (new).

## The queue (todos/README.md is authoritative)

1. `0020` wasm terminal + ptys
2. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **Chromium DENIES `requestPointerLock` under ALL Playwright-driven input**
  (headless AND headful, branded Chrome too; `WrongDocumentError`,
  playwright#20956) — CDP clicks aren't OS-level gestures to the
  browser-side permission gate. os-quake.mjs asserts the OFFER round trip
  (`__osPtrLockOffers` probe) and simulates the grant through the real
  `{kind:'lockchange'}` bridge path; the literal lock UX needs one human
  check in a real browser after touching it.
- **Typed shell input right after `ready` races hush's banner and gets
  eaten.** All os-*.mjs now wait for `/~ #/` in `__osOut` before typing —
  keep that guard in new browser tests (this bit os-doom after the bigger
  v14 first-boot seed shifted the timing).
- `wmctl list` FLAGS is 4 chars (`f---`; bit3 = `r` relative-mouse) — tests
  grepping `\tf--\t` broke once already (test_wm_service_e2e).
- The kernel's lock re-offer fires `onPointerLock(true)` WITHOUT a state
  change — bridge handlers must treat wanted=true as idempotent.
- os-gpubox.mjs stays environmentally flaky (WebGPU adapter availability in
  headless Chromium comes and goes — pre-0019 note still applies). The
  os-boots vi leg can flake on paced-keystroke timing; rerun before
  suspecting a regression.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v14 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP) ↔ os/wm_proto.h ↔
  test_wm_policy.js (incl. the flag bits + INJECT_POINTER kinds);
  surface/ring layout kernel.js (SH_*/IR_* — motion word [5] is the rel
  flag) ↔ host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3>
  event values in compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js
  (AU_*) ↔ host.js createSharedAudioBuffer/audioRingPush; SDL audio format
  words ↔ <SDL3/SDL_audio.h> in compiler.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox/os-quake after touching os/, kernel.js, host.js
  SDL/webgpu/fd/audio/input paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0014/0015/0016/0017/0019's decisions, 0018's decisions
  (kernel-hit-tested lock gesture, wanted/active split, rel flag in motion
  word [5], locked buttons at client center).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0020 (wasm terminal + ptys), a lingering item, or something
else."
