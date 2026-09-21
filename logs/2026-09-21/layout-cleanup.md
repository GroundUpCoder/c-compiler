# Top-level layout cleanup — todos/ dissolved, ext/ folded into compiler.js

jku direct ask (2026-09-20/21): the repo root had accumulated directories
whose names no longer described their contents. This entry records what moved
where and why, so the ~3,000 rewritten path citations have one explanation.

## What moved

| Before | After | Why |
|---|---|---|
| `todos/*.md` (45 design docs + `LIABILITIES.md`) | `docs/` | Nothing in `todos/` was a todo any more; the file queue was retired 2026-07-30. Design docs are documentation. |
| `todos/done/` (313 completed items, 1.7 MB of text) | `docs/archive/` | Kept — it is the only readable form of the pre-tracker history and it is small. |
| `todos/liabilities.js`, `idspace.js` + tests | `tools/liabilities/` | Tooling, not docs. `REPO_ROOT` is now two levels up. |
| `todos/githooks/` | `tools/githooks/` | **Per-clone action**: `git config core.hooksPath tools/githooks`. |
| `tests/todos/` (suite `todos`) | `tests/liabilities/` (suite `liabilities`) | The suite validates the register; the name should say so. Registry change → this lane gates alone. |
| `notes/*.md` (2 audits) | `docs/` | Same identity as the design docs. |
| `notes/*.mjs`, `*.sh` (Minesweeper demo drivers) | `tools/minesweeper-demo/` | Runnable drivers, not notes. |
| `passb/` (#508 Pass B round 2 tty harness) | `logs/2026-08-13/508-passb/` | A one-off record. The maintained dogfood drivers are `tools/os-drive.mjs` (browser) and `tools/os-drive-headless.mjs` (headless). |
| `build/nondeterminism-0269/` (6 tracked files in a gitignored dir) | `logs/2026-07-20/nondeterminism-0269/` | Sits beside its root-cause log; tracked files under an ignored path were a trap. |
| `CALLBACKS.md` | `docs/CALLBACKS.md` | A host ABI document. |
| `ext/` + `libc-ext.js` + `tools/build-libc-ext.js` + `tests/ext/` | folded into `compiler.js` | See below. |

## What was deleted

- `xp/` — a bare-metal x86 voxel boot demo (nasm + BIOS), unrelated to this
  compiler; its README pointed at the sandbox repo. Included committed binaries.
- `demos/` — four stale GC samples from June; README's self-host link there
  had already gone dead (that demo lives in `old/self-host/`).
- `HANDOFF.md` — self-declared historical snapshot from 2026-07-12.
- `gc-sample.c`, root `*.wasm` scratch.
- Untracked `projects/sedit/` and the untracked `tests/browser/*sedit*.mjs`
  scratch scripts — a port of an *external* SDL3 editor from a sibling repo.
  **Not** `os/sedit`, which is the shipped gucOS editor (#718/#729/#730) and
  is untouched here; whether to retire that too is a separate jku call.

## ext/ folded into compiler.js

`libc-ext.js` was a generated, JSON-string-encoded artifact (159 KB) built from
22 vendored musl files and loaded as an *optional* sibling: Node read it from
disk beside `compiler.js`, the kernel worker `importScripts` it, and the bake
required it while the compiler treated it as optional — three loaders for one
map, plus a suite (`ext`) whose job was to prove the sync between source and
artifact. `c-compiler-simplified` already embeds the same map.

Now the 7 headers and 14 sources are template-literal entries in
`_stdlibHeaders` / `_stdlibSources`, with a provenance/license banner carrying
what `ext/README.md` said. Backslashes are escaped in these entries (unlike
the older inline headers) so C line continuations survive verbatim; the
existing `spliceLines` path joins them. Verified: every entry byte-identical
to the old artifact, `regex.h` resolves through `createDefaultPPRegistry()`.

Removed with it: the `getExtLibMap` loader and `EXT_PROVIDED_HEADERS`
diagnostic, the ext tier in `__require_source` resolution, `os-common.js`'s
`readLibcExtMap` + the bake-input stat + the `extProvidedHeaders` bake guard,
the kernel-worker import, the `ext` run.py category and its diff rules, and
the test pins that asserted the artifact's shape (`test_diff_rules` EXT block,
`test_source_packages` ext block, `doom-artifacts` input). `libc-sources`'
`inputs` is now `['compiler.js']`. The external deploy allowlist in
`comguc/scripts/build.mjs` drops `libc-ext.js` (separate repo, edited
alongside). The external embedder still carries its own vendored copy of the
old file; that is its own concern.

compiler.js grew from 1,797,685 to 1,944,010 bytes.

## Path-citation rewrite

Every tracked text file outside `logs/`, `old/`, `docs/archive/`,
`vendor/netsurf/netsurf/` and `vendor/netsurf/patches/` had its citations
rewritten mechanically, in this order: `todos/done/` → `docs/archive/`,
`todos/githooks` → `tools/githooks`, the validator scripts → `tools/liabilities/`,
`tests/todos/` → `tests/liabilities/`, `todos/NNNN` → `docs/archive/NNNN`,
then `todos/` → `docs/`. The excluded trees are historical records or carry a
patch record that must match byte-for-byte (the NetSurf pre-commit check), so
their `todos/` citations stay as written; `docs/README.md` §3 says both forms
resolve into `docs/archive/`.

`os/image.json` bumped 296 → 297: a baked text file (`/usr/share/openwith`)
and the baked `os/doc/*.md` carry rewritten citations, so the blob bytes move.

## Gate

The diff maps to all 25 suites (compiler.js changed). Run as foreground
slices on this tree, records merged per suite:

| Suite | Result |
|---|---|
| liabilities, netsurf-patch, unit, blockfs, host | green |
| py: ast … cairo / micropython … fakegit | 122 + 780 passed, 0 failed |
| kernel | 209/209 recorded, all pass (4 bins + gucos-packages + test_os_boot solo, 707 s) |
| sweep | 74/74 recorded, all pass (7 bins) |

One red during the run: `test_ctlpanel_e2e.js` matched `/todos\/0049/` in
the Display applet text — an escaped-slash regex the plain `todos/` rewrite
skipped. Fixed and re-run green; noted above as a rewrite trap.
