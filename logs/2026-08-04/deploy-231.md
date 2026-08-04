# Deploy — gucOS image v231

## Summary

The production site runs the gucOS image v231. The previous production image
was v225, not v224. The deploy source is `7277568d`
(`7277568d552f3916a07752704363503833a40410`). The command
`git ls-remote origin main` confirmed this SHA before the build. The file
`os/image.json` at that SHA reads `"version": 231`.

## The ship baseline was wrong, and this log corrects it

The coordinator inherited two figures. Both were incorrect.

The handoff said the last ship was v224 at 11:42:54 KST on 2026-08-03. The
ledger `deploys/log.jsonl` in `~/git/comguc` records a later deploy. The
commit `a3143d5` shipped `ea87469b` at `2026-08-03T04:09:51.668Z`, which is
13:09:51 KST. That deploy carried image v225.

The live edge confirmed this before the build. The file `build-info.json` at
`groundupcoder.com` named `ea87469b`, and `/os/image.json` read `225`.

The earlier reader stopped at the v224 ledger entry `ef3f671` (11:39:31 KST)
and did not see the v225 entry 90 minutes later. **Read the last line of the
ledger, and confirm it against the live edge. Do not read the last deploy log
file.**

The correction changes the batch. The member `#439` shipped in v225. It is
not an unshipped member. The unshipped members are v226 `#277`+`#278`, v227
`#451`, v228 `#462`, v229 `#463`, v230 `#456` and v231 `#368`. The count is
six against the threshold of about eight.

## Why this shipped before either cadence leg fired

Neither leg of the `#446` cadence had fired. The count was 6 of ~8. The 24-hour
leg was due at 13:09:51 KST, about four hours later.

Exception 4 of `#446` applies. It ships a fix for a live regression as soon as
its own gate is green. The shipped image v225 still contained the defect. The
command `git show ea87469b:vendor/netsurf/gucos/httpfetch.c` shows `*nl = 0;`
at line 321. The defect entered at `#359` in image v213 on 2026-08-01.
Therefore gucOS served zero response headers in production for three days.

## Content

The release contains six members. `#277`+`#278` add WS_THICKFRAME and WM_SIZE
relayout to ctldemo and gdidemo. `#451` adds in-OS ticket filing through a host
ticket bridge. `#462` pairs gcode's tool_result on message shape. `#463` adds
e2e legs for the repair pass. `#456` makes an unparseable gucman index name its
own fault. `#368` restores the NetSurf header blob.

`#368` is the reason for this ship. The gucOS HTTP fetcher terminated the
synthetic `x-guc-final-url:` line in place. The kernel prepends that line, so
the write severed the blob from every real header, and the emit loop sent zero
`FETCH_HEADER` messages. NetSurf therefore never received `Content-Type` and
fell back to Windows-1252. The visible symptom was mojibake. The larger damage
was that `llcache` never received `cache-control`, `etag` or `last-modified`,
so conditional requests and cache lifetimes were dead.

## The gate

The full gate ran once, over the whole batch, in the main tree at `7277568d`.
The command was `node tests/run.js all`. It recorded 8 suite groups and 26
suites. All passed. The elapsed time was 3048.9 s.

The artifacts confirm the result. The kernel suite recorded 155 of 155 files
with `done: true`, `filter: null` and zero non-pass. The browser sweep recorded
50 of 50 on the same terms. The BlockFS suite recorded 15 of 15. The command
`node todos/liabilities.js check` exited 0 and reported 48 entries.

An earlier kernel run for `#368` died at 92 of 155 when its lane turn ended.
That run was resumed, not restarted. **A harness-tracked task does not outlive
the turn that created it.** The full gate above then re-ran every file from
zero, so the ship does not depend on the resumed run.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git -C ~/git/c-compiler worktree add --detach /tmp/deploy-v231 7277568d`.
2. Build against that worktree:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v231 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
3. Run `pnpm verify` against the built `dist/`. The variable `C_COMPILER` stayed
   unset, so the verify script found Playwright in the main tree.
4. Run `node scripts/deploy.mjs --commit`. The Cloudflare token came from the
   file `~/.guc/creds/cloudflare-api-token` through the shell environment.
5. Push the ledger commit.
6. Check the artifacts at the edge.

This work followed the order above.

## Results

The build wrote 79 package payloads of 72.5 MiB at `baseVersion 231`. The
directory `dist/` measures 110.0 MiB and is ROM-clean. The image SHA-256 starts
`d58a7e18eb15`. The build removed 3 ROM entries. The verify script passed all
19 checks, which include an in-OS C compile, a `gucman install quake` from the
deployed repository, and the absence of Nintendo ROMs.

The deploy uploaded 43 files of 121. The Cloudflare deployment URL is
`https://c5f3c1ae.comguc.pages.dev`. The ledger commit is `9941f19`.

The edge serves `build-info.json` with `7277568d` and `dirty false` for both
repositories. The edge serves `/os/image.json` with `"version": 231`.

## The fix reaches clients — the check that matters

NetSurf left the baked image at `#417`/`#418`. It ships as a gucman package.
Therefore the image version alone does not prove the fix propagates. The
package payload must also change.

The edge index and the local `dist/` index agree. Both read `baseVersion 231`,
and both give NetSurf `minBase 231` with the payload
`pool/netsurf_3.12_5c8beb919cd1b2d7.pkg.tar.gz`.

The previous deploy differed. The index at `https://a1cafc8e.comguc.pages.dev`
reads `baseVersion 225` and gives NetSurf the payload
`pool/netsurf_3.12_181c63e5a9215de7.pkg.tar.gz`. The two hashes differ, so the
NetSurf binary genuinely changed.

The payload is served. A fetch returned HTTP 200 and 1 432 424 bytes, and the
SHA-256 of the downloaded file matches the index entry.

## Notes

The independent review of `#368` was Codex on the range `368e1421..7277568d`.
It returned GREEN with no must-fix item. It traced the redirect callback to its
callees and confirmed that `llcache_fetch_redirect()` copies the target into an
owned `nsurl` and does not retain the header blob pointer.

The review raised one nit. The positive UTF-8 title assertion at
`tests/kernel/test_netsurf_http_e2e.js:436` is not independently load-bearing,
because console echo can satisfy it. This work filed that as ticket `#472`
(P3, light). The suite still catches the defect through the gated `got-utf8`
marker and the negative mojibake assertion.

This work removed the temporary worktree `/tmp/deploy-v231` and ran
`git worktree prune`.
