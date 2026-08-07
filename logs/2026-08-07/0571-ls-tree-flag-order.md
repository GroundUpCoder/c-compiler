# #571 — git ls-tree rejects `-r` before the rev (lane-571)

Base: `origin/main` @ `5bbd53ef` (re-measured at lane start; unchanged since
dispatch).

## The bug and the fix

`cmd_ls_tree` (os/git/git.c) revparsed `argv[0]` unconditionally (:423) and
only scanned argv for `-r` *after* the revparse (:446), so
`git ls-tree -r HEAD` died with `git: bad revision '-r'` while
`git ls-tree HEAD -r` worked.

Fix: one pre-pass over argv that splits flags from positionals BEFORE the
revparse — `-r` sets `recursive`, any other `-x`-shaped token is a loud usage
error, the first positional is the rev (default `HEAD`). No special-casing of
a leading `-r`; the next flag added to ls-tree inherits the correct seam for
free. A comment in the handler names the shape and points at `cmd_rev_list`
as the in-file precedent, per the ticket's plan point 3 — that comment is the
"#475 builds on this" deliverable: five write verbs land next, and each takes
flags AND refs.

### The other flag-scanning handlers (kickoff asked)

- `cmd_rev_list` (:324) already implements the CORRECT seam — its single loop
  splits `-n <count>` from positionals inline, so `rev-list -n 3 HEAD` and
  `rev-list HEAD -n 3` both work today. It is the precedent, not a second
  instance of the bug.
- `cmd_log` (:82) scans flags only and ignores positionals entirely (`git log
  <rev>` is not supported at all — a capability gap, not a parsing-order bug,
  and out of this ticket's scope).

So the defect was localized to exactly one handler; the fence's "systemic"
trigger does not fire. Grep check: `argc > 0 ? argv[0]` occurred only at :423.

### Why not getopt(3)

A generic "first non-dash token is the rev" helper is WRONG next to value
flags (`-n 3 HEAD` — "3" is not a rev), so the honest shared shape is the
inline split each handler owns, knowing which of its flags take values —
exactly what cmd_rev_list already does and what the new comment prescribes.
POSIX getopt stops at the first non-option, which would break the
flag-after-rev ordering this ticket exists to keep.

### Deliberate behaviour change, declared

`ls-tree HEAD -x` used to silently ignore `-x`; `ls-tree -x HEAD` used to say
`bad revision '-x'`. Both now fail loud: `git: unknown option '-x'` + usage,
exit 1. Real git also rejects unknown options loudly; silently ignoring one
is the trap #475's verbs must not inherit. No committed assertion depended on
the old behaviour (checked: nothing in tests/ exercises ls-tree with an
unknown flag).

## Orderings exercised (all captured in build/repro-571-*.log)

Pre-fix (`build/repro-571-pre-fix.log`, wasm built from the untouched tree):
`-r HEAD` → rc=1 `bad revision '-r'`; `HEAD -r` → rc=0; `HEAD` → rc=0;
no-args → rc=0.

Post-fix (`build/repro-571-post-fix.log`): `-r HEAD`, `HEAD -r`, `HEAD`,
bare `-r` (implicit HEAD), no-args — all rc=0; the two `-r` orderings are
byte-identical; the non-`-r` spellings are byte-identical to pre-fix (no
regression on the implicit-HEAD path). `-x HEAD` and `HEAD -x` → rc=1 loud.

Cross-check against the host's real git on the fakegit fixture: our `-r`
output is byte-identical to host `git ls-tree -r -t HEAD` (this fixture is
one level deep). Two output-fidelity gaps recorded below.

## Where the regression assertion lives, and proof it's gate-visible

`node tests/run.js --diff origin/main --dry-run` on a scratch git.c edit
(the authority) printed:

    os/git/git.c  →  todos, kernel, sweep, fakegit

- **Primary net: `fakegit`** (run.py category; runs in the gate for any
  os/git/ diff — the RULES comment names it this tree's regression net). Two
  new golden dirs: `tests/fakegit/ls_tree_r_flag_first` (`ls-tree -r HEAD`)
  and `ls_tree_r_flag_last` (`ls-tree HEAD -r`), identical expected.txt —
  encoding "both orderings, same recursive listing" as bytes. Category green
  13/13 (was 11).
- **Coverage proof, run and reverted** (`build/breakage-evidence-571.log`):
  with os/git/git.c stashed back to the buggy origin/main version,
  `fakegit/ls_tree_r_flag_first` FAILS with exactly the bug's symptom
  (`git: bad revision '-r'`, 0 stdout bytes vs 374 expected);
  `ls_tree_r_flag_last` still passes, as it should. Fix restored via
  `git stash pop`.
- **Manual-tier sweep** `tests/browser/os-git-cli.mjs` (the finder, NOT in
  the auto gate): leg 7 amended per the ticket's acceptance — both orderings
  asserted rc=0, both must contain the nested `src/nested.txt` path, and the
  two listings must be equal. The fixture gained `src/nested.txt` because a
  flat repo recurses into nothing and the old leg's "recursive" pass was
  vacuous; the fixture-staleness guard now probes for that file so a cached
  pre-#571 fixture rebuilds.

The old leg-7 check (single ordering, `HEAD -r`) is superseded by three
strictly stronger checks — coverage grew, none was removed.

## The weight fence — deliberated, not fired

Trigger 4 ("plan pulls kernel or sweep and >30 min of gate") nominally
matches: any os/git/ diff maps to kernel+sweep by the standing RULES row, so
the ~45 min gate was determinable at dispatch, the kickoff's own gate section
quotes the kernel/sweep timings for this lane, and the ticket (which outranks
the kickoff) declares light scope naming this exact file with acceptance
criteria that require the sweep file. I read trigger 4 as guarding against
*discovered* growth, not the priced-in baseline mapping; proceeding. The
edit-scope triggers (≤ cmd_ls_tree + comment, no vendor/, not systemic) all
stay unfired.

## Findings for the coordinator (out of scope here, worth tickets)

1. **`ls-tree -r` output fidelity:** real `git ls-tree -r` recurses to full
   depth and omits tree lines; ours prints tree lines and recurses exactly
   ONE level (the nested loop at git.c:458-477 has no further recursion), so
   on a ≥2-level tree `-r` silently omits deeper files. On the depth-1
   fixtures the estate uses, our output equals host `git ls-tree -r -t` —
   which is why the sweep never saw it. Same handler, different defect
   (output semantics, not parsing); fixing it re-cuts both new goldens.
2. `git log <rev>` ignores its positional (cmd_log scans flags only) — real
   git logs from that rev. Adjacent capability gap, same file.

## No silent caps

Every ordering listed above ran against the deterministic fakegit fixture;
nothing sampled or truncated. The fakegit category ran in full (13/13), not
just the new members, except in the deliberately-broken evidence run, which
was `--filter=ls_tree` (declared there and in the log file).
