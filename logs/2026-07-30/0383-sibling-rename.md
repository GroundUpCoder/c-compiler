# todos/0383 — the sibling rename lands: overlay `python-clang` → `cpython-clang`

The 0374 rename left one deliberate gap. The sibling clang-simplified overlay
kept the project name `python-clang`, and `packages/cpython-clang.json` kept
`clangApp: "python-clang"` to match it. The gap was safe to close only after
every lane with an old-name package definition had merged. That condition is
now true, so this lane closed the gap on both sides in one change window
(`todos/CPYTHON.md` §6.3).

## What changed

- Sibling branch `0383-sibling-rename` @ a1a2a6b: `wasm/image/manifest.json`
  renames the three fields (`name`, `out`, `install`) to `cpython-clang`.
- This repo: `packages/cpython-clang.json` flips `clangApp` to
  `"cpython-clang"`. `todos/CPYTHON.md` §6.3 loses its stale pre-rename note.

## Gotchas worth keeping

- **The overlay is an artifact, not a source file.** `out-image/` is
  gitignored. The committed sibling change is three lines of manifest. The
  merge is not complete until someone rebuilds `out-image/` in the sibling
  MAIN checkout — until then, the on-disk overlay there still publishes the
  old key, and `mkpkg --clang` against it goes red with the flipped
  `clangApp`. Rebuild at the lockstep merge.
- **`mk-overlay.mjs --reuse` makes the rebuild cheap.** I seeded the branch
  worktree's `out-image/` with the main checkout's payload directories (all
  projects except the renamed one). The rebuild then compiled only
  `cpython-clang` (249 TUs) and reused the other ten payloads.
- **A sibling worktree needs one symlink**: `simple1/out` → the main
  checkout's `simple1/out` (the built toolchain). Note the symlink is NOT
  ignored (`simple1/out/` in `.gitignore` matches a directory only — the
  0348 class), so the overlay provenance reports `dirty: true` in a branch
  worktree. Harmless for a gate artifact.
- **The gate proves the rename by construction.** `test_clang_pkgs_e2e` and
  `test_cpython_clang_e2e` read the sibling through `CLANG_ROOT`. Pointed at
  the branch worktree, a pass is only possible with the new overlay key: the
  package now claims `cpython-clang`, and `mkpkg --clang` fails loudly when
  the overlay does not carry that payload.

## Numbers

todos green, host green, kernel 137/137, sweep 42/42 (both heavy summaries:
filter null, recorded == total, one run each). Survivor grep: 119 bare
`python-clang` lines in this repo (all dated records, quotes, or machine
build-root paths — named in the ticket's Result), 0 in the sibling.
