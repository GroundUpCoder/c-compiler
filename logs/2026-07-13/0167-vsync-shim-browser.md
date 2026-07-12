# 0167 — wire the vsyncWait shim into the browser SDL flavor (IDLE-POWER Stage 1)

The one-line story: todos/0100 built the whole vsync broadcast — kernel-page
tail words, `vsyncTick()` per composite, `KernelClient.vsyncWait()` with rAF
catch-up, the spawnHooks seam — and then plugged it into the only flavor that
can never use it. The headless/shm flavor's return object carried the
`hooks.vsyncWait().then(cb)` shim, but headless kernels never pass
`{vsync: true}`, and the browser flavor (the only place a compositor rAF
exists) returned earlier via `out = Object.assign({}, inner)` and inherited
`createBrowserSDL`'s try-rAF → NotSupportedError → deadline-setTimeout latch.
Net: dead code everywhere, `vsyncTick()` notified nobody, and the documented
"tab hidden = SDL apps park" was intent, not behavior (verified 2026-07-12
in the IDLE-POWER review, logs/2026-07-12/idle-power-review.md).

## The change

host.js browser flavor, right at its return: when the kernel advertises
vsync (`hooks.vsyncEnabled()` — reads `KP_VSYNC_EN`, stamped at spawn in
kernel.js `_spawn` before the worker boots, so the creation-time gate is
race-free), overwrite the inherited `out.requestAnimationFrame` with the
same shim the headless site declares. Without the advertisement (standalone
browser pages, no kernel) the inherited deadline pacer stands — two pacing
tiers, one seam, exactly the KERNEL.md story, now true.

Ten lines, most of them comment. The leverage is in what it enables: every
later IDLE-POWER stage needs the doorbell call site (`vsyncWait`) to be live
code in the browser, and hidden-tab park is now mechanical — hidden tab →
compositor rAF stops → no `vsyncTick` → every SDL frame loop parks on
`Atomics.waitAsync(KP_VSYNC_SEQ)` costing zero wakeups.

## Docs made true

- KERNEL.md "The vsync broadcast": GAP note deleted, seam described as
  both-flavors.
- CLAUDE.md os/ section: the 2026-07-12 CAVEAT block deleted.
- IDLE-POWER.md: Stage 1 annotated DONE; the review finding kept as the
  dated pre-0167 record.

## Semantics watched (from the item)

- **Present-cadence regression (the 0100 fps-halving class):** vsyncWait's
  catch-up resolves immediately when a tick landed mid-frame-callback, so a
  busy app still runs back-to-back frames at tick rate — same semantics as
  real rAF. Gate: os-doom/os-term sweeps + `tests/flake.js`.
- **Headless untouched by construction:** the new branch is inside the
  browser flavor; boot.js/kernel-suite kernels never advertise vsync.

## Gates run (numbers)

- `tests/run.js --diff` plan: host, blockfs, kernel, sweep.
- host: all pass (first run's only failure was `tests/serve/test_first_run.js`
  timing out on the one-time input-stale rebake host.js's new mtime forced;
  green on rerun, 1.9s).
- blockfs 15/15 (87.6s); kernel 59/59 (430.2s).
- Browser sweep: 22/24 — the 2 reds are os-shell (deferred 0156 legs 49/52)
  and os-fileman (pre-existing flake, see below). All pacing-critical files
  green: os-doom, os-term, os-gpubox, os-quake, os-wm, os-vt, os-aero.
- Flake gate `tests/flake.js`: kernel legs (wm_service/term/os_apps ×3
  under load) green; os-term 3/3; os-doom 2/3 under load — investigated
  below, pre-existing.

## The two browser flakes are pre-existing (filed todos/0171)

Both were stash-baselined at 23315f1 with identical failure signatures:

- os-fileman rename legs: 2/3 with the diff, 2/3 WITHOUT. ~33% at HEAD.
- os-doom under load ("desktop restored" after `wmctl close` times out,
  window still composited): with diff 5/8 pass, baseline 7/8 pass —
  Fisher p≈0.28, no established rate difference, and the signature is
  byte-identical (full doom frame, nonTeal 61936/61936).

A dedicated launch→close→probe loop under load (12-iteration runs: baseline
×1, with-diff ×3 variants — 48 clean iterations total, plus 1 captured wedge
in the first prototype loop) established: doom processes QUIT and exits cleanly ("Quit requested",
hush reaps "[1] Done doom"); the failing link is the VT1 SHELL afterwards —
a typed line lost its leading bytes and hush stopped consuming tty input
entirely (echo alive, reader dead). Class + diagnostics + plan → todos/0171
(P0). The vsync wiring's own suspects were each cleared: CLOSE_REQ pushes
WMEV.QUIT straight to the app ring (no wm.c hop), and doom needs exactly one
tick to drain it — ticks demonstrably flowing (the same runs' animate legs
passed).

## Hidden-tab park: acceptance amended

The item's "for now assert no presented-frame progress while hidden" is
IMPOSSIBLE in this harness — measured with worker-rAF probes against both
Playwright flavors (headless shell AND `channel: 'chromium'` new headless):
a `bringToFront()`-backgrounded tab stays `visibilityState === 'visible'`
with worker rAF ticking ~67/s (Playwright disables background throttling by
design). Park remains structural (vsyncWait is a no-timeout futex wait — no
tick, no wake, no fallback); the automated observable lands with 0169's wake
counters; a headed-browser manual check (hide the tab, doom freezes) joins
the per-round human checks. Details + a kernel-stall-based probe idea for
0169 are in the amended acceptance of todos/0167.
