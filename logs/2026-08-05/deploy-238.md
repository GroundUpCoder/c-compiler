# Deploy — gucOS image v238

## Summary

The production site runs the gucOS image v238. The previous production image
was v237. The deploy source is `87f3896d`
(`87f3896d4e7271dc5bd17619a6e25c3cc68af6e9`). That commit is the version bump
on top of the batch head `5c561978`. The bump landed before the gate, so the
gated tree and the shipped tree are the same commit.

## The ship baseline

The baseline is the last line of the ledger `deploys/log.jsonl` in
`~/git/comguc`. That line recorded the commit `d0084120` with the image
SHA-256 prefix `569ebecd004e` at 119670106 dist bytes.

The live edge confirmed the same commit before the work started. The file
`build-info.json` at `groundupcoder.com` named `d0084120` with `dirty: false`.
The file `/os/image.json` read `"version": 237` with no `defaultPackages`
key. The absent key was the positive control that the edge was behind `main`.
The ledger and the edge agreed.

**Use the host `groundupcoder.com` for this check.** The host
`gucos.groundupcoder.net` serves a `netguc` placeholder. A JSON parse of that
placeholder fails, and the failure looks like a dead edge.

## Why this shipped

The count trigger fired. The batch contains 8 behaviour-changing tickets:
`#503`, `#509`, `#510`, `#435`, `#515`, `#419`, `#423` and `#420`. The
threshold of rule 6 is about eight.

The count uses the definition in rule 6. A ticket counts only if it changes
the behaviour of the shipped artifact. Three merged changes do not count.
`ticket-424` adds `--vsync` to `os/boot.js`, which is the headless harness
and never enters the browser image. `#513` and `#110` change only test files.

The 24-hour leg was due at 00:16 KST on 2026-08-06, a few hours after this
deploy. Either leg alone made a ship due on this date.

## Content

The release contains 8 members.

The headline is `#420`: doom is no longer baked into the image. Doom is the
first member of the `defaultPackages` mechanism from `#419`. A fresh
networked boot installs doom through `sync-defaults`. The doom shareware WAD
leaves the user seeds and travels in the package payload. On a virgin boot,
doom no longer gets a Desktop icon. The Games menu entry still plants, and
the icon is recoverable through the ctx-menu "Add Default Icons".

`#419` adds the default-package mechanism itself, with tombstone-durable
removal. `#503` bounds the gcode bash-tool wall time. `#509` and `#510` make
the gcode ^C message honest on both paths and kill a chatty survivor child.
`#435` bakes Noto Sans Symbols 2 and `#515` bakes Noto Sans Symbols (1), so
all six Mac modifier glyphs render on a bare image. `#423` adds the WMP
screen-path keyboard verb `INJECT_WMKEY` and `wmctl skey`.

## The gate

The full gate ran over the shipped commit `87f3896d`. The command was
`node tests/run.js all` with no filter and no resume. The elapsed time was
3008.7 s. The exit code was 0.

**The gate ran twice, because the first attempt died without a verdict.**
The executor caps one tool call at 600 s and moves a longer call to a
harness-tracked task. That task is attached to the lane's per-turn process.
The first attempt ended its turn to wait for a completion notification, and
the turn's end killed the gate mid-run, inside the `cairo` suite, with no
run-level artifact. The second attempt held the turn open with blocking
task-output waits until the run completed. **A ship-gate lane must hold its
turn open for the whole gate.** The notification path does not keep the
process alive.

Before the second attempt, this work moved the Aug-4 artifact directories
`build/test-run`, `build/test-kernel` and `build/test-browser` to
`/tmp/pre-v238-artifacts-aug4`. After the run, every artifact on disk
post-dates the run's start stamp (1785917756). No stale result could be
mistaken for evidence.

The artifacts confirm the result. The run-level record
`build/test-run/summary.json` post-dates the start stamp, reads
`filter: null`, and lists all 26 suites. Every result reads
`status: "pass"`. Every file-recording suite reads `resumed: 0` and
`carried: 0`.

The per-suite artifacts confirm whole membership. The kernel suite recorded
167 of 167 files with `done: true`, `filter: null`, zero non-pass and
`evidence.fresh: 167`. The browser sweep recorded 51 of 51 on the same
terms. The BlockFS suite recorded 15 of 15.

The sweep reads `pass`, not `skip`. An exact-token failure grep
(`FAIL RED|FAILED|^not ok`) over the full log found 0 matches, with 348
`ok` lines as the positive control.

The command `node todos/liabilities.js check` exited 0 before the deploy and
after it. It reported 49 entries.

## The verify failure, and why it was not a product red

The first `pnpm verify` run failed at the `ls -1 /` needle after a 60 s
timeout. A probe against the built `dist/` captured the raw tty output and
proved the mechanism. A fresh networked boot now eager-installs doom, so
`/opt` exists at probe time. The entry `opt` sorts between `etc` and `proc`,
so the contiguous needle `bin\ndev\netc\nproc\nroot` can never match on a
`#420` image. The product behaved as designed. The verify script was stale.

A second stale check sat behind the first: the script asserted the WAD at
`/root/doom1.wad`, and `#420` moved the WAD into the package payload at
`/opt/doom/doom1.wad`.

The fix landed in `comguc` as `2e8ff20`. The script now waits for the line
`gucman: installed doom` before any probe. That wait is also the end-to-end
check of the `defaultPackages` mechanism against the deployed `/packages`
repo, and it makes `/opt` deterministic for the ls needle. The WAD and the
launcher are asserted at their package locations. The second verify run
passed all 21 checks with 0 skips. The checks include the doom
auto-install, an in-OS C compile, a `gucman install quake`, a
`gucman install box2d-clang`, and the absence of Nintendo ROMs.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git -C ~/git/c-compiler worktree add --detach /tmp/deploy-v238 87f3896d`.
2. Build against that worktree:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v238 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
3. Run `pnpm verify` against the built `dist/`. Keep the variable
   `C_COMPILER` unset, so the verify script finds Playwright in the main
   tree.
4. Run `node scripts/deploy.mjs --commit`. The Cloudflare token came from
   the file `~/.guc/creds/cloudflare-api-token` through the shell
   environment.
5. Push the ledger commit.
6. Check the artifacts at the edge.

This work followed the order above, with one insertion: the verify fix
`2e8ff20` landed between steps 3 and 4.

## Results

The build wrote 83 package payloads of 78.4 MiB at `baseVersion 238`. Doom
is the 83rd package. The directory `dist/` measures 116.8 MiB and is
ROM-clean. The image SHA-256 starts `ce9b4078f5ad`. The build removed 3 ROM
entries.

The deploy uploaded 42 files of 125. The Cloudflare deployment URL is
`https://568cb138.comguc.pages.dev`. The ledger commit is `9b70d05`.

The edge serves `build-info.json` with `87f3896d` and `dirty: false` for
both repositories. The edge serves `/os/image.json` with `"version": 238`
and `"defaultPackages": ["doom"]`. The edge serves `/packages/index.json`
with `baseVersion 238` and 83 packages, doom included. The doom payload
`pool/doom_1.9_a3897af78e763ae7.pkg.tar.gz` serves 1984194 bytes at
status 200.

The bare `/packages/index.json` URL served the stale v237 copy for roughly
30 seconds after the deploy, with `cf-cache-status: DYNAMIC`. A
cache-busted fetch served v238 at once, and the bare URL settled on v238
within three polls. This was propagation delay, not a cache pin.

## The image delta — a corrected prediction

The kickoff predicted a blob shrink of roughly 470 KB from doom's exit. The
measurement refutes the prediction. The v237 blob measures 15861520 bytes
(fetched from the prior deployment URL; its SHA-256 prefix `569ebecd004e`
matches the ledger). The v238 blob measures 16255272 bytes. The blob GREW by
393752 bytes, because the two font bakes (`#435` Noto Sans Symbols 2 and
`#515` Noto Sans Symbols (1)) outweigh doom's exit. The dist total grew
2.78 MB, mostly the new 1.98 MB doom package payload. The prediction
counted doom's exit and ignored the fonts in the same batch.

## Notes

The lanes that wrote this batch ran on Fable. The batch owes no independent
Opus review.

This work removed the temporary worktree `/tmp/deploy-v238` and ran
`git worktree prune`.

The flake tripwire `node tests/flake.js` ran after the deploy, per the
standing rule for a batch that lands a new e2e (`#420`'s
`test_gucman_doom_e2e.js` and the `os-doom.mjs` edit). Its verdict is
recorded in the ship report, not here, because the run finished after this
log's commit.
