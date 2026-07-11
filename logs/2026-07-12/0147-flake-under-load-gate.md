# 0147 — test flake / under-load gate

`todos/0147`. The 0083/0154/0155 sweep retired the fixed-`sleep` sync class
from the whole kernel e2e estate; nothing, though, actually *ran* tests
repeatedly or under contention to prove they STAY event-clean or to catch a
new test reintroducing sleep-debt. This adds that gate.

## What landed

Everything is built on the shared `tests/lib/suite-runner.js` engine (0081),
so all three suite-runner-backed suites (kernel, blockfs, browser sweep) get
the new modes for free:

- **`--repeat N`** — fan each selected file into N runs (each with its own
  `.repN.log`), then aggregate a per-file **flake rate**: a non-flaky file is
  `N/N` green, a mixed verdict prints `FLAKY … p/N passed (flake X%)` and the
  suite exits non-zero. Conflicts with `--resume` (resume would skip a file
  the gate wants to hammer) — repeat wins. The N runs schedule through the
  normal worker pool, so with `-j>1` they already contend against each other.
- **`--under-load[=N]`** — spawn N busy-loop generators (bare flag = one per
  core) that peg cores for the whole run, then die. Each is a detached
  `node -e` doing real `Math.sqrt` arithmetic (V8 can't fold it) until a far
  deadline. **Self-heal:** each checks `process.ppid` per batch and exits when
  reparented, so a SIGKILL of the runner can't leave a core pegged for the
  hour-long backstop. Killed on suite completion AND on SIGINT/SIGTERM (added
  to the existing interrupt path).
- **comma-OR `--filter`** — `--filter=wm,term` now selects any file matching
  wm OR term. This is what lets the gate pick the tripwire SET in one runner
  invocation (so the files contend against each other), not one substring at a
  time. Exposed as `matchesFilter()`; `tests/kernel/run.js`'s image-bake gate
  uses it too so a comma filter still bakes.
- **`tests/flake.js`** — the tripwire wrapper. Names the historically
  sleep-sensitive set (kernel `wm_service`/`term`/`os_apps` e2es + browser
  `os-doom`/`os-term`) and runs each leg with `--repeat 3 --under-load`. The
  browser leg is optional (degrades to skip where Playwright is absent). A
  user `--filter` intersects the tripwire set. Flags: `--repeat N`,
  `--no-under-load`, `--under-load=N`, `--kernel-only`.
- **`tests/run.js`** forwards `--repeat`/`--under-load` to the suite-runner
  suites (added to their `supports`), and a RULES entry maps `tests/flake.js`
  to no suite of its own (it's an orchestrator).

The per-run records + a `flake` array land in each suite's `summary.json`.

## Why a busy-loop generator, not a second suite

The plan floated "a second kernel suite OR a CPU-load generator". A second
suite is non-deterministic contention (depends on where the other suite is in
its own schedule) and doubles the image-bake cost. Busy loops are
deterministic, portable, and dialable (`=N`) — the same contention every run.
Cross-file contention within the tripwire set is still there for free (the
files run together through one runner).

## Verification

- `node tests/flake.js --repeat 2` — **both legs green under load ×10**:
  kernel (os_apps/term/wm_service, 3×2) + browser (os-doom/os-term, 2×2, real
  Chromium — Playwright IS installed on this box despite the prior handoff
  note). Post-0083/0155 the sleep flake class is clean under contention. No
  load generators leaked (`pgrep -f Math.sqrt` → 0 after).
- `node tests/run.js blockfs` — full suite green (15/15); the shared engine's
  normal (non-repeat) path is unregressed.
- `--filter=test_tlsf.js,posix` correctly ORs to exactly those two files
  (not `tlsf64`).
- `node tests/run.js --diff --dry-run` — every changed path maps, no UNMAPPED.

## Acceptance (from the item)

- `--repeat 5 --filter os-doom` runs it N× + flake rate → yes
  (`node tests/browser/os-sweep.mjs --repeat 5 --filter=os-doom`; validated
  at repeat 2 through the gate).
- under-load reproduces/clears the sleep class on demand → `--under-load`
  clears it post-0083 (green ×10); it's the knob to turn a latent
  sleep-dependency into a failure on an idle box.
- documented as the post-e2e gate → CLAUDE.md "Flake / under-load gate".
