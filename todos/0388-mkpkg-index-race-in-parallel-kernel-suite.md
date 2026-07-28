# 0388 — test_cpython_clang_e2e is intermittent under -j2: mkpkg base-index and --clang-superset invocations race on the shared dist/packages/index.json

- **Status**: open
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
