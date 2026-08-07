# #475 — the git WRITE set: init / add / commit / branch / checkout (+ config)

Lane: lane-475 (Fable — no Opus/Codex review protocol applies). Base
`b8941ca9` (origin/main), work in `~/worktree/c-compiler/lane-475`.

## Pre-flight (the ticket's mandatory verification) — CONFIRMED

Re-ran `vendor/libgit2/feature_probe.c` through our compiler on this tree
(not inherited from the `481421fb` measurement): every step ok
(`init → config → blob → tree → commit → revparse → revwalk → status`), and
host `git fsck --strict` on the resulting `/tmp/probe_repo` exits **0** with
readable history. The ticket's premise holds; the engine was never the gap,
only the CLI surface. No fence trigger.

## What landed

Six verbs in `os/git/git.c`, all parsing argv the `cmd_ls_tree` way — one
pass splitting flags from positionals BEFORE any revparse; an unrecognized
option is a loud usage error plus a usage line plus exit 1. The #574
`cmd_rev_list` shape (unknown argument silently becomes the revision) is
deliberately kept out of every new handler, and the `cmd_ls_tree` comment
that half-wrongly cited `cmd_rev_list` as the model now names the defect
instead (the kickoff sanctioned this in-passing re-point).

- `init` — `[-q] [--bare] [-b <name>|--initial-branch[=<name>]] [<dir>]`;
  reinit detection with git's own wording; runs (like `config`) BEFORE repo
  discovery — `main()` now dispatches these two before `open_repo`.
- `add` — `[-A|--all] [-u|--update] [--] <pathspec>...`; cwd-relative
  pathspecs translated to workdir-relative (lexical join + `.`/`..`
  collapse; escaping the work tree is git's fatal); a spec matching nothing
  is `fatal: pathspec ... did not match any files` (ignored files get the
  gitignore message instead); deletions are staged (git ≥ 2.0 semantics).
- `commit` — `-m` (repeatable, joined with blank lines), `-a`, `-am`, `-q`,
  `--allow-empty`; identity from `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env first
  (raw `[@]<secs> [±HHMM]` dates — what makes test hashes reproducible),
  then config `user.name`/`user.email`; no identity is a fatal naming the
  `git config` fix, checked BEFORE `-a` mutates the index. Empty commits
  refused unless `--allow-empty`. Prints git's `[branch (root-commit)
  short] subject` summary.
- `branch` — list (sorted, `*` on current, detached line), create
  (`branch <name> [<start>]`), delete (`-d` refuses unmerged with a `-D`
  hint; merged = tip equals HEAD or is its ancestor via
  `git_graph_descendant_of`; refuses the current branch).
- `checkout` — branch switch (SAFE, conflict list in git's wording, `-f`
  forces, "Already on" fast path), `-b <name> [<start>]` (including the
  unborn-HEAD repoint), detached checkout of a non-branch rev, and path
  restore (`checkout [-q] [<rev>] -- <path>...`, FORCE, from index or rev).
- `config` — `[--global] <key> [<value>]` get/set. **This is the one verb
  beyond the ticket's five, and it is deliberate**: commit is unusable
  without an identity, and "hand-edit .git/config with vi" is not an
  interface an agent or a human should be given. It is the minimal surface
  (get, set, --global) — no --list, no --unset. If the coordinator reads
  this as overreach, it is one dispatch line plus one function to strip out.

`git --version` says 0.2; `packages/git.json` bumped to 0.2 with an honest
summary; the unimplemented-verb message no longer says "read-only" (it now
says "does not implement it yet"); `init/add/commit/branch/checkout/config`
left the unimplemented list. Liability **L78** (git is read-only) retired —
#475 was its funding ticket; the pre-commit register check caught the
anchor edit and forced the bookkeeping, exactly as designed.

## Two real bugs found under this ticket

1. **pcre2 `NEWLINE_DEFAULT` was 10 — every regex compile in every libgit2
   build failed.** 10 is PCRE1's ASCII-code convention; PCRE2 wants enum 2
   (`PCRE2_NEWLINE_LF`, pcre2.h:214), and 10 falls through
   `pcre2_compile`'s newline switch into "internal error: unknown newline
   setting". Nothing on the read path compiles a regex, so #473/#474 never
   saw it; `branch -d` hit it through `git_config_rename_section`. Fixed in
   `vendor/libgit2/deps/pcre2/config.h` (comment now names the trap) and
   recorded in the vendor README. The whole `compilerArgs` block in
   `os/git/bin.json` — which carried the same wrong value as a `-D`
   duplicate — is REMOVED: every flag in it was header-covered or dead,
   which is the recorded #473 rule ("build configuration lives in headers,
   not -D flags"), and this bug is precisely the drift that rule exists to
   prevent.
2. **My own first `cmd_add` carried dead code, and the breakage-evidence
   pass caught it** (see below): `git_index_add_all` already stages
   deletions (its diff walk removes entries whose workdir side lacks
   `GIT_DIFF_FLAG_EXISTS` — `apply_each_file`, src/libgit2/index.c), so the
   trailing `update_all` passes did nothing. Removed in `58622909`; `-u`
   (the one place update_all differs — it skips untracked) now also applies
   correctly to `-u <pathspec>`.

## Coverage — where the guards live and the proof they are real

Measured mapping (dry-run below): `os/git/git.c` → todos, kernel, sweep,
fakegit; `tests/run.py` → every py category + unit + blockfs.

- **fakegit: 13 → 21 fixtures** (count control; the suite prints dots, so
  the count is the record: "21 passed, 0 failed"). The 8 new fixtures are
  `steps.txt` multi-invocation fixtures over a small run.py harness
  extension — one git invocation cannot express init→add→commit, and a
  write fixture must NEVER mutate the shared read fixture (it would
  invalidate every later-sorted golden), so each steps fixture runs in its
  own scratch repo with pinned identity/dates (the make-fixture.sh values),
  `HOME` pointed into the scratch (no host `~/.gitconfig` can leak into a
  golden), `<SCRATCH>` substituted for the absolute path, and — the
  non-vacuity lever — per-step exit-code enforcement: a `! ` step MUST fail
  and a plain step MUST succeed, so a silently-succeeding error path (the
  #574 class) fails the fixture even where stdout is empty. Fixtures have
  real history and more than one branch where the property needs it
  (`w_branch_delete` builds a genuinely diverged branch to refuse;
  `w_checkout_switch` proves the working tree moved, not just HEAD).
- **kernel `test_git_e2e.js`**: grew a write session — init/config/add/
  commit/-am/checkout -b/branch -d refusal/deletion commit, all inside
  gucOS on BlockFS — then **ships the authored repo out through the tty
  (tar + base64, both shipped busybox applets) and judges it with the
  HOST's real git**: `fsck --strict`, full history across both branches,
  identity readback, blob-content readback, clean-status readback. That is
  the ticket's load-bearing acceptance: a repo only our own reader accepts
  proves nothing. Session 2 proves the authored repo survives a reboot
  (refs + loose objects reread cold off BlockFS). Full file PASS.
- **sweep `os-git-cli.mjs`**: leg 5 flipped from "init/add/commit answer
  read-only" to a positive write flow at the VT1 shell; `merge` carries the
  unimplemented-verb assertion and the typo path is unchanged — **the
  invalidated assertions were re-cut with more coverage, not deleted**
  (same for the kernel e2e's old `==readonly` section and the help/version
  regexes). The file header's stale "manual-tier, not part of the
  auto-sweep" claim is corrected (it IS a sweep member; the planner maps it
  to `sweep`). Full file PASS standalone.

**Breakage evidence** (`build/breakage-evidence-475.log`, gitignored under
build/ by design — the log is the artifact, this section is the record):

- A (disable update_all after add_all): fakegit stayed **21/21 GREEN** — a
  null result taken seriously: root-caused as dead code (finding 2 above),
  not shrugged off. The re-designed A2 targets load-bearing code.
- A2 (pathspec `add` silently stages nothing, exits 0): fakegit
  **16 passed, 5 failed**, each failing at the NAMED step; the 13 read
  fixtures and the two fixtures staging via `.`/`-A` stay green — the
  negative control.
- B (`branch -d` refusal removed): fakegit **20/21** — exactly
  `w_branch_delete`, "step was expected to FAIL but exited 0", the precise
  silent-success class the `!` marker exists to catch; kernel
  `test_git_e2e.js` **2 FAILED** — the direct refusal check AND the host
  differential (deleting unmerged topic orphaned c3, and real git's
  `log --all` no longer shows the full history). The cross-implementation
  oracle catches consequences, not just messages.
- Revert → fakegit **21/21 GREEN**.

Bypass scan of `origin/main..HEAD`: positive control (3/3 patterns hit a
seeded file), then zero hits in the diff.

## Deliberate cuts — none silent

- `commit <paths>` refused with a loud message (stage first).
- No `--amend`, no `-F`, no editor (no `-m` says so and names `-m`).
- `add -f` (force-add ignored files) not implemented — the ignore message
  says so.
- `branch -m` (rename), `checkout` of remote-tracking refs: absent
  (`merge`/`tag`/`reset`/network verbs answer "not implemented yet" by
  name; #478 owns the network leg).
- `checkout -- <paths>` caps at 64 paths with a loud error.
- Commit summary omits the "N files changed" stats line (the `[branch
  hash] subject` line is the parseable part).
- `config`: get/set only (no --list/--unset).

## Gate price (measured, not inherited)

`tests/run.py` maps to every py category + unit + blockfs, so this diff's
gate is the priced kernel+sweep baseline PLUS the python estate — the cost
of putting the write-set goldens where the CLI's fast regression guard
lives (the alternative, kernel-e2e-only coverage, would leave git.c
regressions detectable only by a 25-minute suite). Dry-run plan and the
gate log: `build/gate-475.log`, judged from `build/test-run/summary.json`.

## Pre-authorised rebuttal — the condition under which this is wrong

- **"The repos only fsck because the tests ran on host fs"** — refuted in
  advance: the kernel e2e authors its repo ON BlockFS inside gucOS and the
  host fsck runs on the extracted bytes.
- **"The goldens are machine-dependent"** — the known leak vectors (host
  `~/.gitconfig` via HOME, init.defaultBranch, wall-clock commit times) are
  each pinned (HOME=scratch, explicit `-b main` in fixtures, env dates). If
  a golden still differs on another machine, the fixture harness is the
  suspect, and the fix belongs there, not in the goldens.
- **"config is scope creep"** — possibly; argued above, trivially
  strippable, and flagged here rather than laundered.
