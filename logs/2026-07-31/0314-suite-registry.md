# #314 — suite-membership guards: set equality + execution evidence

The kernel suite's member list is hardcoded, and that produced a class of test
that exists on disk, is named and located exactly like every other member, and
executes NOWHERE while every gate reports full coverage. It bit three times:
`test_punes_e2e.js` (documented unregistered 2026-07-18, still unregistered at
this writing), `os/gcode/test/smoke.mjs` (the native gcode oracle, in no suite
at all), and `tests/kernel/test_win32rc.js` (created live on the #311 lane,
caught by hand — the lane grepped for its per-file log and found none).

## Why the gate could not catch it

`planFromDiff` maps a new `tests/kernel/` path to the kernel suite by
directory, so `unmapped` is `[]`; the runner then executes its normal
hardcoded members; totals agree, `resumed: 0`, zero non-pass — green.
`recorded == total` cannot help: the member list *defines* `total`, so the
transform is being verified with its own key. The fix has to introduce an
independent key. There are exactly two available: the **directory glob**
(what is on disk) and the **per-file log mtimes** (what actually ran). The
two guards use one each.

## Guard 1 — set equality (`assertMemberRegistry`, tests/lib/suite-runner.js)

Before anything runs (and before the heavy lock — a launch about to be
refused must not take the machine-wide lock, the tree-guard precedent), the
runner asserts the on-disk `test_*.js` set EQUALS the declared member set.
Divergence in either direction refuses the run (exit 2) naming the file; a
deliberate exclusion goes in a NAMED allowlist entry carrying its owning
ticket, and a stale entry (file gone, or file now declared) fails too, so the
allowlist cannot outlive its reason. This is the diff table's own todos/0333
design — fail loud on the unmapped — applied to the half of the file that
never got it. Wired in `tests/kernel/run.js` (allowlist: `test_punes_e2e.js`,
owner #167 / legacy todos/0396, enrolled as L68) and `tests/blockfs/run.js`
(empty allowlist; it was already set-equal at 15/15). The browser sweep
discovers by glob, so equality holds there by construction.

Kept the annotated list rather than switching the runner to glob-discovery:
the per-row comments and IMG/timeout options are load-bearing documentation,
and auto-running an unregistered file with guessed options would surface as a
confusing infra failure instead of the one-line refusal that names the fix.
The guard is what makes the list safe — a divergent tree cannot produce a
green run at all now.

## Guard 2 — execution evidence (runSuite's `evidence` opt)

After a run, every member the run selected (keyed by the DISK glob ∩ filter,
minus the allowlist — never by the runner's own results array) must have a
`<artifactDir>/<name>.log` whose mtime post-dates the run's start; missing or
stale logs are failures, counted into the exit code and recorded in
summary.json's `evidence` block. This is the discriminator that actually
caught `test_win32rc.js` at gate time (its missing log was the tell; exit 0
was not), generalized. It catches the NEXT variant: a member that is
registered but silently never scheduled. `--resume` relaxes resumed files to
existence-only and says so in the summary line (a resumed run never silently
claims fresh full coverage); fail-fast bails skip the check with a printed
note (the run already failed and named what did not run). Wired for kernel,
blockfs, and the sweep.

## The gcode oracle (the ticket's original ask)

`os/gcode/test/smoke.mjs` — the native reference oracle for /bin/code's
presentation (clang + real libcurl/cJSON vs a scripted SSE server) — now runs
as kernel member `test_gcode_native.js`. The oracle prints per-check ok/FAIL
and a bare final `PASS` with NO total, so exit 0 is equally true of a run
that executed fewer checks; the wrapper derives the denominator from the
source (`check(` call sites minus the function definition — 22 today) and
asserts the counted ok lines equal it. The wrapper gives the child a private
TMPDIR because the oracle builds to a fixed `os.tmpdir()` path and `--repeat`
runs a file concurrently with itself. An explicit `^os/gcode/` RULES row
(kernel, sweep — same as `^os/` today) pins the mapping against a future
`^os/` split, the ksvc precedent.

Red controls, both observed: an unregistered throwaway file → exit 2 naming
it, removed → green; a phantom `check(` appended to smoke.mjs → the wrapper
fails "ran ALL 23 checks (counted 22 ok lines)", reverted → green.

## Orphan audit (the Scope ask — reported even where zero)

- `tests/kernel/`: 143 on disk vs 142 declared at 80520aaa — the sole orphan
  is `test_punes_e2e.js` (#167 owns it; allowlisted, enrolled L68).
  `test_win32rc.js` is registered (fixed by the #311 lane in c2a122d5) — the
  guard is born green on it.
- `tests/blockfs/`: set-equal, 15/15. Zero orphans.
- `os/**/test/*.mjs`: exactly one file exists — `os/gcode/test/smoke.mjs`,
  now gated. Zero others (a zero is a finding: the audit ran, not "nothing to
  say").

## Gate record (post-45fa2c21, re-run after the first attempt died at turn end)

Plan from `planFromDiff` on the 9 committed PATHS (echoed, `unmapped: []`,
`ignored: [the dev log]`): `todos, unit, host, blockfs, kernel, sweep`.

- Dispatcher (`node tests/run.js todos unit host blockfs`): 4 pass, filter
  null; blockfs 15/15 recorded, its evidence line `15/15 fresh`.
- Kernel (`node tests/kernel/run.js`, the same bare invocation the dispatcher
  spawns — a single dispatcher run cannot fit one 600s tool window): **143
  passed, 0 failed**, filter null, runs length 1, done true,
  total == selected == executed == len(top-level results) == 143, resumed 0,
  `test_gcode_native.js` AND `test_win32rc.js` pass rows present, evidence
  block 143 fresh / 0 problems. Independent mtime key: 143 logs, ZERO predate
  commit 45fa2c21 (18:26:37; oldest log 18:39:26); `test_punes_e2e.js.log`
  absent exactly as allowlisted.
- Sweep (`node tests/browser/os-sweep.mjs`, bare): **44 passed, 0 failed**,
  filter null, runs length 1, done true, 44/44 recorded (non-PARTIAL),
  resumed 0, evidence 44 fresh / 0 problems; zero logs predate the sweep
  start. The sweep rewrote evidence PNGs under logs/2026-07-18 and
  logs/2026-07-25 — known, not ours, left uncommitted.
