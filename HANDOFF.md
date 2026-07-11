# Handoff — start of thread (updated 2026-07-12; 0147 flake/under-load gate landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0147 (test flake / under-load gate) is DONE and committed.** The 0083/0154/
0155 sweep retired the fixed-`sleep` sync class from the whole kernel e2e
estate; 0147 adds the gate that proves it STAYS retired and catches a new test
reintroducing sleep-debt.

- **`tests/lib/suite-runner.js`** grew three generic modes (all suite-runner
  suites — kernel/blockfs/browser sweep — inherit them, `tests/run.js`
  forwards them):
  - **`--repeat N`** — run each selected file N× and print a per-file **flake
    rate** (non-flaky = `N/N` green; any mixed verdict fails the suite).
    Conflicts with `--resume`; repeat wins.
  - **`--under-load[=N]`** — N busy-loop CPU generators (bare flag = one per
    core) peg cores for the run, then die. **Self-heal:** each watches
    `process.ppid` and exits when reparented, so a SIGKILL of the runner can't
    leave a core pegged. Killed on completion + on SIGINT/SIGTERM.
  - **comma-OR `--filter`** — `--filter=wm,term` = wm OR term (exported
    `matchesFilter`; the kernel bake-gate uses it too).
- **`tests/flake.js`** — the tripwire gate: runs the historically
  sleep-sensitive set (`wm_service`/`term`/`os_apps` kernel e2es +
  `os-doom`/`os-term` browser sweeps) `--repeat 3 --under-load` by default.
  Browser leg optional (skips where Playwright is absent). Flags: `--repeat N`,
  `--no-under-load`, `--under-load=N`, `--kernel-only`, `--filter=S`.
- **Documented** in CLAUDE.md "Flake / under-load gate" as the gate to run
  after any new e2e/browser test lands.

Dev log: `logs/2026-07-12/0147-flake-under-load-gate.md`. Item:
`todos/done/0147-test-flake-gate.md`.

## Tests / verification

- **`node tests/flake.js --repeat 2` — both legs GREEN under load ×10**:
  kernel (os_apps/term/wm_service, 3×2) + browser (os-doom/os-term, 2×2, real
  Chromium). Post-0083/0155 the sleep flake class is clean under contention.
- No load generators leaked (`pgrep -f Math.sqrt` → 0 after every run).
- `node tests/run.js blockfs` — full suite green (15/15); the shared engine's
  normal (non-repeat) path is unregressed.
- `node tests/run.js --diff --dry-run` — every changed path maps, no UNMAPPED.

## Gotchas carried forward (trimmed to the live ones)

- **Playwright IS installed on this box** (the prior handoff said it wasn't —
  the flake gate's browser leg ran real Chromium and passed). The browser
  sweep is still `optional` in the harness (skip on can't-launch), but here it
  runs. Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- **The prebaked `os/os-system.img` re-bakes when a seeded source is newer**
  than the blob (0082 input-staleness). `os/wmctl.c` was newer than the
  committed-era blob, so the gate baked once (90s) up front — expected, not a
  regression. Image version is v75. Bump `image.json` `version` on a seeded
  `os/*.c/.h/.rc` or `compiler.js`/`host.js`/`vendor/` edit or a persistent
  browser OPFS image won't re-fetch. (CLAUDE.md prose still says "v64" — stale;
  `image.json` version is 75.)
- **`queue.js done` stages a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (done this session; verified the staged
  blob carries the DONE Status line).
- **Concurrent sessions may exist: stage ONLY your own files**; re-check HEAD
  before committing.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. Head is now **0079**
(project dep dedup), then **0080** (cairo pdf/svg surfaces), **0052/0053**
(loopback AF_INET / curl-over-fetch), **0064** (WM browser sweep). No open P0s.
**0148** (test-tightness sweep) is the natural companion to 0147 — it can now
lean on the flake gate as its regression check.

## Operator-owed (browser, Playwright required — but it IS here)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check).
- **0152** — a `--clang` browser boot confirming the served overlay renders.
- **0153** — run `os-sweep.mjs` to validate the 0146/0083 harness conversions.

`node tests/run.js sweep` runs the whole sweep; `node tests/flake.js` is the
new repeat/under-load tripwire for the sleep-sensitive subset.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0155's recorded decisions (see todos/done/). **0147's
call: the flake gate uses busy-loop CPU generators, NOT a second suite, for
contention — deterministic, portable, dialable (`--under-load=N`), and it
avoids doubling the image-bake cost; cross-file contention within the tripwire
set is free (the files run together through one runner).**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0147 flake/under-load gate
just landed: `tests/flake.js` + suite-runner `--repeat N`/`--under-load[=N]`/
comma-OR `--filter`, both legs green under load ×10; head is now 0079; no open
P0s)."
