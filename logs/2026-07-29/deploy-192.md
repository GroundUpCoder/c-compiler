# Deploy — gucOS image v192

## Summary

The production site runs the gucOS image v192. The previous production image was
v191. This release is not a bundle. The bump to v192 was the only pending bump,
so v192 ships alone.

The deploy source is `8e34f2f0` (`8e34f2f057efa8220e8895c01d3e44abfc8293ab`).
The command `git ls-remote origin main` confirmed this SHA before the build. The
file `os/image.json` at that SHA reads `"version": 192`.

## Content

The release contains todos/0410. The item is closed. The item fixes a NetSurf
defect: an `img` disappeared for good after a mutation-triggered live
re-conversion. The verdict is FIXABLE and port-local.

The lane instrumented the path first. The instrument proved that every link the
ticket suspected is intact. The code issues the refetch. The hlcache reuses the
`DONE` content. The callback fires with LOADING, READY and DONE. The code
re-binds the box.

The failing link is the next one. Nothing lays the document out again. The
READY-gated reformat for all arrived objects is skipped on a `DONE` document. A
`reformat_time` value throttles the `incremental_reflow` branch. The reformat of
the swap had pushed that time 250 ms out. The code tests the value once and
never retries. Therefore a box that needs the intrinsic size of the object keeps
zero height for ever.

The flag `REPLACE_DIM` is the reason this defect looked mysterious. The code
sets that flag only when the tag carries both a `width` attribute and a `height`
attribute. A width-only `img` is therefore the discriminating shape.

The fix adds the DONE-status twin of the READY completion branch. The new branch
reformats the document and requests a full redraw when the last outstanding
object lands after the load. The branch skips a completion inside the
re-conversion window, because the reformat of the swap covers that case.

The diff touches `vendor/netsurf/`. The changed files are `object.c`, `html.c`,
`hlcache.c` and `netsurf.diff`. These files bake `/usr/bin/netsurf`. That binary
is the reason for the bump from 191 to 192.

The branch also carries the kernel e2e leg
`tests/kernel/test_netsurf_img_reconvert_e2e.js`, its registration in `run.js`,
the close-out of the ticket, and a dev log. None of these items changes a
runtime path.

## The gate

The test gate was already green at `8e34f2f0`. This work did not repeat the
sweeps. The coordinator verified the gate from the artifacts, not from prose.

The kernel suite recorded 129 of 129 files. It selected 129 files and executed
129 files. It resumed 0 files and carried 0 files. The tally of
`results[].status` is 129 pass and 0 other. The summary reads `done: true` and
`filter: null`. The artifact is a single run, not a merge.

The browser suite recorded 41 of 41 files. It selected 41 files and executed 41
files. It resumed 0 files and carried 0 files. The tally is 41 pass and 0 other.
The summary reads `done: true` and `filter: null`. This artifact is also a
single run.

Both sweeps started after the last code commit. The last code commit is
`f482ddb1` at 01:32:46Z. The kernel sweep started at 01:33:13Z. The browser
sweep started at 01:51:21Z. The final commit `8e34f2f0` holds todos and logs
only, so it owes no bump.

The todos suite passed 5 of 5 in 11.6 s. The command `node todos/queue.js check`
passed with 123 items, 285 done items and 45 liability entries. Both commands
ran after the close-out commit.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v192 8e34f2f0`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v192 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
   The variable `CLANG_SIMPLIFIED` is mandatory. The script `deploy.mjs` gates on
   the provenance that the build records. A symlink before the build makes that
   provenance dirty.
3. Make both symlinks after the build. Link `node_modules` and
   `tests/browser/node_modules` to the main tree.
4. Run `pnpm verify`.
5. Run `node scripts/deploy.mjs --commit` with the Cloudflare token.
6. Push the ledger commit.
7. Check the artifacts at the edge.

This work followed the order above.

## Results

The build wrote a sealed image of 23 625 496 bytes. The image measures 22.5 MiB
and reads v192. The build wrote 26 package payloads of 45.4 MiB, at
`baseVersion 192`. The directory `dist/` measures 97.7 MiB and is ROM-clean. The
build recorded the provenance `c-compiler 8e34f2f0, img 762d09ef6825…`.

The build printed one `WARNING overlay clang-apps built from a DIRTY tree`. This
warning is a known false alarm. The provenance of the compiler ELF has been
dirty since 2026-07-14, and v178 shipped with the same flag.

The command `pnpm verify` printed **PASS with 18 of 18 checks**. It printed no
skip and no failure. A skip counts as a failure, so this work counted the `ok`
lines directly. The count of `ok` lines is 18. The count of lines that hold the
word `skip` is 0.

The command `node scripts/deploy.mjs --commit` uploaded 6 new files. 62 files
were already present. The upload took 8.27 s. Cloudflare Pages returned the
deployment `https://be8c8000.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `d27b5be67dd2fae5faeec38097cbaca077291cb9`
(`deploy: c-compiler 8e34f2f0 → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

The 16 artifacts are the set that `dist/_headers` marks `must-revalidate`. The
file marks 18 patterns. Remove `os-system.img` and `packages/index.json`, and 16
remain. This set holds the 14 runtime assets, plus `/os/image.json` and
`/build-info.json`. The check fetches each artifact from
`https://groundupcoder.com` and compares the MD5 sum against the local file in
`dist/`. The path `/os/os.html` returns a 308 redirect, so the check uses
`curl -sL`.

The propagation was fast. Round 1 gave **16 of 16**. One round can sample one
point of presence only, so this work ran 3 more rounds. Each round gave 16 of
16. The total is **4 poll rounds, all 16 of 16, 0 stale**. The history shows a
slower result. The v190 deploy gave 13 of 16 at round 1, and an earlier deploy
needed 8 rounds. A single probe is therefore not sufficient evidence, even when
round 1 is complete.

The check also compared the 2 artifacts that the canonical set excludes. The
hashed blob `/os/os-system.762d09ef6825303b.img`, the compatible path
`/os/os-system.img` and the file `/packages/index.json` all match the local MD5
sum.

The edge serves `image.json` with `"version": 192`. The edge serves
`build-info.json` with `c-compiler 8e34f2f057efa8220e8895c01d3e44abfc8293ab`,
`dirty false`, and `imgSha256 762d09ef6825303b…`. The root path `/kernel.js`
returns 200.

The check proved the payload, not the version number alone. The proof is a chain
of three links. First, the source at `8e34f2f0` holds the new DONE-status branch
in `object.c`, and the temporary `NS0410` instrumentation is absent. The file
`netsurf.diff` carries the same change. Second, the build recorded the
provenance `c-compiler 8e34f2f0`, and `os/image.json` bakes `/usr/bin/netsurf`
from `vendor/netsurf/`. Third, the sealed image at the edge matches the local
image byte for byte. The binary that carries the fix is therefore in the image
that the edge serves.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

The deployed kernel is at the root path `/kernel.js`. The path `/os/kernel.js`
returns 404. An error from the instrument is not an error in the target.

The file `build-info.json` records the comguc commit `89159c1`. That commit is
the ledger of the previous deploy. The build stamps this file, and the build
runs before the ledger commit. Two different ledger SHAs are therefore correct.
The comguc commit `d27b5be` is the ledger of this deploy.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must
do a hard reload.

This work found no new gap, so it filed no new item in `todos/`. It changed no
anchored line, so `todos/LIABILITIES.md` needs no re-anchor. The work removed
the temporary worktree `/tmp/deploy-v192` after the check. The count of
c-compiler worktrees returned to 15.
