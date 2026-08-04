# Deploy — gucOS image v237

## Summary

The production site runs the gucOS image v237. The previous production image
was v231. The deploy source is `d0084120`
(`d0084120efaee399be4513c6b9198cc5d7775150`). The command
`git ls-remote origin main` confirmed this SHA before the build. The file
`os/image.json` at that SHA reads `"version": 237`.

## The ship baseline

The baseline is the last line of the ledger `deploys/log.jsonl` in
`~/git/comguc`. That line records the commit `7277568d` at
`2026-08-04T00:34:58.272Z`, which is 09:34:58 KST on 2026-08-04.

The live edge confirmed the same commit before the build. The file
`build-info.json` at `groundupcoder.com` named `7277568d`, and
`/os/image.json` read `231`. The ledger and the edge agreed.

**Use the host `groundupcoder.com` for this check.** The host
`gucos.groundupcoder.net` serves a `netguc` placeholder. A JSON parse of that
placeholder fails, and the failure looks like a dead edge.

## Why this shipped

Two triggers fired. Either one is sufficient.

**Trigger 1 — the count.** The batch contains 10 behaviour-changing tickets:
`#473`, `#474`, `#158`, `#485`, `#486`, `#484`, `#491`, `#493`, `#495` and
`#497`. The threshold of rule 6 is about eight.

The count uses the definition in rule 6. A ticket counts only if it changes the
behaviour of the shipped artifact. Three merged tickets do not count. `#421`
adds the repo tool `tools/os-drive-headless.mjs`, which never enters the image.
`#444` changes a test assertion. `#428` changes a gate rule. The documentation
commits do not count either.

**Trigger 2 — the immediate-ship exception.** `#491` is a P0 defect fix. Rule 6
makes the cadence a floor on batching. It is never a delay on urgent work.

The 24-hour leg did NOT fire. That leg was due at 09:34:58 KST on 2026-08-05,
about nine hours after this deploy.

## Content

The release contains 10 members.

`#491` stops a defective SDL audio pull-callback from killing the process. The
function `SDL_OpenAudioDeviceStream` now returns NULL and sets an error.
`#493` adds the input state snapshots `SDL_GetKeyboardState`,
`SDL_GetMouseState` and `SDL_GetModState`. `#495` adds
`SDL_GetPerformanceCounter`, `SDL_GetPerformanceFrequency` and
`SDL_GetTicksNS`, with a sub-millisecond clock. `#497` stops the SDL veneer
from reporting success for an invalid argument.

`#485` makes `SDL_PollEvent` pump the input ring, so a poll-only loop receives
input. `#484` clamps GPU presents at the producer and fixes a tab crash.
`#486` force-quits a process that ignores its close request. `#158` adds
horizontal scroll to `SysListView32`. `#473` adds libgit2 as a gucman srclib
package. `#474` promotes `vendor/fakegit` to `os/git` and ships git as a gucman
package.

## The gate

The full gate ran once, over the whole batch, at `14d621dd`. The command was
`node tests/run.js all`. The elapsed time was 3167.6 s.

**The gate did not run again for this deploy, and it did not need to.** The
tree of `14d621dd` and the tree of the shipped commit `d0084120` are the same
object. Both are `b0e2f72245f63d100d081f0c7c234408f46e7a66`. The merge commit
`d0084120` added no content, because `main` did not move after the branch
point. Therefore the green covers the shipped bytes exactly. A second run of a
3167 s gate over identical content would add no evidence.

**Verify tree identity by the tree hash, not by the commit list.** The command
`git rev-parse <gated>^{tree} <shipped>^{tree}` prints two equal hashes. A
claim that one commit "contains" another is weaker, because a merge can add
content.

The artifacts confirm the result. The run-level record
`build/test-run/summary.json` reads `filter: null` and lists all 25 suites.
All 7 result groups read `status: "pass"`. Every group reads `resumed: 0` and
`carried: 0`, so no result came from an earlier tree.

The per-suite artifacts confirm whole membership. The kernel suite recorded 157
of 157 files with `done: true`, `filter: null` and zero non-pass. The browser
sweep recorded 51 of 51 on the same terms. The BlockFS suite recorded 15 of 15.
Each of the three reads `evidence.fresh` equal to its total.

The sweep reads `pass`, not `skip`. The suite `sweep` is optional, so an absent
Playwright degrades it to a skip. A ship must never read a skip as a green.

The command `node todos/liabilities.js check` exited 0 before the deploy and
after it. It reported 49 entries.

The artifacts are preserved at `/tmp/sdl-accepted/`.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git -C ~/git/c-compiler worktree add --detach /tmp/deploy-v237 d0084120`.
2. Build against that worktree:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v237 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
3. Run `pnpm verify` against the built `dist/`. Keep the variable `C_COMPILER`
   unset, so the verify script finds Playwright in the main tree.
4. Run `node scripts/deploy.mjs --commit`. The Cloudflare token came from the
   file `~/.guc/creds/cloudflare-api-token` through the shell environment.
5. Push the ledger commit.
6. Check the artifacts at the edge.

This work followed the order above.

## Results

The build wrote 82 package payloads of 76.5 MiB at `baseVersion 237`. The
directory `dist/` measures 114.1 MiB and is ROM-clean. The image SHA-256 starts
`569ebecd004e`. The build removed 3 ROM entries.

The verify script passed all 19 checks with 0 skips. The checks include an
in-OS C compile, a `gucman install quake` from the deployed repository, a
`gucman install box2d-clang`, and the absence of Nintendo ROMs.

The deploy uploaded 58 files of 124. The Cloudflare deployment URL is
`https://d891aa28.comguc.pages.dev`. The ledger commit is `0cefb5f`.

The edge serves `build-info.json` with `d0084120` and `dirty false` for both
repositories. The edge serves `/os/image.json` with `"version": 237` and
`/packages/index.json` with `baseVersion 237`.

## The fix reaches clients — the check that matters

The SDL veneer is not a package and not a separate source file. The header
prototypes and the C implementations are embedded text inside `compiler.js`.
The JS host runtime is `host.js`. **There is no `__SDL.c` and no
`os/include/SDL.h`.** A ticket that names `__SDL.c` is wrong.

Therefore the image version alone does not prove that the SDL work propagates.
The served `compiler.js` must also change. Cloudflare applies a 4-hour TTL to
`.js`, which can override the `_headers` file, so a stale copy is a real risk.

Two measurements closed this.

First, the served JS matches the shipped tree byte for byte. The SHA-256 of the
fetched `compiler.js`, `host.js` and `kernel.js` equals the SHA-256 of the same
path at `d0084120`.

Second, the new symbols are present at the edge and absent at the previous
ship. The served `compiler.js` contains `SDL_GetKeyboardState` 3 times and
`SDL_GetPerformanceCounter` 3 times. The file `compiler.js` at `7277568d`
contains each symbol 0 times. The symbol `SDL_GetTicksNS` moved from 2
occurrences to 5, which agrees with the rework in `#495`.

The second measurement carries a negative control. A count that is high at the
edge proves nothing on its own, because the symbol could be old. The count of 0
at the previous ship is what makes the result decisive.

## Notes

The lane that wrote this batch ran on Fable. Therefore the batch owes no
independent Opus review.

This work removed the temporary worktree `/tmp/deploy-v237` and ran
`git worktree prune`.
