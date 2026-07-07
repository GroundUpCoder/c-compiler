# WM v1: spikes + kernel surfaces + compositor + SDL retarget (0012, 0013)

Fourth landing of the day, same thread as the design (`wm-design.md`):
WM.md's implementation units 1–5 (+ most of 7) went from zero to a
windowed OS — `winbox &` in hush opens a draggable, clickable,
kernel-chromed window on the os.html desktop, and the whole thing is
equally drivable headless. What the log owes the future is the two
platform surprises and the one genuine design bug.

## Surprise 1: rAF works in workers — but NOT nested workers

Spike S2 "verified" worker rAF in a page-created worker. OS process
workers are workers-of-workers, where Chromium DEFINES
`requestAnimationFrame` and then throws NotSupportedError on call — so
winbox booted, created its surface, and died on frame one, visible only
in the kernel log. Fix: host.js's SDL rAF wrapper latches to a
setTimeout(16) pacer on first failure. Spike lesson: test in the real
topology, not a lookalike.

## Surprise 2 (the design bug): main-return exit vs the frame loop

runModule ran the C exit path (`exports.exit`) BEFORE the post-main frame
loop. Standalone that "worked" by accident — the host `__exit` stub throws
ExitStatus, which the try/catch ate, and frames ran anyway. Under the
kernel, `__exit` is the EXIT RPC and the kernel tears the worker down —
every OS SDL app died before its first frame. The fix is emscripten's own
semantic, now explicit: a registered main-loop callback keeps the runtime
alive, and the exit path (atexits + EXIT handshake) runs when the loop
stops. All suites green after; standalone sdl-render re-verified.

## Design calls made in code (recorded in WM.md "Implementation status")

- **The SAB handshake direction**: the kernel cannot hand a new SAB to a
  parked worker (postMessage never arrives — the worker's event loop is
  in Atomics.wait). So the PROCESS allocates fb + input-ring SABs and
  posts `{type:'wm-sabs'}` immediately before SURFACE_CREATE; same-channel
  FIFO makes the pairing race-free. This is now the pattern for any future
  "kernel needs a new shared region" problem.
- **Present is not an RPC.** Mailbox double buffer: write back, flip
  (Atomics), seq++. The compositor samples at its own rAF; headless
  screenshots read the front buffer. 0x1004 reserved if damage tracking
  ever wants a present notification.
- **UpdateWindowSurface rides shm even in the browser** (the gpu bitmap
  path is only for the WebGPU renderer). Dropped the original "browser =
  bitmap for everything" — CPU-present apps now have zero GPU dependency,
  which is also what saved the day when nested-worker rAF/WebGPU turned
  out flaky territory.
- **Input ring indices live in [0, 2*cap)** (full/empty disambiguation),
  drop-newest + drop counter — the audio-ring wrap bug class designed out
  from day one; the 10k-event storm test pins ordering and integrity.
- **Kernel-chrome hit-testing and drawing share the same WM_* constants**
  across kernel.js (hit test + headless composite) and compositor.js
  (browser draw) — what you click is what you see, by construction.

## Tests

`tests/kernel/test_wm.js` (34 checks, fake workers over the real SAB
protocol), `test_wm_e2e.js` (real compiled C SDL app: pixels, injected
input into SDL_PollEvent, QUIT-close → exit code), browser
`tests/browser/os-wm.mjs` (Chromium: launch from hush, composited pixels,
click-paint at local coords, key toggle, title drag, close box, shell
survives). Spike harnesses kept: `wm-spikes.mjs` (S1 bitmap handoff
GPU-backed: present p50 0.02ms; S2; S4 two-hop canvas) and
`tests/spikes/s3_dawn.mjs` (Dawn per worker_thread; terminate() caveat).
Full suites green: unit 697✓/3 skip, blockfs✓, kernel✓, host✓,
os-boots✓, sdl-render✓. image.json bumped to v9 (winbox seeded).

## Next

`todos/0014` — /bin/wm policy client over AF_UNIX + wmctl/agent RPCs;
then windowed vendor apps (doom needs its WAD in the OS fs), resize
(SURFACE_CONFIGURE), the wasm terminal, audio mixing.
