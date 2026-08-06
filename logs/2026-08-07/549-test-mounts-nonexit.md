# #549 — test_mounts.js finishes, then never exits: a Node platform-shutdown deadlock, not a lingering handle

## Symptom

`tests/blockfs/test_mounts.js` intermittently prints its full pass summary
(`test_mounts (blockfs): 8 passed, 0 failed`) and then the process never
exits; the suite runner kills it at the 600 s cap and records
`status: timeout, exit=null`, turning a green gate red (batch-k gate,
2026-08-06).

## The ticket's theory was wrong, and provably so

The ticket (and the kickoff) predicted a lingering event-loop handle — an
unclosed fd, a live timer, an open volume. That theory cannot be right on
inspection alone: the file ends with `process.exit(failed ? 1 : 0)`, which
terminates regardless of open handles. Whatever hung the process hung it
*inside* `process.exit`.

## Instrument

`build/repro-549/loop_mounts.js` (scratch, not shipped): spawns the file
exactly the way `tests/lib/suite-runner.js` does — `-r parent-watch.js`,
`detached: true`, pipe stdio, `CC_HARNESS_GROUP_LEADER=1` — 8-wide in rounds,
and on any child that fails to exit within 15 s captures a **native stack**
with macOS `/usr/bin/sample` before group-killing it.

Reproduced immediately: **2 hangs in ~1600 spawns** (both with the summary
already printed), then on a later baseline **2 hangs in ~140 spawns**. Node
v25.8.2. Samples kept in `build/repro-549/hang-*.sample.txt` (gitignored;
quoted below).

## Mechanism (from the native stacks — 4 captures, one shape)

- **Main thread**: `process.exit(0)` → `Environment::Exit` →
  `DefaultProcessExitHandlerInternal` → `DisposePlatform` →
  `NodePlatform::Shutdown` → `WorkerThreadsTaskRunner::Shutdown` →
  `uv_thread_join` — joining the V8 platform worker pool.
- **node-V8Worker**: a concurrent compile job —
  `MaglevConcurrentDispatcher` in the first two captures,
  `ConcurrentBaselineCompiler` (concurrent Sparkplug) in the two captured
  under `--no-maglev` — inside `Factory::CodeBuilder::BuildInternal` →
  allocation slow path → `CollectGarbageAndRetryAllocation` →
  **`CollectionBarrier::AwaitCollectionBackground`**: parked waiting for the
  MAIN thread to run a GC.

Circular wait: main joins a worker that is waiting for main. This is
upstream **nodejs/node#54918** ("Deadlock at process shutdown",
confirmed-bug); the fix attempt PR #56827 was closed unmerged, and a
follow-up (#57476) also did not land. Unfixed as of v25.8.2.

test_mounts is NOT special — every blockfs member ended with `process.exit`,
and the trigger (a background compile job mid-allocation at exit time) fits
any short script that runs fresh code right up to its last line. test_mounts
was just the file that got caught.

## Fixes measured, and why natural exit won

| candidate | hangs | cost |
|---|---|---|
| baseline (`process.exit`) | 2/~1600, then 2/~140 | — |
| `--no-maglev` | **2/~140 — NOT a fix** (Sparkplug takes over as culprit) | — |
| `--no-concurrent-recompilation --no-concurrent-sparkplug` | 0/9600 | **+17% wall on test_fuzz** (86.1 s → 100.7 s; user CPU unchanged — compiles serialize onto the main thread). Also can't propagate: NODE_OPTIONS refuses V8 flags (exit 9). |
| **natural exit** (`process.exitCode = …`, no `process.exit`) | **0/9600** on the variant, then 0/4800 converted test_mounts + 0/1200 test_stdin_sab + 0/3200 test_openworkspace | **zero** — suite wall time unchanged (86.7 s vs the 85–86 s gate baseline) |

Natural exit works structurally, not by luck: on a normal loop exit Node
disposes the isolate first, which cancels/joins the concurrent compile jobs
while the main thread can still service the collection barrier; only then is
the platform shut down. `process.exit` skips that ordering — that is the bug.

## Change

- All 15 `tests/blockfs/test_*.js` tails converted from
  `process.exit(…)` to `process.exitCode = …` (17 sites; test_e2e.js and
  test_readonly.js each had a catch-path exit too).
- A guard in `tests/blockfs/run.js` refuses any member file that matches
  `/\bprocess\.exit\s*\(/`, with the ticket-cited explanation in the error —
  so the class cannot silently return. The guard carries the one
  authoritative comment; the file tails stay bare.

Controls, all passing:
- Red control: a forced-failure copy under natural exit → rc=1 (the exit
  code still propagates).
- Guard control: reverting one member to `process.exit` → run.js refuses at
  rc=2 naming the file; restored → rc=0.
- Every member run individually → rc=0, prompt exit (all ≤5 s except fuzz).
- Full suite: `blockfs suite: 15 passed, 0 failed (86.7s) [15/15 recorded]`.

## What this does NOT fix (residual exposure, same deadlock class)

Reported to @master rather than absorbed here:

- `tests/blockfs/run.js` itself (and `tests/lib/suite-runner.js`'s other
  runners) still ends with `process.exit`. Deliberate: the runner may hold
  engine-level handles, and converting it would trade a *bounded* 600 s
  timeout red for a potentially *unbounded* wedge of the whole gate if a
  handle ever leaks. Its exposure window is one exit per suite vs one per
  member file.
- Kernel/host/browser suite member files keep `process.exit` — many hold
  real children (boot.js, serve.js, Chromium) where process.exit is
  load-bearing teardown. Converting them needs per-file verification this
  lane did not scope.
- `tests/run.py` spawns many short-lived node children per gate;
  `os/boot.js` children inside kernel e2es exit via the same path. A hang
  there reads as that test's own timeout.

## Dead ends / gotchas

- `--no-maglev` looked like the obvious fix (both first captures were
  Maglev) and is NOT one — concurrent Sparkplug deadlocks identically. Never
  trust the first culprit's name; the class is "any background compile job
  allocating at exit".
- V8 flags cannot ride NODE_OPTIONS (rc=9), so a flag-based fix could never
  have covered grandchildren anyway.
- `git checkout -- <file>` after the guard control silently restored the
  UNCOMMITTED-away original (HEAD still had `process.exit`) — re-conversion
  needed. Commit before running destructive controls.
