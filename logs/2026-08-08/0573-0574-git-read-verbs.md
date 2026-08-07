# #573 + #574 — gucOS git read verbs: ls-tree full depth, log <rev>, rev-list arg honesty

Lane `lane-573574`, batched on purpose: both tickets edit `os/git/git.c` and any
`os/git/` diff draws the same todos+kernel+sweep+fakegit gate. The gate is the
cost, not the edit. Neither ticket touches the test registry.

## Reproductions (preserved BEFORE repair)

`build/repro-573-unfixed.log`, cut on the unfixed binary against a depth-3 repo
(`build/repro-573`, host-git-built, pinned identity/dates; has branch `side` at
c1 `78122580…`, `main`/HEAD at c2 `63f7e056…`):

- `ls-tree -r HEAD` printed 4 lines (2 tree lines + 2 blobs), exit 0 — the
  depth-2 ceiling. Files `a/b/two.txt` and `a/b/c/three.txt` silently omitted.
- `log side -n 1` printed HEAD's commit `63f7e056…`, not `side`'s — the
  positional silently ignored, exit 0.
- `rev-list -r HEAD` exit 0, `-r` silently ignored (flag-FIRST form — the
  ticket body had this backwards; the cont-528 correction comment is what the
  fix and the guards are written against).
- `rev-list HEAD -r` exit 1 with NO output at all — the silent-failure half.
- `rev-list side main` exit 0, walked only `main` — last positional silently
  wins.

## The fix (os/git/git.c)

**#573 `cmd_ls_tree`**: the one-level nested loop is replaced by
`ls_tree_print`, a depth-first entry-order recursion matching real git. Under
bare `-r` tree lines are OMITTED (real-git semantics); the new `-t` flag
restores them (`-r -t`). Without `-r` output is byte-identical to before. The
path prefix accumulates in one file-scope buffer (`ls_tree_path`, the `oidbuf`
pattern) so recursion costs no per-frame path storage on the 64K wasm stack;
overflow of the 4096-byte prefix is a loud error. A subtree that fails to load
was silently SKIPPED pre-#573 — it is now a loud `cannot read tree` error with
exit 1 (repo corruption is never a skip).

*Consumer check for the `-t` decision*: the only in-tree consumers of ls-tree
output are `tests/kernel/test_git_e2e.js` (bare `ls-tree`, asserts a top-level
tree line — unaffected: bare output is unchanged) and the fakegit goldens
(re-cut below). No in-OS consumer depends on tree lines under `-r` or on
one-level depth, so matching real git stands and no rebuttal is filed.

**#574 `cmd_log` + `cmd_rev_list`**: both retrofitted to the `cmd_ls_tree`
parse shape — one pass splitting flags from positionals, then revparse.
`log` takes an optional positional rev (default HEAD) and pushes its oid
instead of `push_head`. Both verbs now reject unknown `-`-prefixed options
with `git: unknown option '…'` + a usage line (previously: `log` silently
ignored EVERY non-`-n` argument; `rev-list` adopted any of them as the rev).
New loud errors, none of which existed before:
- `git: bad revision '…'` on the revparse failure path (rev-list previously
  exited 1 in total silence — defect (b) of the cont-529 comment);
- `git: too many revisions (…)` on a second positional (previously silently
  last-wins — `rev-list A B` walked only B);
- `git: -n needs a count` on a dangling `-n` (previously: log ignored it;
  rev-list adopted `-n` itself as the rev and died silently).
The two #475 comments that described `cmd_rev_list`'s defect in present tense
(the `cmd_ls_tree` header comment and the write-set block comment) are
re-pointed to past tense — after this change the described defect no longer
exists, and a comment asserting it does would be the next stale-citation bug.
The #475 deliverable itself (comment names `cmd_rev_list` as defect, ls-tree as
model, cites #574) was verified present on base `51593e32` and is preserved in
substance.

## 🔴 Committed assertions being changed — declared BEFORE the re-cut

`tests/fakegit/ls_tree_r_flag_first/expected.txt` and
`ls_tree_r_flag_last/expected.txt` (the #571 goldens) encode the DEFECT: 6
lines including two `tree` lines, one-level recursion output on the shared
depth-2 fixture. The #573 fix changes `-r` output semantics, so both goldens
are re-cut to the real-git 4-blob output. Coverage goes UP, not down:

- the flag-position invariant (first == last) is preserved on both re-cut
  goldens;
- a new `ls_tree_r_t` args fixture pins `-r -t` (tree lines restored) on the
  shared fixture;
- a new `ls_tree_deep` steps fixture builds a ≥3-level scratch repo and pins
  full-depth `-r`, `-r -t`, both flag orderings, bare output, and the loud
  unknown-option error — the depth coverage whose absence let #573 hide
  (every prior fixture was depth-1/2).

## The steps-harness stderr assertion (the cont-529 scope addition)

`run_fakegit_steps_test` captured stderr but used it only in failure messages —
no golden could say "this step failed AND said something specific", so defect
(b) (a verb exiting 1 in total silence) was unguardable; `w_unknown_option`
passes today against a hypothetical mute binary. Added the step form:

    !"<substring>" <args>

= the invocation must exit non-zero AND its stderr must contain `<substring>`.
Plain `!` keeps its exact old meaning. An unterminated `!"…` or an empty
substring (`!""`, vacuous by construction) is a loud harness error, as is any
other unrecognized `!` form (previously `!x` would have been shlex'd into a
git invocation — a trap, now refused). `w_unknown_option` is retrofitted so
every refused write verb pins its message text — #475's loud-error behaviour
is now a golden, not an accident.

**Gate price, declared**: `tests/run.py` is a gate input for 21 suites (every
py category + unit + blockfs), so this lane's gate is the ~50-minute shape
(#475 measured 3046 s), not the ~45-minute os/git-only shape. Priced with
`--dry-run` before the run; figures below. The alternative — shipping #574
with only the `!` half of its guard — was rejected because the ticket comment
(cont-529) explicitly assigns the harness extension to this lane, and a half
guard that reads as complete is exactly the fake-green shape this repo's rules
exist to prevent.

## Deliberate cuts — none silent

- `ls-tree` pathspecs (further positionals) remain unimplemented and IGNORED
  (pre-existing #474-scoped behaviour, unchanged by this lane; the in-code
  comment stands).
- `log`/`rev-list` still walk ONE rev: `A..B` ranges, `--not`, and multiple
  start points are out of scope (and now REFUSED loudly rather than silently
  mis-answered — refusal is the honest form of not-implemented).
- `-t` without `-r` prints the same as bare ls-tree (real git does the same at
  the top level; ours doesn't implement -d so the equivalence is exact).
- No `--format`/`-z`/`--name-only` etc. — not claimed by usage, refused loudly
  by the unknown-option guard.

## Breakage evidence (build/breakage-evidence-573574.log)

Four deliberate breakages, each applied to the worktree, run, and reverted
(`git checkout -- os/git/git.c`, diff-clean verified each time):

- **B1** — nested `ls_tree_print` call given `recursive=0` (the one-level
  regression). `ls_tree_deep` RED (21 lines vs 32: deep blobs missing,
  spurious `a/b` tree line); `ls_tree`, both flag goldens, and `ls_tree_r_t`
  all stayed GREEN — measured proof that every depth-≤2 fixture is
  structurally blind to the class and the depth-3 fixture is the only net.
- **B2** — `cmd_rev_list`'s unknown-option fprintfs deleted, `return 1`
  kept. Exit code unchanged, so a bare `!` step passes; `rev_list_opts` went
  RED only via the new stderr assertion (`stderr was: (empty)`). This is
  defect (b) of cont-529 reproduced and caught — the harness addition is
  load-bearing, not decoration. Negative controls: `w_unknown_option` and
  `ls_tree_deep` stayed GREEN under B2.
- **B3** — `cmd_add`'s `unknown option` fprintf deleted, usage line kept.
  Stderr non-empty but missing the message → retrofit `w_unknown_option`
  RED. The assertion tests the message text, not mere stderr noise.
- **B4** — `cmd_log`'s positional disabled (`ref && 0`). `log_head2` RED
  (HEAD's id where c3's belongs) and `log_rev` RED (`log nosuch`
  unexpectedly exits 0 — the ignored positional makes even the error path
  vacuous). Both #574-log guards fire.
- Final: all reverts confirmed clean, full fakegit 26/26 GREEN.

No breakage came back green — no dead-code finding to file.

## Bypass scan (build/bypass-scan-573574.log)

`build/bypass-scan-573574.sh` (script file, not inline) over
`origin/main..HEAD` (51593e32 → tip): scans added lines for weakening
constructs (knownBug/xfail/skip/--resume/heavy-lock bypass/.only/DISABLED)
and deleted assertion-bearing test lines. Positive control (planted
`knownBug` line) matched 1 BEFORE the zero was accepted; negative control
(harmless line) matched 0. Result: CLEAN — 0 weakening additions, 0 deleted
assertions. The re-cut goldens are expected.txt data files, not assertion
code, and are declared above.

## Gate

`node tests/run.js --diff origin/main --dry-run` (the only authority): 16
changed paths, 1 ignored (the dev log) → **23 suites** — `os/git/git.c` →
kernel + sweep + fakegit; `tests/run.py` → all 19 py categories + unit +
blockfs. That is the ~50-minute price of the harness deliverable (#475's
same-shape run measured 3046 s), declared here and accepted: the cont-529
comment assigns the stderr-harness work to this lane, and the alternative
(shipping #574 with only the exit-code half of its guard) is the
reads-as-complete half guard the repo's rules exist to prevent.

(verdict appended after the run)
