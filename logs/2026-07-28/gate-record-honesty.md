# Making the gate's own record honest — todos/0333 + todos/0339

Two tickets, one file (`tests/run.js`) and one concern: the gate currently lets a
run **claim** more than it **ran**. 0333 is the planner side (a diff that owes a
gate can plan nothing), 0339 the record side (a run that covered half the sweep
leaves an artifact indistinguishable from one that covered all of it).

## 0333 — `tools/` was mostly unmapped

`RULES` mapped exactly five `tools/` paths (`mkpkg`, `clang-unpackaged.json`,
`mkimage`, `os-drive*`, `win32rc`, `win32ports`, `mkmpgenhdr`). A probe touching
one file per unmapped area listed **11 UNMAPPED paths** and planned `(nothing)`:

```
tools/asm86/asm86.js  tools/bench2x2/analyze.js  tools/build-libc-ext.js
tools/cfg/c0.js  tools/disasm/interpreter.js  tools/idlemeter.mjs
tools/mkgif.js  tools/mksounds.js  tools/mkwebfixtures.js
tools/peek-repro.mjs  tools/sample-wasm-filegen/wasmgen.js
→ suites: (none)
```

The hole was never *silent* — `printDiffPlan` prints the yellow unmapped block
and says "add a rule". The defect was that nothing ran, and a reader who takes
`suites: (none)` as "no gate owed" gets no enforcement, only a warning they can
skip. That is exactly how it survived: `tools/bench2x2/` has been in the tree
since `c1b1f47c` and 0332 edited it live.

**Why no blanket `^tools/` rule.** `tools/` is three different kinds of thing at
once, and a single rule would have to pick one:

1. **Generators of committed assets** (`mksounds`, `mkgif`, `mkwebfixtures`,
   `build-libc-ext`). Their outputs are checked in, so an edit here only reaches
   the tree via a re-run — which means the gate that matters is the suite that
   *consumes* the asset, not anything about the generator. Same shape as the
   existing `mkimage`/`win32rc` rules.
2. **Harnesses that ride a test seam** (`idlemeter`, `peek-repro`, `bench2x2`).
   They gate nothing themselves. The useful signal for their editor is "the seam
   under you still holds", which is the `^tools/os-drive → sweep` precedent
   already in the table.
3. **Self-contained side projects** (`asm86`, `cfg`, `disasm`,
   `sample-wasm-filegen`). Own trees, own runners, nothing outside `tools/`
   references them. Their honest answer is `[]`.

So each path states its own answer. The two calls worth defending:

- **`bench2x2 → host`, not `host, kernel`.** Every cell runs `node host.js
  <wasm>` standalone, which the cheap host suite proves. Its in-OS leg
  (`inos-startup.js`) *also* drives `os/boot.js`, so `kernel` is arguably in the
  seam — but taxing a measurement harness with the heavy suite is precisely the
  over-fix the ticket warned against. Declined in a comment, not by omission.
- **`[]` is a rule, not silence.** An explicit `[]` suppresses the UNMAPPED
  warning *because a decision was recorded*; the `tests/bench/`, `tests/run.js`
  and `tests/flake.js` entries already work this way. Deliberately **no**
  catch-all, so a NEW `tools/` path still reports UNMAPPED — that warning is the
  prompt to decide, and a catch-all would silence exactly the case that needs it.

After: all 11 paths match, 0 unmapped, and the bench2x2-only probe plans `host`.

## 0339 — a split sweep destroyed its own record

The full browser sweep does not fit one tool call, so every master handoff in
this fleet tells the next coordinator to split it into two `--filter` halves.
**Every sweep this fleet runs is therefore split, and every split sweep used to
destroy its own record**: half 2 overwrote `build/test-browser/summary.json`, so
a complete 40-file run and a lane that ran twenty files by mistake left
byte-identical artifacts, both saying `pass`. Only live console output could tell
them apart, and console output does not outlive the turn.

**The fix went into `tests/lib/suite-runner.js`, not the sweep.** The defect is
in the shared engine, so kernel and blockfs get the same record for free — and
`--resume` already carried results forward across runs, so merging is the
generalisation of a mechanism that was half there already.

**Merge in place, not `summary-<hash>.json` + merge in run.js.** The ticket
allowed either. Keying by filter fragments the artifact and moves the merge into
the dispatcher, which leaves the file a reviewer actually opens — the canonical
`build/test-browser/summary.json` — still holding one half. Merging in place
needed zero changes in both existing consumers (`--resume`'s `prevByFile`,
run.js's `suiteArtifact`).

Two design points that took the most thought:

- **A merge must never make a stale result look fresh.** Carried-in results are
  tagged `carried: true` and stamped `carriedFrom: <the startedAt that measured
  them>`, and `runs[]` records each contributing run's filter, start time and
  counts. `runs[]` self-prunes to entries that still own a result, so one
  unfiltered run collapses it back to a single entry.
- **`--resume` must NOT resume off a carried result.** Left unguarded, this
  reintroduces the exact bug through the back door: a file that passed on Monday
  gets skipped by Friday's "full" sweep and still reports green. `prevByFile` now
  filters `!r.carried`; a run's own `resumed` chain stays eligible, so `--resume`
  behaves exactly as it did before.

`recorded == total` is the number that means "the whole suite ran". A filtered
run prints `⚠ N of M files selected` up front and the dispatcher prints
`[4/40 files, 2 carried — PARTIAL]` at the end.

**Stale `*.log` are kept on purpose** (the ticket's "consider" item). Under the
merge a carried result's `log` points at a log written by an earlier run, so
clearing the directory would leave the manifest citing files that no longer
exist. The ticket's own finding — 84 `.log` files after a 40-file run, i.e.
counting logs OVERSTATES — is the argument for making the *manifest*
load-bearing, not for tidying the filesystem.

### Verifying a scope ticket without lying about scope

`tests/host/test_suite_record.js` pins the contract on a 4-file synthetic suite
with real child processes and a real `summary.json`: 12/12 green, and **11 of the
12 fail on the pre-fix engine** (the 12th is vacuously true there — no carried
tags exist to find).

The end-to-end check was a **reduced split of 2 + 2 files out of 40**, and saying
so precisely is part of the ticket. A full sweep costs ~16 minutes and the
exclusive heavy lock another lane needed; more to the point, verifying *a ticket
about unrecorded scope* with a run whose scope was then described loosely would
have been the same defect wearing a new name. `--filter=os-boots,os-minimal` then
`--filter=os-clipboard,os-drop` left one artifact with all four results, both
runs named, `carried: 2`, `recorded: 4` of `total: 40` — reported as PARTIAL,
because 4 of 40 is what ran.

## Aside — L38's anchor comment is false (0318's territory, untouched)

`tests/run.js:176` says "vendor/ has no blanket rule — every OTHER vendored
project reports UNMAPPED on a diff. That gap is todos/0318." There **is** a
blanket rule: `[/^vendor\//, ['projects'], 'a vendored project build']`, present
since the original 0084 commit `f2fd59c5` — i.e. the comment was already wrong
when it was added at `8b945672`, and `todos/0318`'s premise ("has no rule for
`vendor/`") inherits the error. `LIABILITIES.md` L38 anchors on that line.

Not fixed here: it belongs to 0318, and rewriting the anchor line would have
dragged the register into this lane's diff. Flagged to @master instead. Note the
severity is the *inverse* of the usual liability-register hazard — a false gap
comment causes wasted work, where a true one causes missed work.
