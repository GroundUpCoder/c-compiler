# Batch I — #543 doom drivers into the sweep, #539 shim collisions, #481 features.h, #480 worktree pin, #403 (findings-only)

Lane: `batch-i` off `main` @29a19d41 (Batch H). Five light P2 tickets, one
full gate at the end. Two of the five turned out to need something other
than what their bodies prescribed; the measurements are recorded here.

## #539 — ccprobe_libc.c: the ticket's fix shape would have broken cpython-clang

The collision is real and reproduced exactly as filed: `node compiler.js -a
link vendor/cpython/bin.json` = 9 link errors — 7 duplicate definitions
(gmtime_r, tzset, clock_getres, truncate, wcstol, fma, explicit_bzero) + the
2 already-filed #122 conflicting-types errors. Verified per symbol that
compiler.js's libc defines all seven (wcstol @28636, fma @30280, truncate
@32710 inside the embedded `__posix.c`, explicit_bzero @32749, gmtime_r
@33226, tzset @33277, clock_getres @34031).

**But "drop each shim fallback" — the ticket's fix shape — was wrong.** This
file has TWO consumers (todos/CPYTHON.md §4.3): the clang-simplified sibling
compiles the same `sources` list, and its libc is a re-vendored snapshot of
compiler.js's libc at an OLDER pin (todos/0330) that still lacks six of the
seven. Measured directly in `~/git/clang-simplified/wasm/libc`: only wcstol
exists there — and the sibling's manifest already carries
`-Dwcstol=__ccprobe_wcstol` precisely to dodge that one collision, which
also proves its link rejects duplicates. Deleting the set would have broken
the shipped cpython-clang payload build.

Fix: the seven bodies are now `#ifdef __clang__` (compiler.js predefines
neither `__clang__` nor `__GNUC__` — zero hits in compiler.js). compiler.js
link: 9 → 2 errors (the #122 pair only, out of scope here); the sibling
build is byte-identical in effect. The 0330 rule stands and is restated in
the file header: these bodies are pin-staleness artifacts — when the sibling
re-vendors its libc past the 0325 growth, delete the guarded block AND the
sibling's `-Dwcstol` rename.

**Outside-fence finding (reporting, not filing):** clang-simplified's libc
pin is stale relative to the batches B/C libc growth. Re-vendoring it (the
0330 move, in the sibling repo) is the real fix that retires the guarded
block; nothing in this repo schedules that.

## #481 — vendor/libgit2/features.h deleted, proven inert first

Red control before the fix: an `#error` plus a `GIT_SHA1_BUILTIN` flip
planted in features.h still built `vendor/libgit2/bin.json` successfully
and BYTE-IDENTICALLY (sha256 045aeb1c… for baseline, sabotaged, and
post-deletion builds). The `#error` half is the sharp part: it proves the
file is never included at all, not merely guard-shadowed — the only include
path into the feature config is `src/util/git2_util.h` → the generated
same-dir forwarder `src/util/git2_features.h` → `../../git2_features.h`.

Of the ticket's three options I picked DELETE: a forwarder or `#error`
would preserve a second config-looking file whose only remaining function is
to be found by mistake. README updated (both mentions);
`mkgit2srclib.js --check` clean; no reference to the path anywhere else in
the estate (searched js/json/md, path-anchored per the ticket's warning
about the generic basename).

## #480 — linked-worktree discovery pinned, red-controlled

New `==worktree` leg in test_git_e2e.js: `.git` as a regular FILE with a
`gitdir:` pointer — the `git worktree add` layout, built in-OS by shell
(the shipped git is read-only) with exactly what libgit2's
`is_valid_repository_path` demands: `HEAD` (ref: form, host-oracle
`symbolic-ref`) + `commondir` (`../..`) in `worktrees/wt`, plus the
`gitdir` back-pointer real git writes. Driven from TWO levels below the
worktree root; asserts rev-parse HEAD == host oracle (the gitdir:-file
walk), HEAD^ (refs + objects through the commondir hop), and `log -n 1`
(commit inflated from the common object store). kfs's lexical `..` collapse
is not in the loop — libgit2 normalises the commondir join in its own path
math, and the fixture has no symlinks for the two to disagree over.

Red control: with the `S_ISREG` .git-file branch of libgit2's find_repo
neutralised (`0 &&`), exactly the three new discovery checks failed; all 42
pre-existing checks stayed green. Reverted; full file PASS. os/git/git.c
untouched (ticket scope).

## #403 — findings-only: ALREADY DONE by #417/#418, and the menu sub-ask is wrong

The ticket (filed 08-02) was overtaken by f5008a09 (merged 08-03):
gdiplusdemo is already OUT of os/image.json and ships in
`packages/demos.json`, bundled with winbox/pollball/gpubox/gdidemo/ctldemo/
fontramp/k32demo — a deliberate one-package design ("the demos are only
meaningful as a set; per-app cards would clutter the storefront"). Filing a
separate packages/gdiplusdemo.json now would contradict that later
decision, not implement the ticket.

The residue I checked before calling it done: (1) the menu-entry ask is
wrong for this binary — `main()` is selftest-or-usage-exit-2, there is NO
windowed mode, so a Demos menu entry would be a dead launcher; demos.json
correctly gives menu entries only to the windowed demos (k32demo likewise
none). (2) The #94 acceptance path is intact: test_gdiplus_e2e.js runs
`gdiplusdemo selftest` on the default fat image (packages folded in),
green in the Batch H gate and re-verified by this batch's gate. (3) No
os/image.json edit happens anywhere in this batch → **no version bump
owed** (the kickoff's question — answered by absence: the premise that this
ticket changes the sealed blob's bytes died with f5008a09).

k32demo: also already in demos.json; nothing left of the ticket's
out-of-scope question worth filing.

## #543 — the doom drivers join the sweep; the cost fear died by measurement

The ticket's open call (sweep vs separate/diff-aware suite) hinged on the
doom build cost. Measured before deciding: `build-doom.mjs` = **1.3 s**
(it is a full recompile — the compiler is just fast on doom),
doom-renders 5.2 s, doom-motion 15.7 s ⇒ ~21 s against a ~1200 s / 51-file
sweep, under 2%. Option (a) — the existing sweep — wins outright:

- Diff-awareness is FREE: every input in doomFreshnessSpec()
  (vendor/doom/**, compiler.js, host.js, build-doom.mjs's own dir) already
  maps to `sweep` in tests/run.js RULES. Option (b) would re-encode that
  input set as a second RULES key that could drift from doom-artifacts.mjs.
- A separate suite is another heavy-lock holder (Chromium), so it would
  serialise behind the sweep anyway — zero wall-clock win.
- One more suite is one more thing a ship gate can mis-read as covered
  (rule-5 territory); sweep members inherit the evidence guard, per-file
  logs, and `recorded == total` for free.

Shape: `os-doompage-renders.mjs` / `os-doompage-motion.mjs` are discovered
sweep members that spawn the manual drivers UNCHANGED (one code path for
hand-runs and suite runs). `ensureFreshDoomPage()` (doom-artifacts.mjs)
rebuilds a missing/stale doom.html instead of refusing — in a suite, a
gitignored build product must never be the red — while the hand-run
drivers keep #466's refuse-on-stale stance; a missing INPUT still fails
loud after rebuild. Sweep count 51 → 53. No re-label: nothing about
artifact production needed restructuring.

Behavioural acceptance, the ticket's exact shape: `exit(1)` planted in
D_DoomMain → `os-sweep.mjs --filter=os-doompage` rebuilt the page ITSELF
and went red 0/2 (renders 0/45000 non-black; motion never got a frame),
no driver run by hand. Reverted → 2/2 green in 20.9 s.

Note for future flake triage: the two members run the drivers' fixed ports
(3176/3177). The sweep forces `-j1`, so this is fine serially; if the
sweep ever went parallel these would need port parameterisation.

## Gate

One full `node tests/run.js all` on the final tree, no `--resume`, verdict
in the handback. (`--diff origin/main` maps this batch to
projects/fakegit/kernel/sweep; the full gate was the lane's brief.)
