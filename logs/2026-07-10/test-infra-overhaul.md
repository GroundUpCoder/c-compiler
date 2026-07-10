# Test-infrastructure overhaul: the runner layer (todos/0081)

0081 was an architecture item born at the 0061 close: the kernel suite
had grown into a ~20-minute serial monolith that twice died with the
session and left no verdict, the browser sweep was 15 hand-run Chromium
scripts, and none of it left artifacts. The brief: survey → measure →
land the load-bearing layer → spawn sub-items for the rest.

## What the measurements said

First honest numbers (from the new runner's own `summary.json`):

- Kernel suite serial cost: **1354s across 40 files — but 16 files
  >30s carry 1315s (97%)**. Every heavy file is a boot.js e2e whose
  cost is BAKING a full system image (compiling every seeded source and
  vendor binary through compiler.js) into its private tmp `--image=`
  pair. The 24 protocol/no-wasm files sum to ~40s — free.
- The browser sweep's "1–2 minutes per file" lore turned out to be the
  same bake, paid in-worker: with a fresh prebaked `os/os-system.img`
  on disk (kernel-worker's fetch path), the FULL 15-file sweep runs in
  **~70s**. Headless boot.js has no such path — that asymmetry is the
  whole remaining cost, now owned by todos/0082.
- Sleep-based sync sites: ~145 `sleep N` in kernel e2e scripts + ~60
  fixed delays in browser tests → todos/0083.

## What landed

One engine, three thin runners:

- **`tests/lib/suite-runner.js`** — for file-granular suites (each test
  file an executable exiting 0/1; contrast run-unit.js's per-TEST
  worker model, which stays the template for fine-grained suites).
  Worker pool with longest-first scheduling seeded from the previous
  run's timings; per-file timeout with process-GROUP kill (`detached` +
  `kill(-pid)`) so a hung test's boot.js/Chromium children die with it
  — verified with a deliberately hung grandchild; per-file logs; a
  `summary.json` checkpointed by atomic rename after EVERY completion,
  so an interrupted session keeps a partial verdict (the exact failure
  mode that motivated the item); `--resume` skips prior passes.
- **`tests/kernel/run.js` v2** — the annotated file table stayed, the
  serial loop became the engine. Default `-j4` (capped cpus−2): full
  suite **40/40 in 393s ≈ 3.4x** over serial, zero flakes. Parallelism
  is safe by construction, and was audited: every e2e isolates via
  mkdtemp + `--image=`, no shared ports, no shared build/ writes,
  in-OS `/tmp` paths live inside each private image.
- **`tests/browser/os-sweep.mjs`** — the sweep as one command. It
  DISCOVERS `os-*.mjs` so new acceptance files join without touching a
  list; deliberately serial (0045 boot lock + contention — a `-j` is
  rejected loudly). 15/15 green, 281 checks, os-shell.mjs run first
  (the check owed from the 0061 close) and the second invocation
  exercised `--resume` for real.
- **`tests/blockfs/run.js`** — same conversion for free; wall-clock is
  now just the fuzz file (121s), the serial tail is gone.

## Decisions / gotchas

- **Parallel default is 4, not cpus−2**, for the kernel suite: the
  boot-heavy files each run several worker_threads and the e2e scripts
  still sync on in-OS `sleep N` — oversubscription is how the 0074
  flake class gets induced. Bump with `-j` on an idle box; revisit
  after 0083 kills the sleep class.
- **The sweep stays serial by design**, not by convention — encoded in
  the tool now, with the rationale in the header.
- Timeout kills the process GROUP. spawnSync'd boot.js children used
  to outlive killed tests; that's what left orphaned node processes
  after interrupted suite runs.
- The engine sorts by last-run duration descending; a no-history file
  runs first (unknown = expensive until measured).
- `--resume` trusts file-level PASS only; failures/timeouts/missing
  rerun. Summary artifacts live in `build/test-{kernel,browser,blockfs}/`.

## Residue (owned)

- **0082** prebaked-image fixture for boot.js e2e (and input-freshness
  gating for BOTH prebake paths — a same-version blob baked before an
  uncommitted compiler.js edit must not be silently reused).
- **0083** event-based waits to retire the ~205 sleep sites (the flake
  floor once 0082 removes the bake).
- **0084** unified entry point + diff-aware suite selection (the "what
  does this diff need" lore → tooling).

Verification this session: kernel 40/40 (393s, -j4), browser sweep
15/15 (~70s + 5s os-shell-first leg), blockfs 15/15 (122s), engine
fail/timeout/group-kill/resume paths exercised. The full-suite +
15/15-sweep debt from the 0061 close is paid.
