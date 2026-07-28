# 0379 — where cpython-clang's iPhone startup seconds actually go

Lane 0379, 2026-07-28. Ticket: `todos/0379-cpython-startup-latency.md`.
Provenance: jku, first-hand — `python --version` on his iPhone takes ~2 s,
while `tools/bench2x2/results/startup-cpython-clang.txt` says ~96 ms. This log
is the method and the surprises; the ticket carries the conclusions and
options. Drivers preserved next to this file as `0379-*.js` / `0379-*.mjs`
(run from repo root; the browser ones need the tests/browser deps, the Safari
ones `safaridriver` + selenium — the `safari-renders.mjs` toolchain).

## Reconciling the bench first (the paradox was the assignment)

The 96 ms number is from 0332's A/B: **whole-process wall of bare host.js
under Node/V8 on the Mac** — no gucOS, no spawn chain, no browser. Nothing
wrong with it; it measures a different universe than a finger on an iPhone.
The user path is: browser → hush → cmdalt dispatcher → launcher script →
python-clang.wasm, all as separate gucOS processes (Web Workers), on JSC.

Measured end-to-end for `python --version`, same repo state, four universes:

| universe | p50 |
|---|---|
| Node whole-process (the old bench's shape) | ~96 ms |
| gucOS headless (boot.js, minimal image + gucman install) | 260 ms |
| gucOS in Chromium (deploy shape: serve.js --minimal + install) | 190 ms |
| gucOS in **Safari** (same Mac, same image) | **645 ms** |

iPhone CPU is ~2–4× slower than this M-series Mac ⇒ jku's ~2 s IS the Safari
number. Chromium was never the problem; the phone runs WebKit.

## Method notes (worth keeping)

- **Headless per-command timing**: pipe a script into `os/boot.js` and stamp
  `@@MARK` echo lines host-side as they stream (`0379-measure.js`). driveBoot
  is spawnSync and can't do this.
- **Safari timing**: an occluded/unfocused Safari window throttles rAF AND
  timers, so an in-page polling loop reads garbage (first attempt: every
  command "0 ms"). The fix that works: `Object.defineProperty(window,
  '__osOut', {set…})` — stamp `performance.now()` synchronously at tty-mirror
  assignment, plus `osascript … activate` to foreground the window
  (`0379-measure-safari.mjs`). Typed needles split (`GO0""Z`) per the 0171
  rule so input echo can't satisfy the watch.
- `wc`-style truth: `strace -f` in-OS is the spawn census (`0379-chain-probe.js`);
  `-X importtime` prices the import bootstrap from inside.

## What fell to measurement, in order

1. **`--version` does no stdlib work at all.** CPython 3.13 exits inside
   `config_parse_cmdline` (initconfig.c:2606) before path config. In-OS
   strace: **3 RPCs total**. The syscall-storm hypothesis was dead on arrival
   for this command.
2. **pyc is a startup non-factor.** The import bootstrap (importlib, os, site,
   codecs, io…) is FROZEN into the binary; only `encodings/*` come from disk —
   4 .pyc files exist to write, cold ≈ warm (60.7 vs 64.0 ms cumulative
   importtime headless). The launcher's `/var/cache` wiring works as designed
   (`0379-pyc-probe.js`). The CPYTHON.md §5.3 "unmeasured" box is now measured.
3. **The chain is 7 processes** (`0379-chain-probe.js`): hush → cmdalt →
   launcher sh → `$(dirname …)` sh → `$(realpath …)` sh → realpath → dirname →
   wasm. Four spawns exist to compute `dirname $(realpath $0)`. hush runs each
   command substitution as a real subshell process (NOMMU), so the innocent
   one-liner is 4 processes, ~370 ms of the 645 on desktop Safari.
4. **Every browser primitive is FAST in Safari** — this was the real surprise
   (`0379-worker-probe.mjs`, `0379-nested-probe.mjs`): bare Worker 2 ms,
   Worker+importScripts(host.js) 10 ms, nested worker 2 ms,
   `WebAssembly.compile` of the 7.6 MB python binary 10–30 ms, clone+
   instantiate 2 ms, bytes+compile+instantiate ~20 ms. So none of "worker
   startup / compile / instantiate" explains ~200 ms per spawn.
5. **The 200 ms is execution tier, and it follows the Module object.**
   In-OS Safari: `/bin/true` (a real spawn of the busybox multicall) cost
   ~200 ms for the first ~3 spawns then dropped to **22 ms** — and realpath +
   `sh -c :` (the SAME module) were warm from the start
   (`0379-measure-safari2.mjs`). JSC attaches its wasm JIT code to the
   `WebAssembly.Module`; the kernel module cache (todos/0037) shares that
   object across spawns — but only for RO-volume binaries. `/opt` (gucman
   installs) takes the bytes path: fresh Module per spawn, all run-once init
   interpreted cold, every time, and the JIT work discarded with the worker.
6. **Proof by one-line experiment**: letting `/opt/*.wasm` ride the module
   cache (throwaway kernel.js edit, no invalidation) took Safari
   `python --version` 645 → 151 ms and `python -c pass` 1139 → 209 ms.
   Replacing the launcher with a spawn-free known-prefix exec took the full
   dispatcher path to **68 ms / 109 ms** warm p50. Ten-fold, both fixes cheap
   in code — but the cache needs a real invalidation design (the
   `cc -o a.out && ./a.out` loop must never see a stale Module), so it's an
   option in the email, not a landed change.

## Honest edges

- **JSC warmth is fickle**: across sessions the busybox module sometimes sat
  cold at ~200 ms/spawn for whole runs (memory churn / jettison?), sometimes
  warmed in 3 spawns. All raw rep lists are in the ticket-linked outputs;
  p50s only in the ticket table.
- **The fat-image leg failed**: serve.js's fold does not carry
  `requires: clang-sibling` packages, so `/usr/opt/python-clang` doesn't exist
  on the fat fixture and the RO-volume control run was rc=127. The /bin/true
  warmup observation covers the same question from the other side.
- **iPhone itself: unmeasured.** Desktop Safari + a 2–4× CPU scale is the
  model; the model reproduces the ~2 s observation, but on-device
  verification needs a deployable test build.
- First-run-in-session stays cold (one full compile+init) under every option
  short of prewarming at install/boot.
