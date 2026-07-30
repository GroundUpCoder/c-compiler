# 0439 — A benchmark lane can leak an unbounded `node host.js` process that burns cores for days

- **Status**: open
- **Priority**: 2
- **Difficulty**: light
- **Provenance**: found by the todos/0435 lane while measuring comguc boot-to-ready timing on
  2026-07-30, and confirmed by the coordinator before the processes were killed. Not introduced
  by 0435.

## The gap

Two orphaned benchmark processes from the **closed** todos/0332 lane were still running, and had
been since 2026-07-27:

```
13487  02-13:28:52     0:00.00  /usr/bin/time -p node --experimental-wasm-exnref host.js /tmp/v177m/sb/bin.cap65520.wasm
13490  02-13:28:52   566:47.93  node --experimental-wasm-exnref host.js /tmp/v177m/sb/bin.cap65520.wasm
13543  02-13:28:27     0:00.00  /usr/bin/time -p node --experimental-wasm-exnref host.js /tmp/v177m/sb/bin.cap512.wasm
13546  02-13:28:27  3623:37.99  node --experimental-wasm-exnref host.js /tmp/v177m/sb/bin.cap512.wasm
```

**2 days 13 hours of wall clock, and ~4190 CPU-minutes (~70 CPU-hours) burned** — about 1.15 cores
held continuously by work whose ticket had already closed. They were `nice 5`, which is why nobody
noticed. The fixtures live in `/tmp/v177m/`, so the run cannot even be reproduced after a reboot.

## Why it matters more than one leaked process

1. **It silently taxes every later measurement on this box.** The 0435 lane's whole deliverable was a
   boot-to-ready *timing distribution*, and it measured its "quiet" baseline while these two were
   holding ~1.15 cores. 0435's numbers survive — the contamination makes them **conservative**, so
   its 92x-margin conclusion strengthens rather than weakens — but that was luck, not design. A
   timing ticket that happened to conclude the other way would have been silently wrong.
2. **Nothing bounds it and nothing reports it.** `host.js` has no wall-clock ceiling of its own, the
   `/usr/bin/time -p` wrapper does not impose one, and the lane that started it closed its ticket
   without ever reaping it. A lane that dies mid-turn (backend restart, `stop`, crash) leaves the
   child running with no record that it exists.
3. **`timeout` is not installed on this box**, so the obvious one-line fix is unavailable and every
   lane has to solve it itself — which means no lane does.

## Plan

1. Give `host.js` an **optional wall-clock ceiling** that is ON by default for benchmark-style
   invocations, and make exceeding it exit non-zero with a message naming the elapsed time and the
   module. Derive the default from what the existing benchmarks actually need; do not guess a number
   and do not make the ceiling so large it never fires.
2. **Close the class, not the instance.** Add a reaper/guard that a lane can rely on, so "I started a
   long benchmark and my turn died" cannot leave an unbounded process. Name the choke point — the
   place every benchmark invocation actually passes through — and prove it dominates with a COUNT of
   the invocation sites, rather than patching the two that todos/0332 used. `todos/0342` is the
   precedent for proving a choke with counts (it found a claimed choke covered 1 of 8 paths).
3. Record the reaping requirement in the lane protocol so it propagates through kickoffs, the way the
   heavy-lock rule does. A finished lane teaches nobody; it propagates through kickoffs.

## Acceptance

- A benchmark invocation that exceeds the ceiling **exits non-zero** and names the elapsed time and
  the module. A test proves the ceiling fires — an unproven guard is indistinguishable from no guard.
- A COUNT of benchmark invocation sites tree-wide, with the fraction the guard covers, and any
  deliberate exclusion recorded explicitly.
- `ps` shows no surviving benchmark child after the guard fires.
- `node todos/queue.js check` passes, and the suites the planner selects
  (`node tests/run.js --diff`) are green and reported with a NUMBER.

## Notes

The four processes above were **killed by the coordinator on 2026-07-30** after the 0435 merge, so
the instance is resolved and only the CLASS is open. Do not re-hunt those pids.
`timeout` is NOT installed on this box — do not write a fix that depends on it.
The `todos` suite checks `todos/LIABILITIES.md`; if a change here rewrites an anchored line,
re-anchor or retire the entry in the same commit.
