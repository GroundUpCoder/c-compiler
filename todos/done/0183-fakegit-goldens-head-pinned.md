# 0183 — fakegit test goldens pin HEAD — the category is permanently red

- **Status**: done (2026-07-15; tests now run against the deterministic fixture repo from tests/fakegit/make-fixture.sh, goldens recaptured — 9/9 green, commit-invariant; log: logs/2026-07-15/fakegit-hermetic-0183.md)
- **Design**: this file (found during the 0079 gate, 2026-07-15)

## Goal

The `fakegit` run.py category runs the libgit2-backed fakegit binary
against **this repo itself** (`test_repo = ROOT_DIR` in
`run_fakegit_tests`) and byte-compares stdout to committed
`tests/fakegit/*/expected.txt` goldens. Those goldens were captured when
`HEAD` was `fbc85224` — **365 commits ago** — so all 9 HEAD-dependent
tests (`rev_parse`, `rev_list`, `log`, `log_n1`, `show`, `diff`,
`status`, `ls_tree`, `cat_file_commit`) have been failing on every
checkout since, and re-break on every commit even if re-captured. A test
that can only pass at one commit of the repo it lives in is broken by
construction.

## Plan

Make the tests hermetic: run against a **fixture repo** with a frozen
history instead of the live checkout — e.g. a committed script/tarball
that materializes a tiny deterministic repo (fixed author/date/message
commits) into `build/`, goldens captured from that. Alternatively pin
every test to an old immutable ref instead of `HEAD` (weaker — `status`
still depends on the working tree, and any history rewrite breaks it).
Keep the "always available" property the current design wanted, without
the moving target.

## Acceptance

- `node tests/run.js fakegit` green on a fresh checkout at any HEAD.
- Committing to the repo does not change the category's verdict.
