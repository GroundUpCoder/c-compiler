# #613 — sibling-owned tests: the kernel suite discovers `<sibling>/tests` via its manifest

Design of record: `gucos-packages-second-repo-design-2026-08-05.md` §3. This
closes the one place package independence still leaked: per-package e2es had
to live in c-compiler, so a package change that needed a test change dragged
its author back through a c-compiler merge. Now `gucos-packages/tests/` +
its own `manifest.json` join the kernel suite whenever the checkout is
present — and a sibling red blocks a c-compiler land, which is the *correct*
direction of coupling (a compiler.js change that breaks a shipping package
is exactly what these tests catch).

## Shape

- `tests/lib/sibling-tests.js` — discovery + STRICT manifest validation.
  Resolution goes through `COMMON.resolveSiblingRepo` (worktree
  gitdir-pointer aware — the naive `../gucos-packages` from a linked
  worktree names a sibling of the slug and does not exist; a hand-rolled
  resolver would have reported "absent" forever and made the skip path look
  perfectly correct). Three outcomes: `absent` (loud SKIP at the caller),
  `invalid` (loud exit 2), `ok` (runner entries).
- `tests/kernel/run.js` — a SECOND `assertMemberRegistry` call over the
  sibling dir against the sibling's own manifest (#314 holds per repo; the
  guard is per-directory, so sibling files can never trip c-compiler's own
  set-equality). Sibling entries join the same pool; `CC_ROOT` is passed in
  the child env; the summary gains a `sibling` block so the artifact states
  whether sibling tests joined or were skipped.
- `tests/lib/suite-runner.js` — three seams: `entry.src` (spawn +
  resume-freshness read the file where it actually lives), `evidence.extra`
  (the sibling dir joins the EXPECTED set), `opts.summaryExtra`.
- gucos-packages grew `tests/test_repo_contract.js`, the first PERMANENT
  member (coordinator ruling: a deleted red control leaves the discovery
  path unexercised until #615 — a permanent member proves it on every run).
  It also guards the data repo's own contract: layout dirs, manifest shape,
  every `packages/*.json` parses + name==filename + no cross-source name
  collision with c-compiler's `packages/` (the thing mkpkg refuses at build
  time, caught at test time).

## Design decisions (the H2/H4/H5 calls)

- **Member key = `gucos-packages/<file>`** (H4). The summary, resume map,
  log name, filter, and evidence namespaces all key on `entry.file`; a bare
  basename would collide with a same-named native member in all of them at
  once. The prefix solves every namespace in one move — `runOne` already
  flattens path separators for log names (`gucos-packages_test_x.js.log`),
  and the native pattern `^test_.*\.js$` can never produce a colliding flat
  name. Bonus: `--filter=gucos-packages` selects exactly the sibling set.
- **`entry.src` carries the absolute source path; spawn cwd stays
  `opts.dir`** (H2/H6). The cwd is NOT a per-entry choice: `os/boot.js` and
  the writing `tools/` run the cross-tree guard (todos/0341) against their
  cwd, so a sibling-repo cwd would make every `driveBoot` refuse at exit 4.
  A sibling test finds its own repo via `__dirname` and c-compiler via the
  `CC_ROOT` env the runner passes (documented in the sibling README's
  runner contract). All five join sites were fixed, not the first one
  found: staleForResume, the spawn, evidence (via `extra`), the kernel
  PKG_RE derivation, and timings hints (absent key → Infinity → schedules
  first — correct for an unmeasured member, no change needed).
- **Manifest validation is closed-world, invalid is fatal** (H5). Every
  malformed-manifest shape (missing tests/, missing/unparseable manifest,
  bad pattern, bad member shape, unknown keys anywhere) degrades naturally
  to "zero members", which is indistinguishable from "the sibling has no
  tests" and prints green while its tests never run — so none of them are
  allowed to. `absent` is the ONLY quiet-ish outcome, and it is still a
  named stdout line + a `sibling: {status: 'absent'}` block in the
  artifact. An unknown member key is an error, never ignored (a typo'd
  `timeoutMS` that silently does nothing is the zombie-fallback shape). The
  allowed member options are `timeoutMs`/`serial`/`image` only — the RAM
  class tags (`light`/`boot`) are assertions about local measurements
  (#579) and an untrusted manifest must not be able to under-charge the
  pool; an untagged sibling member deliberately lands in the over-charged
  HEAVY_GB default.
- **`GUCOS_PACKAGES` pointing nowhere is `invalid`, not `absent`** — the
  cmdalt no-silent-fallback rule, matching serve.js/comguc behavior.

## The controls (all run live through the real kernel runner, from the worktree)

H1 positive control — discovery resolved the sibling FROM THE WORKTREE
through the gitdir pointer, before any skip was believed:

```
registry: 1 declared + 0 excluded == 1 on disk (gucos-packages/tests/manifest.json)
sibling tests: gucos-packages at /Users/jku/git/gucos-packages (via main-clone sibling) — 1 member(s) join the suite
```

RED CONTROL (acceptance 3) — a temporary `test_red_control.js`
(`process.exit(1)`) declared in the sibling manifest, run through
`node tests/kernel/run.js --filter=gucos-packages`, literal output:

```
registry: 172 declared + 0 excluded == 172 on disk (tests/kernel/run.js)
registry: 2 declared + 0 excluded == 2 on disk (gucos-packages/tests/manifest.json)
sibling tests: gucos-packages at /Users/jku/git/gucos-packages (via main-clone sibling) — 2 member(s) join the suite
[preflight] clean: no abandoned fixtures, no orphaned serve.js, 111.6 GB free
⚠ kernel suite: --filter=gucos-packages selected 2 of 174 files — this run covers PART of the suite.
--- kernel suite (2 files, 6 jobs) ---
ok   gucos-packages/test_repo_contract.js  0.0s
FAIL gucos-packages/test_red_control.js  0.0s  → build/test-kernel/gucos-packages_test_red_control.js.log
     | sibling red control: deliberately failing
evidence: 2/2 selected members have logs post-dating the run start

kernel suite: 1 passed, 1 failed  (0.0s)  [2/174 selected, 2/174 recorded]  summary: build/test-kernel/summary.json
SUITE EXIT: 1
```

Sibling #314 half — the red-control file left ON DISK but removed from the
manifest refuses the run at exit 2 naming the file:

```
[suite-registry] gucos-packages/tests/manifest.json: the member list does not match /Users/jku/git/gucos-packages/tests:
  test_red_control.js: exists on disk but is NOT a declared member — it would execute NOWHERE. ...
EXIT: 2
```

Absent-sibling loud skip (acceptance 2; checkout temporarily renamed away):

```
sibling tests: SKIPPED — gucos-packages is not present beside c-compiler; clone
github.com/josephkimgpt/gucos-packages beside the main clone (or set GUCOS_PACKAGES=) to run its package tests.
```

The H3 evidence trap has a unit-level control in
`tests/host/test_sibling_tests.js` (leg 8): a sibling member expected on
disk but never scheduled is an EVIDENCE failure, not a silent green.

## Gotchas recorded for the next lane

- **A red-control run pollutes the suite artifact.** The kernel summary
  MERGES across runs, so the red control's `gucos-packages/test_red_control.js`
  FAIL row was carried into later gate slices — `174/173 recorded` was the
  tell. A red control (or any throwaway member) must be followed by an
  artifact purge, or the gate re-run from a clean summary; this gate purged
  `build/test-kernel/summary.json` and re-ran all four kernel legs.
- The ticket and design note cite "kernel run.js:250" for the registry call
  site — stale; it is ~line 372 (pre-change). Line numbers in both docs
  drifted.
- 60 `os-*.mjs` are on disk but the sweep total is 59 — the 60th is
  `os-sweep.mjs` itself, a named evidence exclusion ("the runner itself").
  The kickoff's 59 baseline was correct.

## Ship-boundary argument (why skip-on-absent is safe)

A c-compiler LAND on a box without the sibling may skip these tests (loud,
recorded in the artifact's `sibling` block). Nothing SHIPS that way: the
pre-deploy full gate (#428 rule 5) runs where comguc builds, and comguc's
sibling preflight (`assertSiblingUsable`, #614 — ON by default, loud, with
`GUCOS_PACKAGES=` override and an explicit `--no-extra-packages` opt-out)
makes the sibling mandatory there, so the kernel leg of a ship gate always
includes the sibling members. The new `sibling` block in
`build/test-kernel/summary.json` makes that auditable from the artifact.
