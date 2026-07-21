# T3 close-out: merge to main, full re-gate, ship via the T1/T2 channel path

Close-out of the T3 clang ladder (Ninja + tinyrenderer, the STL tier —
`todos/CPP-LADDER-PROPOSAL.md`). The build itself landed last turn on two
branches: c-compiler `t3-ladder` @5b7e049 (packages + e2e + mkpkg growth) and
clang-simplified main @1beacf2 (ports + overlay published, direct-to-main).
This log records the merge, the re-gate of the MERGED tree (the prior turn's
browser sweep was backgrounded and treated as unknown), and the ship path.

## Merge

`origin/t3-ladder` merged --no-ff into a worktree off main @e188893 (the
just-landed osk-bigger merge) at **c9993d6** — clean auto-merge, exactly the
six disjoint T3 files (packages/ninja-clang.json, packages/tinyrenderer-
clang.json, tests/kernel/test_clang_pkgs_e2e.js, tools/mkpkg.js,
todos/CPP-LADDER-PROPOSAL.md, the T3 dev log). No overlap with the OSK
change; neither feature reverts the other.

## Re-gate (merged tree, all foreground)

- `test_clang_pkgs_e2e.js` in isolation: **39/39** (the six-package channel:
  installs/removes, ninja incremental "no work to do" leg, tinyrenderer
  golden, base purity, catalog).
- Kernel suite: **101 passed, 0 failed** (420s; no flakes this run —
  gucman_quake included).
- Host suite: **all green** (incl. the three Part II clang guardrails:
  base-purity filter, serve-with-clang preflights, mkpkg --clang sha256
  round-trip).
- Browser sweep `node tests/browser/os-sweep.mjs`, re-run to completion in
  foreground chunks with `--resume`: **34/35 files pass**. The one red is
  `os-touch.mjs` — proven PRE-EXISTING: identical deterministic failure on
  pristine main @e188893 (zero T3 content), taskbar-long-press window-menu
  leg, introduced by the osk-bigger geometry change. Filed as **P0
  todos/0271**; not a T3 regression (T3 touches no browser-facing file).
  `os-boots.mjs` failed once in the first chunk and passed on re-run
  (boot-lock/stale-server class, green in the final summary).
- Sibling per-app harnesses (clang-simplified @1beacf2, unchanged):
  `run-ninja-test.sh` **13/13**, `run-tinyrenderer-test.sh` **7/7**
  (bit-identical wasm-vs-native under -ffp-contract=off),
  `run-overlay-test.sh` **12/12**. The overlay run needed care: the script
  re-publishes out-image in place then re-publishes into a temp dir (~20min
  total, over the 600s tool ceiling), so it was executed as bounded
  foreground phases — in-place publish, then `mk-overlay --reuse` temp
  publish resumed across calls (a killed in-flight project leaves an
  empty/partial dir; delete it before `--reuse`), then the script's
  validation phases via a copy with the two publish lines elided. Gotchas
  hit: the script's SECOND `trap` (line 241) also rm -rf's `$TMP`, and the
  copy must live OUTSIDE the repo or its untracked self flips `git status`
  dirty and the provenance check correctly fails. Final verdict: overlay@1
  contract valid, payloads byte-reproducible vs an independent rebuild,
  ninja-clang answers `--version` (1.12.1) and the ETL battery passes 1984
  tests from the PUBLISHED builds.

## Ship path (the T1/T2 precedent, verified before executing)

Checked how box2d-clang/imgui-clang (T1, merged 2b6bfb7) and etl-clang/
glm-clang (T2, merged 1776bec) reached live gucOS: **they ride the tree —
merge to c-compiler main + overlay published on clang-simplified main;
NO image bump, NO comguc deploy, NO change to the live apex.** Evidence:

- comguc (the deploy repo) contains ZERO clang references — `build.mjs`
  runs plain `mkpkg`, so the deployed `/packages` repo is the base set by
  construction.
- The live apex was deployed AT e188893 (post-T2-merge) and its
  `/packages/index.json` lists the 12 base packages, zero `-clang` names —
  the T-ladder invariant holding live.
- Both T1/T2 dev logs state it explicitly ("No image bump, no deploy —
  master reviews and sequences the channel"). The `-clang` channel is the
  Part II serve-with-clang.js dev-server surface; base ships zero clang.

T3 executed the same: merged to main, overlay already published at sibling
main @1beacf2 (`out-image/overlay.json` carries /usr/bin/ninja-clang +
/usr/bin/tinyrenderer-clang + the Demos menu entries, verified). Image
version UNCHANGED (v138); no bake input touched (packages/tests/tools only).

## Live verification + invariants

- Live apex `/packages/index.json`: baseVersion 138, 12 packages, zero
  `-clang` — unchanged, as the precedent requires.
- `build-info.json` cCompiler e188893 imgSha ede90f52… (the OSK deploy) —
  the T3 merge changes no served byte, so no redeploy (same as T1/T2).
- Base purity on the merged tree: plain `node tools/mkpkg.js` → 12-package
  index, zero `-clang` names (matches the live index name-for-name).

## Filed

- **todos/0271 (P0)**: os-touch.mjs taskbar-menu leg red since osk-bigger —
  pre-existing on main, mechanism hypothesis + repro in the item.
