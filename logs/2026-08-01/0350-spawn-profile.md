# #350 — in-browser per-phase profile of the per-spawn worker bootstrap

Ticket #350 (gucOS spawn perf STEP 1). Numbers only — the pool is #351,
hard-blocked on this. Diagnosis being verified:
`meta/gucos/notes/slow-command-startup-diagnosis.md` (external repo).

## What landed

A **default-off spawn trace** (`?spawntrace=1` on os.html → forwarded on the
kernel-worker URL, the hostkeys pattern):

- `os/process-worker.js` stamps its first line and importScripts-done
  (`timeOrigin + now()` absolutes — comparable across workers). These two
  clock reads are the ONLY always-on cost; everything else gates on the boot
  message's `spawnTrace` flag.
- Trace-on: `WebAssembly.Instance` is wrapped for the instantiate span, and
  `rfs.write` for first fd-1/2 output. Fragments post **at the event**
  (instantiate / first output), NOT after exit — under the kernel the exit
  handshake is a SAB RPC and the worker is terminated before `runModule`'s
  promise resolves, so a post-exit postMessage is silently lost (found the
  hard way: the first cut posted in `.then` and nothing ever arrived).
- `os/kernel-worker.js` stamps ctor/postMessage around `new Worker`, merges,
  posts to the page; `os.html` merges fragments by pid onto
  `window.__spawnTraces` (agent probe).
- `tests/browser/os-spawntrace.mjs` — the (HP) positive control: a sweep
  member proving the ON path emits (off path = every other sweep file).
- `tests/browser/profile-spawn.mjs` — the measurement harness (manual, not
  a sweep member): solo mkdir reps, `ls | grep x | wc -l` bursts, perceived
  Enter→output latency, in-page parse cross-check. #351 reuses it for
  before/after.

## Numbers (headless Chromium 149, Mac, serve.js dev; 2 runs, reproducible)

Solo no-args `mkdir` (12 reps), spawn-entry → first output **p50 16.8 ms**
[11.1–18.5]:

| phase | p50 ms | % of 16.8 |
|---|---|---|
| kernel thread (`new Worker` ctor + boot post) | 0.1 | 0.6% |
| (a) realm create (ctor → worker first line) | 3.2 | 19% |
| (b) importScripts (fetch+parse+exec, 1040 KB) | 11.2 | 67% |
| boot-msg wait | 0.2 | 1% |
| boot setup (RemoteFS + RO mount + preamble) | 1.8 | 11% |
| (c) WASM instantiate (Module cache hit) | 0.1 | 0.6% |
| main() → first write | 0.5 | 3% |

- **(b) importScripts dominates; (c) confirms todos/0037 still fully works.**
- **The 27 ms headless figure is NOT a browser floor**: browser p50 is
  16.8 ms, LOWER. A Node worker_threads realm + CJS loads is simply heavier
  than a Chromium dedicated worker + importScripts. The "floor" framing did
  not survive contact.
- Parse cross-check: in-page compile-only (shebang stripped) host.js 6.4 ms
  + kernel.js 3.5 ms cold, 0.65 ms total warm — same order as the ~5.5 ms
  Node claim. Raw parse is NOT the bulk of (b); fetch is: serve.js sends
  **no cache headers**, so every spawn re-fetches both files (~1 request per
  file per spawn in the log; page-side uncached fetch ≈ 2.7–6.6 ms/file).
  The deployed site (CF max-age) HTTP-caches, so deployed (b) is likely
  smaller than dev-measured, not larger.
- Perceived Enter → usage-error on screen (6 reps, ±4 ms poll): **23–40 ms**,
  of which Enter → spawn-entry (tty round-trip + hush read/parse/vfork) is
  9–18 ms. The worker bootstrap is only ~half of what a user feels; the
  pre-spawn half is hush/tty pacing, out of #350/#351 scope but worth a
  future look.
- Pipeline burst (`ls | grep x | wc -l`, 5 reps): members' spawns arrive
  **9.6–12.5 ms apart** (hush-paced; the kernel replies to SPAWN
  synchronously — `_spawnImage` returns `{pid}` with no child-boot wait).
  Import spans overlap ≈ 0 ms as a consequence. Under 3-way concurrent
  bootstrap, (b) does NOT inflate (p50 9.2 vs 11.2 solo) and kernel-thread
  cost stays 0.1 ms — refill genuinely runs concurrently (acceptance 5,
  measured, not assumed).

## Pool sizing (for #351)

- Refill (realm + import) ≈ **13–15 ms** cold.
- Burst arrival ≈ 10–11 ms/member: depth 1 misses member 2 by ~3–5 ms;
  depth 2 covers the 3-member pipeline at measured pacing; **recommend
  depth 3** — headroom for the un-root-caused hush pacing (which may shrink
  once the bootstrap leaves the loop) and 4-stage pipelines. Refill-on-take,
  concurrent (contention measured ≈ none).

## Item-6 ruling (import shrink): NOT justified now

(b) does dominate (67% vs 19% realm-create), so the precondition holds —
but the pool already moves the entire a+b (~14 ms) off the interactive
critical path, after which the shrink only shortens off-path refill
(13–15 → maybe ~half) and idle-pool memory. Not worth its refactor cost on
these numbers; revisit only if #351 shows refill losing to bursts on slow
devices or pool memory mattering. Cheaper adjacent win noticed: serve.js
could send cache validators so dev spawns stop re-fetching 1 MB.

## Trace disposition

Left in permanently, default off: #351 needs identical instrumentation for
its before/after. Cost when off: two `performance.now()` calls per spawn.
Positive control: `os-spawntrace.mjs` (per HP).
