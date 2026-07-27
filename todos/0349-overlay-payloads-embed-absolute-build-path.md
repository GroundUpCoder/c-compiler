# 0349 — overlay `.wasm` payloads embed the ABSOLUTE build path, so the bytes depend on WHICH DIRECTORY built them

- **Status**: open
- **Provenance**: found live by master cont-112 while merging **0330**
  (2026-07-28), by A/B-ing the lane's worktree overlay against a main-tree
  rebuild. Lesson **(BM)** in `~/git/meta/meta/notes/MASTER-LESSONS.md`.
- **Priority**: **P2.** Two distinct costs (below), one of which is a
  measurement-integrity defect that has *already* produced a wrong finding.
- **Repo**: the producer is the **sibling** — `clang-simplified`
  `wasm/tools/mk-overlay.mjs` + `cc2wasm`. Filed here because this repo is the
  consumer and holds the queue.

## The defect

`mk-overlay.mjs`'s own header states the contract:

> The .wasm PAYLOADS are byte-reproducible (same inputs -> same hashes; wasm-ld
> bakes the output basename, so we build straight to the final name); only
> overlay.json's builtAtUtc/provenance vary per run.

**That contract does not hold.** The payloads embed absolute filesystem paths —
from *both* repos — so two builds with byte-identical inputs produce different
bytes if they run in different directories.

Measured, with every other variable pinned:

| variable | lane worktree build | main-tree build |
|---|---|---|
| repo tree | `85aa87b9` | `35b080e` (merge of the same) — `git diff --stat` **empty** |
| libc pin | `9fdaed52` | `9fdaed52` |
| compiler ELF `simple1/out/llvm` | sha256 `cba60f53…` | sha256 `cba60f53…` — **identical** |
| **payload bytes** | **5 of 10 differ** | — |

The embedded strings are the build roots themselves:

    $ strings -a out-image/box2d-clang/box2d-clang.wasm | grep -c 'git/clang-simplified'
    28      # main-tree build
    $ strings -a <worktree>/out-image/box2d-clang/box2d-clang.wasm | grep -c worktree
    28      # worktree build

`doom-clang` embeds the **c-compiler** root the same way
(`/Users/jku/worktree/c-compiler/0330-libc-revendor/vendor/doom/src/w_wad.c`
vs `/Users/jku/git/c-compiler/vendor/doom/src/w_wad.c`).

### The size delta is exactly the path-length arithmetic

The two roots differ by **24 characters**. Per payload, `Δsize = 24 × (number
of embedded path strings)`:

| payload | embedded paths | predicted Δ | measured Δ |
|---|---|---|---|
| box2d-clang | 28 | +672 | **+672** ✅ |
| etl-clang | 24 | +576 | **+576** ✅ |
| imgui-clang | 10 | +240 | **+240** ✅ |
| gameboy, glm, sdldemo, stl4, tinyrenderer | 0 | 0 | **0** ✅ |
| ninja-clang | 11 | +264 | +272 *(+8 residual)* |
| doom-clang | 2 (c-compiler root) | +48 | **+48** ✅ |

Eight of ten are exact. The small `ninja-clang` residual is unexplained and is
part of this ticket's scope.

## Cost 1 — it corrupts cross-directory A/B measurement (this already happened)

`todos/0330` asked how many overlay payloads the libc re-vendor changes. The
0330 lane answered **"5 of 10 changed"** and built a mechanism story around it
(`strerror`'s new `EILSEQ` case plus surviving `__SDL.c` entry points). That
finding is **an artifact**: the lane compared its *worktree* build against the
*main-tree* `out-image/`, so it measured the path difference, not the libc.

Re-measured in a single directory (main tree, pre-revendor `out-image/` from
2026-07-21 vs a post-merge rebuild), holding the compiler ELF and tree
constant, the true libc-attributable delta is:

**1 of 10 payloads — `ninja-clang`, +48 B.** Nine payloads are byte-identical.

⭐ That nine-of-ten reproduction *across six days in the same directory* is also
the control that rules out run-to-run nondeterminism: the variance is
positional, not random.

## Cost 2 — the published packages leak developer absolute paths to users

These payloads ship to end users as gucman packages. Every install currently
carries `/Users/jku/...` strings (28 occurrences in `box2d-clang` alone) plus
their byte cost. That is an information leak and dead weight in the shipped
artifact.

## What to do

1. Make the build path-independent — the standard mechanism is
   `-fdebug-compilation-dir` / `-ffile-prefix-map` (or the `cc2wasm` equivalent)
   so sources are recorded relative to a stable root.
2. **Add a guard that makes the reproducibility contract testable**: build the
   overlay twice from two different directories and assert the payload hashes
   match. Absent that, this defect is invisible — which is exactly how it
   survived to here.
3. Explain (or eliminate) the `ninja-clang` +8 residual.
4. Update `mk-overlay.mjs`'s header comment: until (1) lands, its stated
   byte-reproducibility claim is **false**, and a comment asserting an invariant
   the code does not hold is worse than no comment.

## Scope

`clang-simplified`: `wasm/tools/mk-overlay.mjs`, `cc2wasm`, and the new guard
(`wasm/tools/run-overlay-test.sh` is the natural home). **No `os/` change and
no image-version bump** — the `*-clang` apps are gucman packages built from the
overlay, not baked image entries.

## Not in scope

Re-opening 0330. Its libc re-vendor is correct, merged, and its acceptance
(`tests/kernel/test_clang_pkgs_e2e.js`) **passes** — 0 SKIPs, verified by
master cont-112 against the re-vendored overlay. Only its *blast-radius
measurement* was wrong, and in the reassuring direction.
