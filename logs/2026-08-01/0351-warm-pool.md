# #351 — warm worker pool, refill-on-take (jku's design)

Ticket #351 (gucOS spawn perf STEP 2 — the FIX #350's profile sized). Branch
`0351-warm-pool` off `6d8a0e9a` (which contains #350's instrumentation).

## What landed

A free pool of pre-created `process-worker` realms in `os/kernel-worker.js`,
**refill-on-take** per jku's framing ("cold drinks in a fridge"): take one,
its replacement's creation starts in the same step. Workers stay strictly
**SINGLE-USE** — each realm boots once and dies at process exit exactly as
before; nothing is ever reset, re-armed, or re-shared into a used realm.
Same total worker creations as before (± bounded teardown waste); only the
TIMING of realm-create + importScripts moved off the interactive critical
path.

The implementation is smaller than the ticket anticipated because of one
observation: `new Worker()` returns synchronously and `postMessage` queues,
so a pool entry is usable the INSTANT it exists — a still-importing entry
handed to a spawn is byte-identical to today's create-then-post path. Hence:

- **No readiness handshake, no protocol change.** `os/process-worker.js` is
  UNTOUCHED; `kernel.js` is UNTOUCHED (the ticket's "touches kernel.js" line
  did not survive contact — the kernel calls `_createWorker(procSpec)`
  synchronously and the pool lives entirely behind that seam).
- The pool can never be "caught empty" by a burst: the take's replacement
  exists immediately (merely cold). The genuinely-empty cases are before the
  first spawn, after idle teardown, and `pooldepth=0` — all degrade to the
  synchronous create (`coldCreates` in the stats; never a failure).
- Fill is **fill-to-depth**, not push-one: the same rule restores the
  constant free depth after a take, heals an eviction hole (a worker that
  errors while pooled is evicted, deliberately NOT immediately replaced —
  a dead dev server must not tight-loop worker churn), and re-arms after
  teardown. Free depth == POOL_DEPTH after every spawn, asserted e2e.
- **Single-use tripwire** in `createWorker`: a worker carries the pid it
  served; serving twice throws (kernel.js maps it to EAGAIN + a log). With
  `pool.shift()` + fresh ctors it is structurally unreachable — the throw
  exists so a future edit that breaks that is LOUD, not a corrupted realm.
- **Sizing is #350's data**: depth 3 (refill ≈ 13–15 ms vs burst arrival
  ≈ 10–11 ms/member; 3-way import concurrency measured free). Idle teardown
  60 s (judgment — no #350 datum governs it; bounded waste ≤ depth per idle
  episode). Boot pre-fill falls out of uniformity: the pid-1 spawn's own
  refill-on-take fills the pool during boot (the explicit post-`ready` fill
  is a belt for POOL_DEPTH raises/evictions).
- Seams: `?pooldepth=` / `?poolidle=` ride the worker URL (the hostkeys
  pattern; URL-only — no config residue). `pooldepth=0` IS the pre-#351
  path — `profile-spawn.mjs --nopool` uses it as the same-tree baseline.
  `window.__osPoolStats()` (a `pool-stats` round-trip, answered even on a
  locked tab) exposes {free, depth, created, warmTakes, coldCreates,
  evicted, tornDown, served}.
- Spawn traces gained `warm` + `wBorn`; `os-spawntrace.mjs`'s `k0 < t0`
  ordering assert inverted BY DESIGN (a warm worker is born before the
  spawn) — it now positively asserts `warm && t1 < k0`.
- New sweep member `tests/browser/os-warmpool.mjs` (auto-discovered):
  depth invariant at rest + through a 4-stage pipeline burst, warm first
  command after cold boot, idle teardown (`poolidle=15000`), post-teardown
  cold degradation + re-arm, accounting closure (`served == warmTakes +
  coldCreates`, `created == warmTakes + free + evicted + tornDown`), and
  the two-tab guard leg (the LOSING tab creates zero pool workers).

Node/`boot.js` deliberately keeps the pool-less path: headless spawn latency
gates no user, and pre-booting extra worker_threads per boot multiplies RAM
across the kernel suite's concurrent boots (the heavy-lock policy's exact
concern). Recorded here, not a liability — nothing in the tree claims Node
needs one.

## Before/after (same instrument, same tree, same session shape)

`tests/browser/profile-spawn.mjs` (headless Chromium 149, Mac, serve.js dev;
12 solo reps, 5 bursts). Baseline = `--nopool` (`pooldepth=0`, the pre-#351
path; reproduces #350's 16.8 ms p50 at 17.0).

| metric (ms) | before (pool off) | after (pool on) |
|---|---|---|
| solo `mkdir` spawn → first output, p50 | **17.0** [11.1–18.7] | **3.5** [2.2–3.9] |
| burst member spawn → last event, p50 | 15.8 | 3.9 |
| perceived Enter → usage-error, range | 24.4–41.3 | 19.3–26.7 |
| warm takes | 0 / 35 | 34 / 35 (the 1 cold = pid 1) |

- Solo bootstrap: **17.0 → 3.5 ms p50 (−79%)**. Burst members the same
  (15.8 → 3.9). Every post-boot spawn took a warm worker, including all
  pipeline members — depth 3 + immediate-replacement confirmed at measured
  pacing. (Burst `d_firstOut` barely moves, 21.3 → 19.7: grep/wc first
  output waits on upstream EOF — pipeline execution, not bootstrap.)
- Perceived latency improved by the bootstrap delta; the residual ~20 ms is
  the pre-spawn half (tty round-trip + hush parse), #350's known
  out-of-scope item.
- 🔴 **Dev-cache caveat (carry this whenever quoting these numbers):**
  serve.js sends no cache headers, so the baseline's 11.4 ms importScripts
  span is INFLATED by per-spawn re-fetch of ~1 MB vs the CF-cached deployed
  site. These deltas are **dev deltas, not production deltas** — deployed
  "before" is smaller than 17.0, so the production improvement is smaller
  in absolute terms (the warm path's ~3.5 ms should hold as-is, since it
  does no fetch at spawn time). Also #350's fence stands: the import span
  is one opaque fetch+parse+execute stamp — nothing here relies on which
  component dominates.

## Gotchas for the next reader

- The idle-teardown e2e uses `poolidle=15000`, not something snappier: the
  gap between boot's last spawn (wm) and the test's first typed command is
  seconds under load, and a shorter idle window would tear the pool down
  mid-leg and fail the warm-first-command assert.
- `pool-stats` must be handled BEFORE the `if (!tty)` pending-queue gate in
  kernel-worker's onmessage (the boot-retry precedent): the two-tab leg
  probes a tab that never boots, whose queued messages are never drained.
- image.json deliberately NOT bumped: 211→212 is owed once at coordinator
  level covering #350+#351 together.
