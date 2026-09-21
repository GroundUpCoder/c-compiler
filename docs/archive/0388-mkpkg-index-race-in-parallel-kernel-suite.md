# 0388 — test_cpython_clang_e2e is intermittent under -j2: mkpkg base-index and --clang-superset invocations race on the shared dist/packages/index.json

- **Status**: done
- **Priority**: 2
- **Difficulty**: medium
- **Design**: this file.
- **Provenance**: master cont-129, 2026-07-28, during the **185 merged gate**.

## The observation (this part is FACT)

The 185 gate (main + `0376`, image 185, `d2623193`) ran the kernel suite at `jobs: 2`:

```
kernel suite: 124 passed, 1 failed, 1 carried from earlier run(s)  (932.9s)
              [125/125 selected, 126/125 recorded]
```

The single failure was **`test_cpython_clang_e2e.js` (1.9 s)**, with **32 assertion
failures**, beginning:

```
  ok   a fresh gucOS ships NO python implementation
  ok   the only python verb on a fresh image is the cmdalt dispatcher
  ok   that verb cannot run code — it exits 127
  ok   ...and it names the package to install
  FAIL catalog lists cpython-clang            <- `cat` extra printed EMPTY
  FAIL cpython-clang installs (exit 0)  RC=1
  ... everything downstream RC=127 / RC=1
```

🔴 **The same test PASSES on the same bytes when run alone.** Verified twice, both after
the failing suite run:
1. `node tests/kernel/test_cpython_clang_e2e.js` in the **185 bundle worktree** (the exact
   failing tree, `d2623193`) → **PASS**.
2. The same on **`origin/main` @ `1626983d`** (image 184) → **PASS**, import sweep 166/180.

⭐ So the 185 byte-set is not implicated. **What failed is the harness, under parallelism.**

## The mechanism (this part is a HYPOTHESIS — confirm before fixing)

Two different helpers build a package repo into the **same** path,
`<ROOT>/dist/packages/index.json`:

- `tests/kernel/lib/gucman.js` → `ensurePackages()` spawns `tools/mkpkg.js --quiet`
  — **no `--clang`**, so it emits the **BASE** index, which by construction contains
  **no `-clang` name at all** (`listPackages`' default filter).
- `tests/kernel/test_cpython_clang_e2e.js` → `ensureClangPackages()` spawns
  `tools/mkpkg.js --quiet --clang --clang-root=$CLANG_ROOT` — the **SUPERSET** index,
  which is the only one containing `cpython-clang`.

At `-j2`, a base-index writer (`test_gucman_e2e`, `test_gucman_quake_e2e`, `test_fontpkg_e2e`,
`test_software_e2e`, `test_clang_pkgs_e2e`, …) can overwrite `index.json` **after** the clang
test built it and **before** the in-OS `gucman` fetches it. The served catalog then genuinely
has no `cpython-clang` — which is exactly the observed symptom, including the **empty**
catalog string and the `RC=1` install.

⚠️ **This is a hypothesis with a plausible mechanism, not a confirmed root cause.** It is
consistent with every observation, but nobody has yet caught the interleaving in the act.
🔴 **Do not "fix" this by retrying the test or lengthening a timeout.** Confirm first — e.g.
log the index mtime/sha immediately before the catalog read, or run the suite at `-j1` and at
`-j2 --repeat N` and compare flake rates.

⭐ **Note the 1.9 s failure time.** Per the standing rule, **a test that dies that fast has no
timeout story** — it failed at an assertion instantly. This is not contention-induced slowness;
it is a wrong *file* being read.

## VERDICT: CONFIRMED (2026-07-28, lane `0388-mkpkg-index-race`)

The hypothesis is confirmed, and the mechanism is **worse than described above**:
a base run does not merely overwrite `index.json`, it **deletes the clang payload
bytes from `pool/`**. Three independent pieces of evidence.

### E1 — the causal step, deterministic

`mkpkg --clang` then plain `mkpkg` over the same dir. Positive control first: the
superset index really did carry the name and the payload really was on disk.

```
superset:  26 pkgs, 9 -clang names, cpython-clang PRESENT
           pool/cpython-clang_3.13.5_3af38bf4bbb2721d.pkg.tar.gz  on disk
after `node tools/mkpkg.js --quiet`:
           15 pkgs, clang names (NONE), cpython-clang ABSENT
           11 pool payloads DELETED
```

The deleter is the **orphan prune** at `tools/mkpkg.js` `main()` ("Anything the
fresh index doesn't reference goes"). A base build's `avail` excludes every
`requires:"clang-sibling"` definition, so all nine `-clang` payloads (plus
`sdldemo`, `stl4`) are orphans by construction. This is the behaviour
`test_clang_pkgs_e2e.js`'s header calls "the accepted thrash (CLANG-CPP-EPIC
Part II §7)" — accepted when the suite was serial, a race once it is not.

### E2 — end-to-end, through the real server

A probe running the clang test's exact sequence (`mkpkg --clang` → `serve.js` →
fetch) with a base `mkpkg` fired mid-window reproduces **both reported
assertion failures verbatim**:

```
served index (before base run):  26 pkgs, cpython-clang=PRESENT
  [mkpkg (base)] exit=0 (0.1s)
served index (after, same URL):  15 pkgs, cpython-clang=ABSENT
  payload on disk now: DELETED (pruned)
  "catalog lists cpython-clang"      -> FAIL (empty)
  "cpython-clang installs (exit 0)"  -> FAIL (RC=1)
```

⭐ Note the destructive run takes **0.1 s** (everything content-fresh and
reused). It is effectively instantaneous, so it fits anywhere in the window.

### E3 — the interleaving caught in the act, in the real suite at `-j2`

`node tests/kernel/run.js -j2 --filter=cpython_clang,gucman_quake,fontpkg`, with
an index-write trace. Times relative to the first event:

```
   0.0s  CLANG_ENSURE_START  test_cpython_clang_e2e.js
   1.6s  mkpkg INDEX_WRITE  clang=1 n=26 cpython=1
   1.6s  CLANG_BUILT        <-- window opens
 113.0s  BOOT_START
 114.1s  mkpkg INDEX_WRITE  clang=0 n=15 cpython=0   <-- test_fontpkg_e2e.js
 114.1s  (+ 11 PRUNE lines: every -clang payload deleted)
 118.3s  BOOT_END           <-- window closes
```

🔴 **The invariant is violated on every such run** — a sibling test rewrote the
index and deleted the payloads 1.1 s after the clang test's OS began booting.
That run still reported `ok` only because the in-OS `gucman list`/`install` step
happened to fetch ~1 s before the overwrite. **Whether the suite goes red is
decided by about one second of boot timing**, which is exactly the intermittent
profile the 185 gate saw. Registry order makes the pairing routine:
`test_cpython_clang_e2e` (159) is adjacent to `test_gucman_quake_e2e` (161),
`test_fontpkg_e2e` (162) and `test_software_e2e` (163), so at `-j2` it is
scheduled alongside a base-index writer essentially every run.

**Eight kernel tests write the one `dist/packages`**: base — `test_gucman_e2e`,
`test_gucman_quake_e2e`, `test_fontpkg_e2e`, `test_software_e2e`,
`test_cc_win32_e2e`, `test_cmdalt_e2e`; superset — `test_clang_pkgs_e2e`,
`test_cpython_clang_e2e`.

## Why this matters beyond one flaky test

`dist/packages/` is **shared mutable state in the repo root** that every package e2e writes
through a subprocess. Any two package tests can collide, not just this pair — the clang/base
split merely makes the collision *visible* because the two indexes differ in membership. A
base-vs-base collision would silently produce a *correct-looking* index and could mask a real
failure instead of causing a false one. 🔴 **That is the more dangerous direction and is the
real reason to fix this.**

## Plan

1. Confirm the interleaving (see above). Record the evidence in the ticket.
2. Give each test an **isolated** package-repo output dir — e.g. `mkpkg --out=<dir>` into a
   per-test temp dir, or a `build/test-packages/<testname>/` convention — so no two tests
   share `dist/packages`. Prefer isolation over locking: a lock serialises the suite and
   `mkpkg` is the expensive step.
3. If a shared warm cache is worth keeping for speed (mkpkg is content-addressed and reuses
   unchanged payloads), keep the **pool** shared and make only **`index.json`** per-test.
4. Consider whether `tools/mkpkg.js` should refuse to write an index into a directory another
   mkpkg is concurrently writing (fail loud rather than interleave).

## The fix (shipped)

Isolation, not locking — `mkpkg` is the expensive step and a lock would serialise
the suite.

1. **`tools/mkpkg.js --pool=DIR`** decouples the content-addressed payload STORE
   from the per-consumer index. `<out>/pool` becomes a **hardlinked view** of
   exactly the payloads that index references (no byte copy), so N isolated
   repos share ONE warm cache — a cold build of the full set is ~90 s, a reuse
   ~0.1 s.
2. **A shared store is append-only.** BOTH prunes — orphan and
   superseded-version — are scoped to the private view. A concurrent builder can
   neither lose a payload it has already indexed nor hit ENOENT materializing
   one. Reclaim is `rm -rf` on the store; refcounted GC is deliberately not
   attempted, since it would put the deletes back.
3. The view is populated **before** the index is published, so a repo never
   advertises a payload that is not there yet.
4. **One writer per out dir**: a `.mkpkg-lock` refuses a concurrent build with a
   loud exit 1 naming the holder and the `--out`/`--pool` fix, and self-heals
   across a dead holder. Isolation is the fix; the lock is so a future caller
   that forgets it gets a named failure instead of a silent interleave. (It
   earned its keep immediately — see below.)
5. **Tests**: `ensurePackages`/`ensureClangPackages` return `{ dir, index }` and
   build into a per-INSTANCE `mkdtemp` under `build/test-packages/` over the one
   shared pool, removed at exit. The two duplicated local `ensureClangPackages`
   helpers collapse into the shared one.

⚠️ **The unit of isolation is a running instance, not a test file.** Keying the
dir on the file name looked right and was wrong: `--repeat N` runs the same file
concurrently, so `test_cpython_clang_e2e` collided with ITSELF (2 of 3 repeats
died). The lock is what surfaced that — as a named refusal, not a bad index.

⚠️ Reuse used to require EXACTLY ONE candidate payload per (name, version).
True for an owned pool, false for an append-only shared store, where one version
legitimately accumulates shas. Left alone it would have silently stopped reusing
anything and rebuilt the world every run. Newest candidate wins now.

## Evidence that it holds

- **`tests/serve/test_mkpkg_isolation.js`** (new, host suite guardrail (d)) —
  **25/25**. Carries a **RED CONTROL** that still reproduces the prune on demand:
  without it the green legs would pass equally against a tool that never pruned
  at all. Also pins the hardlink (same inode, not a copy), the append-only
  store, the multi-sha reuse, and both lock behaviours.
- **No test writes the shared repo at all — demonstrated, not asserted.**
  `dist/packages/index.json` was byte- and mtime-identical
  (`md5 f6a52f5b4c6e772439ce51fb541cf25c`, `mtime 1785223164`) before and after
  9 package-test runs. `build/test-packages/` held only `pool/` afterwards —
  every per-instance repo dir cleaned itself up.
- **Flake gate**: `-j2 --repeat 3 --filter=cpython_clang,gucman_quake,fontpkg`
  → **9 passed, 0 failed**; all three files **3/3, flake 0%**. Before the fix the
  same command reported `test_cpython_clang_e2e` **FLAKY 1/3 (67%)**. Each repeat
  was verified to have really run (43 `ok` lines and the in-OS import sweep
  `166/180` in all three logs), not skipped.

## Acceptance

- The mechanism is **confirmed or refuted in writing** before any fix lands.
- `node tests/kernel/run.js` green with NUMBERS at the suite's default parallelism, and
  `--repeat` on the package tests shows a **non-flaky N/N** rate.
- No test writes `dist/packages/index.json` while another test reads it — demonstrated, not
  asserted.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or retire an
  anchored line in the same commit.

## Cross-references

- **`0386`** — `test_netsurf_mutation_e2e.js` intermittent. **Different failure mode**
  (pixel comparison), do not merge the two. This one is a shared-file race; that one is not.
- **`0369`** — harness fixed timeouts under contention. Also **not** this: `0369` is about
  caps and slowness, and this test failed in 1.9 s.

## Gate record (lane `0388-mkpkg-index-race`)

- `node tests/kernel/run.js` (default `-j2`) — **124 passed, 1 failed** (911.1 s),
  `files {total 125, selected 125, executed 125, resumed 0, carried 0, recorded 125}`,
  `runs` 1 entry, filter null. **All eight package tests green.**
- The one failure is **`test_netsurf_mutation_e2e.js` = `0386`**, not this ticket:
  it holds ZERO references to `mkpkg`/`dist/packages`, its failure is the
  ink-pixel comparison, and it passes solo on re-run. Logged there as sighting 3
  — with the finding that its counts (**285 vs 234**) are byte-identical to
  sighting 1, which argues for a bimodal deterministic state rather than noise.
- `node tests/host/run.js` — all host tests passed (includes the new guardrail).
- `node tests/todos/run.js` — **5/5**. `queue.js check` OK (107 items, 276 done,
  42 liability entries); `liabilities.js check` OK.
- `tests/run.js --diff` plan for this diff was `todos, host, kernel` — all three run.
