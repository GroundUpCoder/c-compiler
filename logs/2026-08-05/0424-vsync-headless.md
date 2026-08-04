# #424 — `boot.js --vsync[=hz]`: timer-driven vsyncTick headless

Ticket #424 (headless-node-architecture report §3 Stage 3 / §6). Epic
justification: SDL frame loops are the gamedev product's core code path, and
until now nothing paced by `vsyncTick` could run under `os/boot.js` at all —
frame-paced code either fell back to Playwright/Chromium or went untested.
The flag puts that path under the fast host, and landing it immediately
proved the point (see the latent bug below).

## What landed

- **`os/boot.js --vsync[=hz]`** (default 60, want 1..1000 — a millisecond
  timer cannot honestly deliver more, so out-of-range refuses loudly at
  exit 2 rather than silently under-delivering). `Kernel({vsync: true})`
  advertises the frame clock at spawn (KP_VSYNC_EN, todos/0100); a
  drift-corrected setTimeout chain is its source, aiming at an absolute hz
  schedule (the 0100 pacer lesson: fixed-delay-after-callback timers add
  callback time to the period). Overrun keeps rAF semantics: missed ticks
  are **skipped, never queued** — `vsyncWait`'s catch-up collapses them to
  one immediate frame, same as a stalled browser tab. The timer is unref'd
  (never keeps a halted boot alive) and never parks — headless has no
  compositor, so the todos/0169 park protocol (an idle-power concern) has
  no counterpart; the model is an always-visible display.
- **Flag absent = byte-identical boot.** `vsync: false` and the old absent
  key take the same `!!opts.vsync` path; no timer is armed.

## The latent bug the flag exposed (kernel.js BOOT_SOURCE)

First real run SEGV'd: a frame-loop app paced by `--vsync` died mid-park
while the same app ran fine under the deadline pacer. Root cause: **Node
exits a worker whose event loop drains, and a pending `Atomics.waitAsync`
holds no ref.** `vsyncWait` is the estate's ONE async parker (every other
wait is a synchronous `Atomics.wait` that blocks the thread outright), and
the kernel never posts messages to Node process workers (all kernel→process
signalling is SAB), so a process parked in `vsyncWait` had a completely
empty event loop → worker exit → the kernel's channel-death path reported a
silent SIGSEGV. The deadline pacer had always masked this with its pending
`setTimeout`. Browser workers idle on an empty loop, so the browser flavor
(todos/0167) never hit it — a textbook boot.js/kernel-worker twin
divergence, latent since 0100, unreachable until a headless kernel could
advertise a frame clock.

Fix: BOOT_SOURCE pins the worker's event loop with a never-firing ref'd
timer. This cannot leak workers: the kernel owns worker lifetime — every
process end path goes through `_exitProcess` → `worker.terminate()`
(exit handshake, crash, SIGKILL).

## Test

`tests/kernel/test_vsync_boot_e2e.js` (red control @1c668df6, fails on the
base tree as "unknown option"): bad-hz refusals (`abc`/`0`/`-5`/`9999` →
exit 2 naming `bad --vsync`, before any image work); a real C frame-loop
app (in-OS `cc`, `__setAnimationFrameFunc`, no window/no SDL_Init — the
exact seam host.js's frame-loop driver paces) measuring 30 frame intervals
at `--vsync=20` with **>= 1.1s wall** as the load-bearing bound (the
fallback deadline pacer runs the same 30 frames at ~0.5s, so the bound
fails if the flag is ignored or the pacer silently falls back); bare
`--vsync` completing sanely at the 60Hz default.

## Deliberately not done

- **host.js untouched.** Its shm-flavor comment "Headless kernels never
  advertise, so Node keeps the deadline-setTimeout pacer" (near the
  `requestAnimationFrame` slot) is now conditional — under `--vsync` a
  headless kernel does advertise and that very slot paces off `vsyncWait`.
  Correcting one comment sentence would have pulled host.js's 22-suite
  gate; fold it into the next host.js-touching batch instead.
- **No park protocol headless** (recorded above — design, not a cut).
- **#194 (video player) untouched** — a consumer of this flag, per the
  ticket's do-not-fold note.

## Gate

Planner (`--diff origin/main`): todos, kernel, sweep — run in full, one
invocation, green: todos 6.8s; kernel 1453s, 163/163 files
(recorded == total, resumed 0, carried 0, evidence present); sweep 1233s,
51/51 (same). `build/test-run/summary.json`: filter null, 3/3 pass.
