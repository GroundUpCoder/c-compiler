# Deploy — gucOS image v197

## Summary

The production site runs the gucOS image v197. The previous production image was
v196. This release is not a bundle. The bump to v197 was the only pending bump,
so v197 ships alone.

The deploy source is `9137da16`
(`9137da16e9bc4a3f22695d88b9980eec9dedc313`). The command `git ls-remote origin
main` confirmed this SHA before the build. The file `os/image.json` at that SHA
reads `"version": 197`.

## Content

The release contains todos/0434. The item is closed. The item keeps an open core
select menu alive across a live re-conversion of the document.

The fix is one decoupling. It is not a wider guard. The menu object holds no
pointer into the option list. The redraw and the hit test read the live list at
each use. The menu died with the list only because
`form_select_clear_options` destroyed the menu object. Now the death of the
CONTROL destroys the menu (`form_free_control`). The open menu stays alive
through the re-conversion window. A settle rule runs at each exit path of the
window.

The settle rule uses the DOM node as the identity of an option. The rule
dismisses the menu in three conditions. First, the gadget has no box on the
screen. Second, the option list is empty. Third, a current option existed, and
its node is absent from the rebuilt list. In all other conditions the rule
re-attaches the menu. It measures the geometry again, it updates the scrollbar
extents, and it keeps the scroll offset in pixels with a clamp.

The five edited files are `form.c`, `form_internal.h`, `private.h`,
`box_special.c` and `html.c` under
`vendor/netsurf/netsurf/content/handlers/html/`. These files are
upstream-derived. Their sections in `patches/netsurf.diff` were regenerated in
the same commit, `1bce5924`. These files bake `/usr/bin/netsurf`. That binary is
the reason for the bump from 196 to 197.

## The gate

The coordinator verified the gate from the artifacts, not from prose. The lane
rebased onto `c66d261e` and gated at `1bce5924`.

The kernel suite recorded 134 of 134 files. The summary holds exactly one run
entry. It reads `filter: null`, `executed 134`, `total 134`, `resumed 0`,
`carried 0` and `recorded 134`. The tally of `results[].status` is 134 pass and
0 other.

The browser suite recorded 42 of 42 files. The summary holds one run entry. It
reads `filter: null`. The tally is 42 pass and 0 other.

The projects suite passed 29 of 29. The netsurf-patch suite passed 2 of 2. The
todos suite passed 5 of 5. The coordinator ran netsurf-patch and todos again on
the branch and got the same numbers.

The command `node tests/run.js --diff origin/main --dry-run` named five suites:
kernel, sweep, todos, projects and netsurf-patch. The lane ran all five. The
coordinator let the tool name the suites. It did not assert the routing.

The command `node vendor/netsurf/patchcheck.mjs` on the branch printed 68 file
checks and 0 failures. This is the same number as main. All five edited files
already had sections in the diff, so the count of checks did not move.

The kernel suite ran in full two times, and the lane declared this. Run 1 gave
134 of 134 in 1344 s. The flake gate then wrote into the same summary file. The
lane moved that merged record aside and ran the suite again in full. Run 2 gave
134 of 134 in 1040 s. Both full runs passed. The flake gate ran the new test
three times under load 10 and passed each time.

Both sweeps started after the last code commit. The code commit is 06:44:05 KST.
The browser sweep started at 07:12:05 KST. The kernel sweep started at 07:30:43
KST.

The rebase delta between `3fe0cdec` and `c66d261e` holds five files. All five
are under `todos/` or `logs/`. The coordinator verified this before it accepted
the heavy numbers across the rebase. The rebase preserved the code content
exactly.

The merge was fast-forward. The board reads 136 open items and 298 done items.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v197 9137da16`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v197 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
   The variable `CLANG_SIMPLIFIED` is mandatory. The script `deploy.mjs` gates on
   the provenance that the build records. A symlink before the build makes that
   provenance dirty.
3. Make both symlinks in the deploy worktree after the build. Link
   `node_modules` and `tests/browser/node_modules` to the main tree.
4. Run `pnpm verify` in `~/git/comguc`.
5. Run `node scripts/deploy.mjs --commit` with the Cloudflare token.
6. Push the ledger commit.
7. Check the artifacts at the edge.

This work followed the order above.

## Results

The build wrote a sealed image of 23 655 120 bytes. The image reads v197. The
build baked `/usr/bin/netsurf` at 5 660 935 bytes. The previous binary measured
5 659 564 bytes, so the binary grew by 1371 bytes. The image grew by 1368 bytes.
This match is evidence that the new binary carries the fix. The build wrote 26
package payloads of 45.4 MiB, at `baseVersion 197`. The directory `dist/`
measures 97.7 MiB and is ROM-clean. The build recorded the provenance
`c-compiler 9137da16, img 8633f8874fd8…`, with `dirty false` for both
repositories.

The build printed one `WARNING overlay clang-apps built from a DIRTY tree`. This
warning is a known false alarm. The provenance of the compiler ELF has been
dirty since 2026-07-14.

The command `pnpm verify` printed **PASS with 18 of 18 checks** on the first
run. The count of `ok` lines is 18. The count of `FAIL` lines is 0. The count of
lines that hold the word `skip` is 0. A skip counts as a failure, so this work
counted the lines directly. Check 8, `boots to ready`, passed on the first
attempt. The v196 deploy needed two runs for that check. The item `todos/0435`
tracks that boot flake, and it did not appear here.

The command `node scripts/deploy.mjs --commit` uploaded 6 new files. 62 files
were already present. The upload took 7.97 s. Cloudflare Pages returned the
deployment `https://29e30fe6.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `5f69407528d7cb1203d6d7ed4bc1abcc9ed99a78`
(`deploy: c-compiler 9137da16 → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

This work derived the artifact set from `dist/_headers`. It did not use a typed
list. The file marks 21 patterns. Two patterns are wildcards. The remaining 19
are concrete paths. This work checked all 19. The v196 check used a set of 16,
so this set is larger by 3. The 3 additional paths are the hashed image blob,
the compatible image path and `packages/index.json`.

The check fetched each artifact from `https://groundupcoder.com` and compared
the MD5 sum against the local file in `dist/`. The path `/os/os.html` returns a
308 redirect, so the check used `curl -sL`.

The check ran 4 poll rounds at 20 s spacing. Round 1 gave **18 of 19**. The file
`/build-info.json` was stale at round 1. Rounds 2, 3 and 4 each gave **19 of
19**. The total is 4 rounds, 1 stale artifact at round 1, and 0 stale after
round 1.

This result confirms the rule from the v196 deploy. One round can sample one
point of presence only. A single probe is not sufficient evidence. Here the
single lagging file would have failed a one-round check.

The edge serves `image.json` with `"version": 197`. The edge serves
`build-info.json` with `c-compiler 9137da16e9bc4a3f22695d88b9980eec9dedc313`,
`dirty false` for both repositories, and `imgSha256
8633f8874fd8447361f035246552880138a84f5ba0969f4d29f3ef2246ac23bd`. The root path
`/kernel.js` returns 200. The path `/os/kernel.js` returns 404, and that result
is correct.

The check proved the payload, not the version number alone. The proof is a chain
of three links. First, the source at `9137da16` holds the menu decoupling in the
five html handler files. Second, the build recorded the provenance `c-compiler
9137da16`, and `os/image.json` bakes `/usr/bin/netsurf` from `vendor/netsurf/`.
The binary grew by the expected amount. Third, the sealed image at the edge
matches the local image byte for byte. The binary that carries the fix is
therefore in the image that the edge serves.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must
do a hard reload.

This work found no new gap, so it filed no new item in `todos/`. It changed no
anchored line, so `todos/LIABILITIES.md` needs no re-anchor. The work removed
the temporary worktree `/tmp/deploy-v197` after the check. The count of
c-compiler worktrees is 23.
