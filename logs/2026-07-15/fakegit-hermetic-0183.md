# fakegit goes hermetic — fixture repo instead of the live checkout (todos/0183)

**P0.** The `fakegit` run.py category ran the libgit2-backed fakegit binary
against **this repo's live checkout** (`test_repo = ROOT_DIR`) and
byte-compared stdout to committed goldens captured at `fbc85224` — ~365
commits ago. All 9 HEAD-dependent tests (`rev_parse`, `rev_list`, `log`,
`log_n1`, `show`, `diff`, `status`, `ls_tree`, `cat_file_commit`) failed on
every checkout and re-broke on every commit; the category was permanently
red and masked real regressions in the gate (surfaced during 0079).

## Fix

A test repo you commit to is a moving target by construction, so the tests
now run against a **fixture repo** materialized fresh each run:

- `tests/fakegit/make-fixture.sh DEST` builds a tiny 5-commit history
  (adds, a modify, a delete — so `diff HEAD~3 HEAD` shows M/A/D) plus a
  dirty working tree (one modified tracked file, an untracked file, an
  untracked dir — the `status` surface). Determinism is total: fixed
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` name/email/date/tz per commit, and
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` so a host-level
  `commit.gpgsign`/`core.autocrlf` can't perturb the hashes. Built twice →
  identical rev-lists; HEAD is `313f42bc…` on any machine.
- `run_fakegit_tests` builds the fixture into `build/tmp/fakegit-fixture`
  before the test loop (loud `fakegit/fixture` failure if git or the script
  misbehaves) and points `test_repo` at it.
- All 9 goldens recaptured from the fixture. Distinct author vs committer
  identities keep `cat-file -p` honest.

Rejected alternative (from the item): pinning tests to an old immutable ref
— `status` still depends on the working tree, and any history rewrite
re-breaks everything.

## Verification

- Before: `node tests/run.js fakegit` → **0 passed, 9 failed** (all diffs
  HEAD-derived: got `6593daa…`, expected `fbc85224…`).
- After: **9 passed, 0 failed** (~15s).
- Commit-invariance (the acceptance property): green with an empty probe
  commit on top, probe then dropped — the verdict no longer reads HEAD.
- Wiring: `node tests/run.js ast disw sourcemap fakegit` (the batched
  run.py path) → 18 passed, 0 failed; `--diff --dry-run` maps
  `tests/fakegit/**` → fakegit as before. The run.py edit is confined to
  `run_fakegit_tests` + its section comment.

**Gotcha for future golden regens:** don't hand-edit the goldens — rerun
`sh tests/fakegit/make-fixture.sh build/tmp/fakegit-fixture` and recapture
stdout per `args.txt` (recipe in the script header). Any change to the
fixture steps changes every hash.
