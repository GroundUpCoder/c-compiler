# todos/0361 — unit tests that assert a wall-clock threshold

The `unit` suite is the cheap, always-run, *if-this-is-red-something-is-broken*
tier. On 2026-07-27 the 0340 merge gate went red on `unit/stdlib/usleep_zero`
with three other lanes live, and green on the re-run with nothing changed. The
expensive cost of that is not the re-run: it is that a red `unit` starts reading
as "probably just load", and that habit is what lets a real regression through.

## The survey — a population claim

Command (committed as `tests/scan-wallclock.sh`, run from the repo root):

```
grep -rlE '\b(clock_gettime|gettimeofday|time[[:space:]]*\(|clock[[:space:]]*\(|times[[:space:]]*\(|difftime|timespec_get|st_[amc]tim|st_[amc]time|alarm[[:space:]]*\(|setitimer|getitimer|CLOCK_[A-Z_]+|SDL_GetTicks|SDL_GetPerformanceCounter|emscripten_get_now|__builtin_readcyclecounter|rdtsc)' \
  tests/unit --include='*.c' --include='*.h' | sort
```

Population: **790** leaf tests under `tests/unit/**` — the same discovery
`run-unit.js` does, and it reconciles with the run (786 passed + 1 xfail + 3
skipped). The survey itself was taken at 789, one commit before the rebase onto
`origin/main` @ `c620e889` added one; the clock-reading set is unchanged by it.
Of those, **24 files read a clock at all**, which is the *necessary* condition
for pass/fail to depend on elapsed time. Reading a clock is not sufficient, so
all 24 were classified by hand:

**(a) UPPER-BOUND elapsed budget — the load-fragile class. 8 of 24.** These are
statements about the machine and are the only ones that can go red because
another lane is busy.

| test | budget |
|---|---|
| `stdlib/usleep_zero` | `ms < 100` over 20 × `usleep(0)` |
| `blockfs_usleep_zero` | `ms < 100` over 20 × `usleep(0)` |
| `stdlib/usleep` | `elapsed_us < 500000` |
| `blockfs_usleep` | `elapsed_us < 500000` |
| `stdlib/nanosleep` | `elapsed_us < 500000` |
| `blockfs_nanosleep` | `elapsed_us < 500000` |
| `stdlib/select_timeout` | `elapsed_us < 500000` |
| `blockfs_select_timeout` | `elapsed_us < 500000` |

**(b) ONE-SIDED LOWER BOUND — contention-monotone, cannot go red from load. 3.**
`stdlib/sleep_suspends` (`ms >= 900`), `blockfs_sleep` (`ms >= 900`),
`sdl_delay_sleeps` (`dt >= 40`). Load can only make elapsed larger; the bound IS
the property ("the sleep really suspends"). Kept, each annotated with a
*do not add an upper bound* note.

**(c) CROSS-CLOCK COHERENCE, not a work budget. 1.**
`conformance/time_clock_realtime_epoch` asserts
`|time(0) - CLOCK_REALTIME.tv_sec| < 60` across two adjacent statements — a
disagreement between two clock sources, not a duration of work. Contention does
not move it. Kept, annotated.

**(d) READS A CLOCK, PASS/FAIL DOES NOT DEPEND ON ELAPSED TIME. 12.**
`stdlib/clock_gettime` (range checks), `stdlib/clocks_per_sec` (`b >= a`,
monotonic), `stdlib/localtime_r` + `stdlib/sys_time` + `stdlib/time` (absolute
dates and fixed epochs), `stdlib/stat_layout`, `stdlib/strftime` (fixed `tm`),
`stdlib/times_h`, `core/stat_fields` + `core/utimes` (fixed `utimes` values),
`sdl_get_ticks` (`b >= a` + `sizeof`), and `conformance/alignas_over8_static` —
a deliberate false positive of the scan, matching the phrase *"at compile time
(rejects-valid)"* in a comment.

8 + 3 + 1 + 12 = 24. ✅

### Positive control on the survey

A scan whose *"nothing else found"* is load-bearing is worthless without one.
Two decoys were planted — one in a **new** dir, one smuggled into an **existing,
previously-clean** test file — and the scan was obliged to find both:

```
$ sh tests/scan-wallclock.sh | wc -l        # baseline (post-fix tree)
      22
$ # plant tests/unit/zz_scan_control/main.c  (new dir, clock_gettime + `ms < 100`)
$ # plant a __planted() elapsed-budget helper into tests/unit/core/argc_argv/argc_argv.c
$ sh tests/scan-wallclock.sh | wc -l
      24
$ diff /tmp/base.txt /tmp/ctrl.txt
6a7
> tests/unit/core/argc_argv/argc_argv.c
22a24
> tests/unit/zz_scan_control/main.c
$ # decoys removed
$ sh tests/scan-wallclock.sh | wc -l
      22
```

(Baseline is 22 rather than 24 after the fix because the two `usleep_zero` tests
no longer read a clock at all.)

## The fix

### Why raising the constant is the wrong move

`ms < 100` → `ms < 1000` moves the flake and makes the test *weaker at the bug it
exists to catch*: a real 1 ms clamp over 20 calls is only 20 ms. Worse — that is
not hypothetical. Injecting exactly that clamp into both `host.js` `usleep`
backends and running the **pre-0361** encoding:

```
$ node tests/run-unit.js -v --filter=zz_old_encoding     # the pre-0361 main.c, verbatim
--- unit (1 tests, 10 workers) ---
  PASS  unit/zz_old_encoding

1 passed, 0 failed  (0.2s)
```

The wall-clock test **passed the exact bug it was written for**, while going red
because another worktree was compiling. It was measuring the wrong thing in both
directions.

### What replaced it

The clamp is a property of `host.js`'s sleep primitive, not of compiled C, and
both backends bottom out in exactly one interceptable call:

* native-fs / CLI flavor (JSPI) → `setTimeout(resolve, ms)`
* block-FS flavor (no JSPI) → `Atomics.wait(cell, 0, 0, ms)`

`tests/host/test_sleep_clamp.js` records the millisecond value each one is
handed and asserts the **requested** duration — 23 checks, both backends, zero
clock reads. `usleep(0)` must request 0 ms (block-FS: must not park at all);
`usleep(500)` must request 0.5 ms, not a floored 1; `usleep(50000)` must request
exactly 50, which pins the unit conversion the old `< 500000` bounds were
groping at. `WebAssembly.Suspending = f => f` unwraps the JSPI imports — the
`test_pipe_read_block.js` precedent.

The C tests kept what C can actually see. `usleep_zero` / `blockfs_usleep_zero`
now assert `usleep(0)` returns 0 with `errno` untouched. The six
`elapsed_us < 500000` upper bounds were deleted and their `>= 40000` lower bounds
kept: a 1000× oversleep is 50 s, already past `run-unit.js`'s 30 s per-test
timeout, so the upper bound bought nothing the runner did not already give.

## Green under contention

Load generated with 10 busy `node` processes (= core count) — deliberately NOT
the kernel suite or the browser sweep, which other lanes need, and with neither
`CC_NO_HEAVY_LOCK` nor `CC_NO_MEM_CAP` set.

```
$ node tests/run.js unit          # solo
786 passed, 0 failed, 1 xfailed, 3 skipped  (12.9s)

$ for i in $(seq 1 10); do node /tmp/burn.js 150 & done ; node tests/run.js unit
786 passed, 0 failed, 1 xfailed, 3 skipped  (25.6s)      # load avg 16.4
```

25.6 s vs 12.9 s is a **2.0× slowdown** — the same factor the ticket recorded
(33.2 s vs 16.7 s) when the old budget fired. The suite stays green through it.

**What did NOT reproduce:** with 16 busy `node` processes (> core count) the old
`ms < 100` assertion did not actually trip. Instrumenting it to print the
measurement rather than the boolean, five runs under that load read
`elapsed_ms=` 58 / 63 / 47 / 26 / 64, against a solo baseline of 26 / 31 / 26.
So CPU-only contention consumed up to ~64% of the budget but did not cross it;
the original red came from a 4 GB-per-boot kernel suite in another worktree,
which is memory and I/O pressure this synthetic load does not imitate. The
budget's margin is thin and load-dependent either way — that is the finding, and
it does not depend on reproducing the trip on demand.

## Residuals filed

* **todos/0365** (L53) — the two backends **disagree** about a zero-length
  `nanosleep`: block-FS treats it as a no-op, native-fs floors it at 1 ms
  (`Math.max(1, ms)`), and POSIX says a zero request returns immediately. Found
  while writing the new test, which deliberately asserts *neither* answer for
  that input — pinning the floor would bless it as correct. Filed P0 per
  CLAUDE.md's unqualified bug rule, with a note that the magnitude argues for
  P1.
* **todos/0366** (L54) — the survey is a hand-run audit. The classification above
  is a human judgement recorded once; nothing notices when a new test lands with
  `elapsed_ms < 100` in it. That is the same shape as the bug being fixed: a
  documented state that reads as handled while it drifts.
