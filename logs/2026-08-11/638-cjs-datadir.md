# #638 — CJS bundle data dir: mkdtemp per invocation, removed on exit

The `-o <name>.js` prelude (`JsOutput.generate()`, only emitted when
`--opfs-file` payloads exist) named its data directory `"cjs-" + process.pid`,
`mkdirSync({recursive:true})`'d it, wrote the payloads, and `chdir`'d there —
with no cleanup and no pre-empty. Referent re-derived from source: exactly four
`__dataDir` references (create/mkdir/write/chdir), matching the ticket.

## The two defects, demonstrated failing at 340414ba

`tests/host/test_cjs_datadir.js` (committed ahead of the fix at e0523aff) went
4-red at the base commit with all controls green:

    FAIL leg1: nothing survives a clean exit  ["cjs-82044"]
    FAIL leg1: program-authored cwd output does not survive either  ["cjs-82044","cjs-82053"]
    FAIL leg2: same-pid successor sees ONLY its own payload  "data-a.txt\ndata-b.txt\nprog-output.txt\n"
    FAIL leg3: concurrent same-bundle runs get DISTINCT data dirs  {"cwdA":".../cjs-424242","cwdB":".../cjs-424242"}

Leg 2 is the contamination in the flesh: program B's cwd holds program A's
embedded payload AND A's runtime output. Pid reuse is simulated by pinning
`process.pid` in a `require()` wrapper (deterministic, no wraparound wait);
post-fix the pid is simply never consulted, so the wrapper is inert.

## Why mkdtemp + exit-removal (the design argument, not just the suggestion)

- A pid-keyed name is neither stable (changes every run — so it was never a
  persistence design) nor unique (pids are reused). It has no property worth
  keeping.
- The alternative — a stable path + pre-empty — trades defect B for a new one:
  two concurrent runs of the SAME bundle share the dir, and run 2's pre-empty
  deletes run 1's live files mid-run. Leg 3 exists precisely to kill that
  design: two simultaneous pinned-pid runs must print distinct `getcwd()`s.
- If CJS-side payload *persistence* (parity with the browser's OPFS keyed by
  `BUNDLE_HASH`) is ever wanted, that is a hash-keyed dir with deliberate
  no-deletion semantics — a feature with its own ticket, not this bug's shape.

Cleanup mechanics: an `exit` hook (sync `rmSync`; `chdir` out first — removing
the process cwd is not portable) plus `once`-handlers on SIGINT/SIGTERM/SIGHUP
that clean up and re-raise, preserving die-by-signal status (verified manually:
child exits `(null, SIGINT)` and the dir is gone). If the program registered
its own handler for the signal, ours defers — the process is not dying, so the
dir stays until `exit`. Residual leak surface: SIGKILL/power loss only, where
mkdtemp uniqueness still rules out contamination.

## Gate

`--diff 340414ba --dry-run` resolves 25 suites via the blanket `^compiler\.js$`
rule. The audited behavioral surface is the emitted prelude string only:
`--opfs-file` has zero references anywhere in tests/tools/serve.js (positive
control: 4 in compiler.js), run.py compiles to `.wasm` not `.js` bundles, and
the one pre-existing `-o *.js` consumer is `tests/host/test_singlefile_emit.js`
(host suite). Ran the kickoff-named tier, all at exact baselines: unit 825/0/3,
host exit 0 (incl. the new test), projects 29/0/1. The blanket-rule remainder
was left to the coordinator's call, stated in the lane report — not silently
narrowed.
