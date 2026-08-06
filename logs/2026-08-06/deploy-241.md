# Deploy — gucOS image v241

## Summary

The production site runs the gucOS image v241. The previous production image
was v238. The deploy source is `9708d889`
(`9708d889a44b6a7bfaa6948f2dd9853294725790`), the batch-k merge and the exact
tip of `origin/main`. No ship commit was added: the gated tree, the shipped
tree, and `origin/main` are one commit.

## The ship baseline

The baseline is the last line of the ledger `deploys/log.jsonl` in
`~/git/comguc`. That line recorded the commit `87f3896d` with the image
SHA-256 prefix `ce9b4078f5ad` at 122453287 dist bytes, deployed
2026-08-05T09:14:50Z.

The live edge confirmed the same commit before the work started.
`build-info.json` at `groundupcoder.com` named `87f3896d` with
`dirty: false` and the same image SHA. `/os/image.json` read
`"version": 238`. The ledger and the edge agreed. The negative control
`/os/build-info.json` returned 404 (that file lives at the root).

## Why this shipped

The count trigger fired, and it fired well past the threshold. The batch
spans 11 merges (batch-a through batch-k), 60 commits, and roughly 40
tickets. Twenty tickets change the behaviour of the shipped artifact:

`#506` and `#507` (gcode search tools and progress heartbeat), `#111`
(search.h), `#112` (random()), `#114` (memory streams), `#115` (wide
scanf), `#116` (strftime %s), `#113` (strptime + strftime tail), `#121`
(empty translation unit), `#126` (`__extension__`) — all libc/compiler
surface that a developer inside gucOS observes through `/bin/cc`; `#501`
(wmctl numeric-operand validation), `#146` (nanosleep(0) floor), `#489`
(hung-app grace), `#542` (P0: O_RDONLY seeding — bundled HTML assets were
written as 0 bytes), `#394` (minesweeper sample names its fetch failure),
`#177` (NetSurf routes uncaught JS exceptions to the console), `#176`
(NetSurf deliberate image-cache sizing), `#365` (welcome.html capability
claims — shipped page content), `#173` (wmctl shot crop rect), `#9`
(comdlg32/winmm honesty pass).

The excluded set, with reasons: `#458` (declined; no change), `#119`
(comment-only — the `DG_SleepMs` block in `vendor/doom/src/main.c`; the
code is unchanged), `#99` (behaviour-preserving fold of wm.c's
`load_entries` onto listdir.h), `#309` (comment fixes), `#438` and `#175`
(findings/audit only), `#142` (cross-tree guard on repo tools — dev
tooling), `#101` (boot.js single-instance lockfile — the headless twin,
never in the browser image), `#546` (serve.js identity handshake + sweep
port uniqueness — dev server and harness), `#40`, `#480`, `#543` (test
members/legs), `#460` (test temp-dir cleanup), `#535` (test unit
derivation), `#456` (test red-log preservation), `#466` (build-artifact
freshness tooling), `#539` (build-time probe for the clang sibling),
`#481` (dead `features.h` removal), `#184` (host.js CLI wall-clock
ceiling — CLI mode only).

The kickoff for this lane suspected the predecessor lineage carried a
counter of 6 measured in merge commits. The suspicion was correct in
effect: the honest per-ticket count is ~20, so the count leg fired well
before this ship. The 24-hour leg was due at ~18:10 KST on 2026-08-06;
the count leg alone made the ship due earlier.

## The version decision

`os/image.json` on main reads 241; the edge served 238. Versions 239 and
240 were baked-input bumps inside batches and never shipped. This ship
uses option (A): ship 241 as-is, no bump commit.

Rationale, from the consumers: `os-common.js` gates re-bake on
`bakedVersion < manifest.version`, and the browser OPFS image re-fetches
on a version bump. Both comparisons are numeric order, not succession —
241 > 238 invalidates every v238 cache. A 242 bump would name no new
baked content, and it would add a commit to main that this lane does not
own. Skipped shipped versions are harmless; a hand-invented one is noise.

## The gate

The full gate ran over the shipped commit `9708d889` in a clean detached
worktree (`~/worktree/c-compiler/ship-v241`) with all four node_modules
symlinks verified through the link (2/2/1/2 entries) and the
`clang-simplified` sibling symlink present, so `os-clang.mjs` really ran.
The command was `node tests/run.js all` with no filter and no resume.
GATE-START Thu Aug 6 16:30:04 KST 2026; GATE-EXIT rc=0; elapsed 3490.8 s.

The run-level artifact `build/test-run/summary.json` post-dates the start,
reads `filter: null`, lists all 26 suites, and every `results[]` entry
reads `status: "pass"` — including `sweep` as a literal pass, not a skip:

    todos pass · netsurf-patch pass · unit pass · host pass · blockfs pass
    py[19 categories] pass · kernel pass · sweep pass · non-pass: []

The per-suite artifacts confirm whole membership. The kernel suite:
`done: true`, `filter: null`, 168 of 168 recorded, `resumed: 0`,
`carried: 0`, zero non-pass. The browser sweep: same terms, 54 of 54.
`os-clang.mjs` passed in 212.8 s with zero matches for its skip banner
and the closing line `os clang overlay (browser): PASS`.

The log's two `FAIL t2.js` rows resolve into the
`$TMPDIR/cc-suite-record-*` fixture directory — the suite-runner's own
self-test, not gate state. An exact-token failure grep
(`FAIL RED|FAILED|^not ok`) over the full log found 0 matches, with 366
`^ok` lines as the positive control. The gate log is preserved at
`~/git/c-compiler/build/ship-v241-gate.log`.

`node todos/liabilities.js check` exited 0 on the shipped tree: 38
entries, 2 pinned, 31 funding tickets.

## Procedure

1. Worktree: `git worktree add --detach ~/worktree/c-compiler/ship-v241 9708d889`;
   `git status --porcelain` empty.
2. Gate as above, held open in one turn until GATE-EXIT.
3. Build: `C_COMPILER=~/worktree/c-compiler/ship-v241 CLANG_SIMPLIFIED=~/git/clang-simplified pnpm build`
   in `~/git/comguc`.
4. `pnpm verify` — PASS, all checks, 0 skips (doom auto-install, in-OS C
   compile, `gucman install quake`, `gucman install box2d-clang`, ROM
   absence).
5. `pnpm run deploy` (the plain `pnpm deploy` form hits pnpm's builtin and
   fails — the kickoff's spelling was wrong). Token from
   `~/.guc/creds/cloudflare-api-token` through the shell environment.
6. Ledger committed and pushed in comguc (`6d04fa1`).

One re-build was needed: the first build flagged the tree dirty because
the gate log sat untracked in the worktree. The log moved out, and the
second build read `c-compiler 9708d889` clean. Only the clean build was
deployed (the edge's `dirty: false` is the proof).

## Results

The build wrote 83 package payloads of 78.5 MiB at `baseVersion 241`.
`dist/` measures 117.0 MiB, ROM-clean, 3 ROM entries removed. The image
SHA-256 starts `bb6b26e1526e`.

The deploy uploaded 66 files of 125. The Cloudflare deployment URL is
`https://e96e01c8.comguc.pages.dev`.

The edge serves `build-info.json` with `9708d889`, `dirty: false` for both
repositories, and the new image SHA. `/os/image.json` serves
`"version": 241`. `/packages/index.json` serves `baseVersion 241` with 83
packages. The image blob answers HEAD 200 at its hashed URL. The apex
flapped between 238 and 241 for roughly two minutes after the deploy with
`cf-cache-status: DYNAMIC` (propagation, not a cache pin — the same class
the v238 log recorded); it settled on 241 across six consecutive polls.

The image delta: the sealed blob grew from 16255272 to 16301960 bytes
(+46688). The dist total grew from 122453287 to 122650616 ledger bytes
(+197329).

## Notes

- The build pruned one orphan pool payload, `wc-rust_1.0.0_…`. The live
  index never named wc-rust, so nothing shipped was removed. The
  definition `packages/wc-rust.json` exists on main with
  `requires: "native-sibling:rust"`, and the comguc build has no `--rust`
  leg, so the package has never shipped. That is a scope question for the
  coordinator, not a regression.
- The lanes that wrote these batches ran on Fable. The batch owes no
  independent Opus review.
- The worktree was removed and pruned after this log's figures were
  extracted; `blocks-noblock` and the `clang-simplified` symlink remain.
