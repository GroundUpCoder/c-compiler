# Deploy — gucOS image v198

## Summary

The production site runs the gucOS image v198. The previous production image was
v197. This release is not a bundle. The bump to v198 was the only pending bump,
so v198 ships alone.

The deploy source is `92cb06de`
(`92cb06de45968d0f02b0911fd2c1dfe3e88598cf`). The command `git ls-remote origin
main` confirmed this SHA before the build. The file `os/image.json` at that SHA
reads `"version": 198`.

## Content

The release contains todos/0433. The item is closed. The item makes the NetSurf
file input gadget open a real file dialogue.

Before this change the gadget was inert. A click on it did nothing. Now a click
starts `/usr/bin/filepick`, a separate win32 program. The program uses
`comdlg32 GetOpenFileNameW`. It returns the selected paths on its standard
output. The paths are separated by a newline character.

The gucOS window table supplies the new entry `file_gadget_open`. The
implementation uses a pipe and `posix_spawn`. It reaps the child process with a
flag-then-park method under `SIGCHLD`. It applies the result only when the
content identity still matches. A destroy event or a `NEW_CONTENT` event kills a
live picker.

The design named the function `hlcache_handle_retain`. That function does not
exist. The lane reported this deviation and compensated for it. The compensation
is the `NEW_CONTENT` cancel plus a pointer identity check.

The acceptance of the item is split, and the split is deliberate. The gadget
VALUE is now reachable. The file BYTES are not readable yet. The item
`todos/0437` holds the bytes half. That item is hard-blocked on `todos/0417`.
This release must not be read as a complete file upload capability.

The changed files are `os/win32/filepick.c`, `os/win32/filepick.json`,
`vendor/netsurf/gucos/gui.c`, `vendor/netsurf/gucos/gui.h` and
`vendor/netsurf/gucos/main.c`, with two new test pages under
`vendor/netsurf/test/`. No file under `vendor/netsurf/netsurf/` changed. The
changed files bake `/usr/bin/netsurf` and the new `/usr/bin/filepick`. Those two
binaries are the reason for the bump from 197 to 198.

## The gate

The coordinator verified the gate from the artifacts, not from prose.

The kernel suite recorded 135 of 135 files. The summary holds exactly one run
entry. It reads `filter: null`, `executed 135` and `total 135`. The tally of
`results[].status` is 135 pass and 0 other. The elapsed time is 1 147 708 ms.

The coordinator derived the denominator instead of carrying it. On main before
the merge, `tests/kernel/run.js` registered 134 files and 135 files were on the
disk. On the branch it registered 135 files and 136 were on the disk. The single
unregistered file is `test_punes_e2e.js` on both sides. That file is
`todos/0396` and it is unrelated to this item. The transition is therefore 134
to 135, and a 134 pass would mean the new test did not run.

The browser suite recorded 42 of 42 files in one run entry, with `filter: null`
and 0 non-pass results. The lane declared an earlier run that failed. That run
reported 42 of 42 executed and 42 non-pass. The cause was the playwright pin
setup error, not a defect. The lane kept the failed record at
`summary.prev-1.json` and named it. This behaviour is correct and the
coordinator confirmed it against the file.

The lane also ran a flake gate on the new test only. It ran the test 3 times
under load 10. It wrote that record to `summary.flake-1.json`, a separate path.
The full sweep summary stayed clean.

The coordinator ran three suites again on the merged tree. The netsurf-patch
suite passed in 2.4 s. The todos suite passed in 11.8 s. The projects suite
passed in 255.5 s. These three suites write no summary of their own, so a second
run was the only available evidence.

The command `node tests/run.js --diff origin/main --dry-run` named five suites:
kernel, sweep, todos, projects and netsurf-patch. The lane ran all five. The
coordinator let the tool name the suites. It did not assert the routing.

The command `node vendor/netsurf/patchcheck.mjs` printed 68 file checks and 0
failures. This number is the same as main before the merge. The coordinator
predicted this result before the run. The prediction came from one derivation:
the command `git diff --name-only 9137da16 7ce7c61c` matched no path under
`vendor/netsurf/netsurf/`. No engine file changed, so the count could not move.

The merge was fast-forward. The command `git merge-base HEAD origin/main`
returned the tip of main, so no rebase was necessary and no `todos/queue.json`
conflict occurred. The board reads 135 open items and 299 done items.

## The stale denominator in the ticket

The `## Design` section of the ticket carried a wrong number. It said the new
test moves the kernel total from 133 to 134. That statement was two ticks stale.

The correction is in the commit `92cb06de`. Two lines were wrong, not one. Line
226 stated the transition. Line 227 stated the failure signal, as "a 133 pass
means the new test did not run". A correction of the transition alone would
leave a wrong failure signal one line below it, and that wrong line would look
self-consistent.

The earlier coordinator turn corrected the number in the kickoff and warned the
lane that older prose was stale. That action worked, and the lane used the
correct number in its own commit message. But the ticket is the document that
the kickoff calls authoritative, and the command `queue.js done` moved the
ticket into `todos/done/`. A wrong number there becomes a permanent record that
the next reader trusts. The lesson is recorded as (ER) in the coordinator notes:
a correction to the carrier does not correct the source, and the source outranks
the carrier.

The coordinator did not edit the ticket while the lane ran. The lane rebases its
own tree, so an edit on main would become a conflict inside the file that the
lane owns. The edit went into the merge instead. The todos suite passed after
the edit.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v198 92cb06de`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v198 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
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

The build wrote a sealed image of 24 250 728 bytes. The image reads v198. The
build baked `/usr/bin/filepick` at 553 527 bytes. That binary is new. It baked
`/usr/bin/netsurf` at 5 664 036 bytes. The previous binary measured 5 659 564
bytes at v196 and 5 660 935 bytes at v197, so the binary grew by 3101 bytes. The
image grew by 595 608 bytes. The new picker binary and the netsurf growth
account for that increase.

The build wrote 26 package payloads of 45.4 MiB, at `baseVersion 198`. The
directory `dist/` measures 98.9 MiB and is ROM-clean. The build recorded the
provenance `c-compiler 92cb06de, img b09017445aa5…`, with `dirty false` for both
repositories.

The build printed one `WARNING overlay clang-apps built from a DIRTY tree`. This
warning is a known false alarm. The provenance of the compiler ELF has been
dirty since 2026-07-14.

The command `pnpm verify` printed **PASS with 18 of 18 checks** on the first
run. The count of `ok` lines is 18. The count of `FAIL` lines is 0. The count of
lines that hold the word `skip` is 0. A skip counts as a failure, so this work
counted the lines directly. Check 8, `boots to ready`, passed on the first
attempt. The item `todos/0435` tracks a flake in that check, and the flake did
not appear here. This result is the second clean first run in sequence.

The command `node scripts/deploy.mjs --commit` uploaded 6 new files. 62 files
were already present. The upload took 7.97 s. Cloudflare Pages returned the
deployment `https://8df1a233.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `b176646b2b0e6c88198a298941c60162013c8e41`
(`deploy: c-compiler 92cb06de → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

This work derived the artifact set from `dist/_headers`. It did not use a typed
list. The file marks 21 patterns. Two patterns are wildcards, `/*` and
`/packages/pool/*`. The remaining 19 are concrete paths. This work checked all
19 and prints the count here so that a future shrink is visible. The set matches
the v197 set in size. An older note in the deploy chain named 16 artifacts; that
number is wrong and must not return.

The check fetched each artifact from `https://groundupcoder.com` and compared
the MD5 sum against the local file in `dist/`. The path `/os/os.html` returns a
308 redirect, so the check used `curl -sL`. All 19 local files resolved, so no
check was silently absent.

The check ran 4 poll rounds at 20 s spacing. Every round gave **19 of 19**. No
artifact was stale in any round. The v197 deploy and the v196 deploy each found
`/build-info.json` stale at round 1, so the 4 rounds remain necessary. A clean
round 1 is a result, not a reason to stop early. One round samples one point of
presence only.

The edge serves `image.json` with `"version": 198`. The edge serves
`build-info.json` with `c-compiler 92cb06de45968d0f02b0911fd2c1dfe3e88598cf`,
`dirty false` for both repositories, and `imgSha256
b09017445aa59ce322eb468bc86181884036077f422dfa5f2caec065969aa331`. The root path
`/kernel.js` returns 200. The path `/os/kernel.js` returns 404, and that result
is correct.

The check proved the payload, not the version number alone. This work downloaded
the image from the edge. The file measures 24 250 728 bytes. Its SHA-256 sum
equals the sum of the local image, so the two files are identical byte for byte.
The command `strings` found the text `filepick` 6 times inside that
edge-served image. The picker binary is therefore in the image that the edge
serves, and the proof does not depend on the version field.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must
do a hard reload.

The file dialogue is a value-only capability in this release. A user can select
a file and the page can read the name. The page cannot read the content of the
file. The item `todos/0437` holds that work, and `todos/0417` blocks it.

This work found no new gap, so it filed no new item in `todos/`. It changed no
anchored line, so `todos/LIABILITIES.md` needs no re-anchor. The work removed
the temporary worktree `/tmp/deploy-v198` after the check. It also removed the
lane worktree `~/worktree/c-compiler/0433-filepick`. The count of c-compiler
worktrees is 23.
