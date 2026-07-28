# todos/0369 — step 2, the STATIC half: fixed timeouts in the harness layer

Two harness timeouts fired under lane contention in one day (`test_os_boot.js`
at the kernel runner's 900 s cap; `int_big_lshift.py` at run.py's 15 s
micropython-upstream cap). This log is the population claim behind those two
anecdotes: **every fixed timeout in the harness layer, by command and count,
with a positive control.** It is the static half of step 2 only — the
per-test-under-contention timing half needs the heavy lock and is deliberately
NOT run here (the P0 merge chain owns the lock today).

## The command

Committed as `tests/scan-harness-timeouts.sh` (the `tests/scan-wallclock.sh`
precedent from 0361), run from the repo root. Two greps:

1. an over-inclusive line scan over the HARNESS set — `tests/run.js`,
   `tests/run.py`, `tests/run-unit.js`, `tests/flake.js`, the five suite
   runners (`kernel`/`host`/`blockfs`/`todos`/`ext`), `tests/browser/os-sweep.mjs`,
   and `tests/lib/*.js` (a glob, so a new lib file joins the population
   unedited) — matching `setTimeout`/`setInterval`/`AbortSignal.timeout`/
   `Atomics.wait`, any `timeout*`-named key or assignment (ANY right-hand
   side — a digit-anchored pattern provably missed
   `timeoutMs: long ? 3600000 : 600000` during authoring), `*_MS`/`*_SECS`
   constants, and `Date.now()+N` deadline arithmetic;
2. the per-test `"timeoutMs"` override channel in `tests/unit/**/config.json`
   (run-unit.js honors it; the scan covers the channel even at zero users).

The population is the harness — runners, dispatcher, `tests/lib/` — NOT the
tests themselves. 0361 owns wall-clock assertions inside tests; fixed waits
inside individual test files are a third layer neither survey has enumerated.

## The count

**105 matched lines** (grep 1: 105; grep 2: 0), across 12 of the 17 files
scanned. Every line classified by hand:

### (a) Verdict-deciding caps — 66 lines: 60 fixed constants + 6 enforcement sites

The class this ticket is about: a timeout here decides pass/fail.

**`tests/run.py` — 42 fixed constants** (+ 4 enforcement lines applying an
already-counted parameter: 259, 676, 1354, 1359). By category, in seconds:

| category | build cap | run/other caps |
|---|---|---|
| unit/extra via run.py | compile 30 (L297) | run 30 (L210 default, L335, L338) |
| projects | — | 30 (L545) |
| zlib | — | 15 (L578, L606, L634) |
| `build_project` default | 300 (L668) | — |
| lua | — | 15 (L715) |
| freetype | — | 30 (L754) |
| cairo | 300 (L794) | 120 (L800) |
| libpng | — | 30 (L843) |
| micropython genhdr-sync | — | 300 (L916) |
| micropython | 600 (L939) | 30 (L960) |
| micropython-upstream | 600 (L1029) | CPython oracle 10 (L1070), **per-test 15 (L1093) ← occurrence 1's cap** |
| sqlite | 600 (L1123) | 60 (L1168) |
| disw | — | 10 (L1263, L1277) |
| tcc | 300 (L1344) | 30 (L1351, L1356 defaults) |
| libc | — | 120 (L1508), 60 (L1514) |
| fuzz (csmith) | — | 300 (L1561), 60 (L1567, L1600), 120 (L1603), 10 (L1607) |
| sourcemap | — | compile 30 (L1654), run 10 (L1662) |
| ast | — | 30 (L1694) |
| ext | — | 120 (L1718) |
| blockfs (py) | — | 120 (L1745) |
| fakegit | 600 (L1793) | 60 (L1783, L1828) |

**JS harness — 18 fixed constants** (+ 2 enforcement sites: `run-unit.js:509`,
`suite-runner.js:377`):

| where | cap |
|---|---|
| `run-unit.js:398` | per-TEST default **30 s** (config.json `"timeoutMs"` override channel: **zero users today**) |
| `suite-runner.js:103` | per-FILE default **600 s**, every suite-runner suite |
| `kernel/run.js:175` | suite default 600 s |
| `kernel/run.js` per-file overrides | **900 s ×9** (L70 `test_os_boot` **← occurrence 2's cap**, L121 cmdalt, L156 cc_win32, L157 gucman, L158 clang_pkgs, L160 seed, L161 gucman_quake, L162 fontpkg, L163 software); **1200 s ×1** (L159 cpython_clang); 600 s ×2 redundant-explicit (L153, L155) |
| `blockfs/run.js:37,40` | fuzz **3600 s** under `--long`, else 600 s; suite default 600 s |
| `os-sweep.mjs:43` | suite default 600 s |

### (b) `except subprocess.TimeoutExpired` handlers — 14 lines

Kept in the scan deliberately: they document which run.py caps are *handled*
(reported as a test failure). 14 handlers against 42 constants, and the
difference is not shared trys: **verified by reading the enclosing functions
and `main`, the category loop is unwrapped, so a cap firing in a
handler-less site — zlib's three 15 s sites, projects, freetype, cairo's
120 s run, libc, disw, tcc's run wrappers, sourcemap, ast, ext,
blockfs-py — raises `subprocess.TimeoutExpired` straight out of `main` and
crashes run.py with a traceback: no summary, no per-test FAIL record.** The
caps that ARE handled (unit, lua, libpng, genhdr, both micropython
categories, sqlite, fuzz, fakegit, `build_project`) record an honest
failure. So the failure MODE of a cap firing is inconsistent across
categories — a second defect in the same surface, recorded in the ticket.

### (c) Teardown / cleanup / poll timers — 13 lines, never decide a verdict

run.py reader/feeder `join(timeout=1..2)` post-verdict drains (L264/265/266/461);
suite-runner `KILL_GRACE_MS` 400 ms SIGTERM→SIGKILL grace (L72/85/88) and the
under-load generator's 3600 s self-heal backstop (L416); harness-leaks
staleness thresholds 2 h/6 h + reaper backoff wait (L69/72/228); parent-watch
1 s orphan poll (L32/42).

### (d) Plumbing / docs / false positives — 12 lines

Flag parsing (`run-unit.js:406,407`, `suite-runner.js:112,113`), usage text
(`run-unit.js:419`, `suite-runner.js:151,156`), pass-through of an
already-counted option (`kernel/run.js:212`, `blockfs/run.js:48`,
`os-sweep.mjs:73`), comments (`flake.js:60`; `kernel/run.js:65` — the matched
`timeout=28` is a curl EXIT CODE in prose, the survey's one true false
positive).

66 + 14 + 13 + 12 = 105. ✅

### Negative findings — the zeros that are load-bearing

- **`tests/run.js` (the dispatcher), `tests/host/run.js`, and
  `tests/todos/run.js` have NO timeout at any layer** — `spawnSync` with no
  `timeout` option, no outer cap. A hung host or todos test hangs the run
  forever. That is the *opposite* failure mode from this ticket's headline,
  and step 3's cap design should cover it rather than a separate ticket
  (recorded in the 0369 body; same family, per the fold-don't-file rule).
- `tests/ext/run.js` is itself uncapped but only reachable through run.py's
  ext category, which wraps it at 120 s.
- `AbortSignal.timeout`: zero uses in the harness.
- The config.json `"timeoutMs"` per-test override: mechanism live, zero users.

## Positive control (lesson AZ)

Three decoys, one per discovery channel — a NEW file under the `tests/lib/*.js`
glob, a line smuggled into a listed file that previously had **zero** hits
(`tests/todos/run.js`), and a `config.json` in the second grep's channel:

```
$ sh tests/scan-harness-timeouts.sh | wc -l          # baseline
     105
$ # plant tests/lib/zz-decoy-0369.js      (setTimeout(() => {}, 1234))
$ # plant `const timeoutMs = 5000;` into tests/todos/run.js
$ # plant tests/unit/zz_scan_control_0369/config.json ({ "timeoutMs": 60000 })
$ sh tests/scan-harness-timeouts.sh | wc -l
     108
$ diff base ctrl
88a89
> tests/todos/run.js:62:const timeoutMs = 5000; // 0369 positive-control decoy
105a107,108
> tests/lib/zz-decoy-0369.js:2:setTimeout(() => {}, 1234);
> tests/unit/zz_scan_control_0369/config.json:1:{ "timeoutMs": 60000 }
$ # decoys removed
$ sh tests/scan-harness-timeouts.sh | wc -l
     105                                              # diff vs baseline: empty
```

All three found; baseline restored exactly after removal.

## What this survey does NOT establish

- **It is static. It measures no execution time and therefore no headroom** —
  neither quiet nor loaded. Nothing in this log ranks which cap fires next.
- Per the ticket's ruling, `quiet_wall / cap` is a REJECTED ranking
  (`int_big_lshift.py`: 7.1 s quiet against 15 s — 53% apparent headroom — and
  red under load anyway). This survey emits no such ratio and none should be
  derived from its table. The per-test headroom half of step 2 must be
  measured UNDER CONTENTION, needs the heavy lock, and remains open.
- The scan sees timeout *sites that match its patterns*. A deadline built
  from a constant named neither `timeout*` nor `*_MS`/`*_SECS`, applied
  without `setTimeout`/`Atomics.wait`/`Date.now()+N`, would evade it. The
  positive control proves the channels it scans, not the absence of channels
  it doesn't.
- Fixed waits inside individual TEST files (as opposed to harness caps) are a
  third layer: 0361 covered wall-clock *assertions* in `tests/unit/**`; nobody
  has enumerated fixed waits in the kernel/browser e2e test bodies. Not
  expanded here — out of this bounded unit's scope.
