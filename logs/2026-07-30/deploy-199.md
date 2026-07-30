# Deploy — gucOS image v199

## Summary

The production site runs the gucOS image v199. The previous production image was
v198. This release is not a bundle. The bump to v199 was the only pending bump,
so v199 ships alone.

The deploy source is `784d9f3c`
(`784d9f3cf405c59a75842db0d68513785fb3aa4b`). The command `git ls-remote origin
main` confirmed this SHA before the build. The file `os/image.json` at that SHA
reads `"version": 199`.

## Content

The release contains todos/0417. The item is closed. The item makes an HTTP
transfer an open file description.

Before this change the kernel held HTTP transfers in a parallel table. The table
used the opcodes `HTTP_READ` and `HTTP_CLOSE`. Now a transfer is a file
descriptor. A caller reads it with `read` and closes it with `close`. The two
special opcodes are retired. The liability `L61` is retired with them.

The change adds `/bin/curl` and relinks the `gucman` veneer. The image bakes
`/usr/bin/curl` at 23 343 bytes. That binary is new. The image bakes
`/usr/bin/gucman` at 147 052 bytes. These two binaries are the reason for the
bump from 198 to 199.

The lane made one decision beyond the letter of the item, and it reported that
decision. The opcode `HTTP_OPEN` on a kernel with no file system now returns
`ENOSYS`. The reason is sound. A transfer is a file descriptor, so a kernel
without file descriptors cannot supply one. A parallel handle table for that
kernel flavour is the second code path that this item removes. The test
`test_http.js` covers the `ENOSYS` leg. The coordinator accepted the decision.

This release unblocks `todos/0437`, `todos/0440` and `todos/0445`.

## The gate

The coordinator of the merge verified the gate from the artifacts, not from
prose. The numbers below come from `runs[0]` in each summary file.

The kernel suite recorded 137 of 137 files. The summary holds exactly one run
entry, so no re-run is hidden. It reads `filter: null`. The browser suite
recorded 42 of 42 files in one run entry, with `filter: null`.

The coordinator derived the browser denominator instead of carrying it. The
directory holds 43 files that match `os-*.mjs`. The file `os-sweep.mjs` excludes
itself at line 39. The denominator is therefore 42.

The red control is real, and the coordinator did not assume it. The rewritten
`test_http.js` produces 43 explicit failures and exit code 1 on the kernel
before the change. The watchdog bounded that run.

The coordinator confirmed that no second code path survives. The fields
`pcb.https` and `_httpXfers` are absent everywhere. Two matches for the retired
names survive, and both are comments. One is an opcode reservation at
`kernel.js:275`. One is at `libcurl.c:20`.

The `http` branch of `_selectScan` exists at `kernel.js:6838`. That branch was
the spin hazard of this design. The hazard is closed.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v199 784d9f3c`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v199 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
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

The two symlinks in step 3 are both necessary. The root link resolves playwright
1.61.1. The link under `tests/browser/` resolves playwright 1.61.0. The pin
check accepts 1.61.0 only. One link alone gives a sweep of 0 of 42 files, and
that result reads as a catastrophe when it is a setup error.

## Results

The build wrote a sealed image of 24 248 544 bytes. The image reads v199. The
image published as `os-system.0b70f0eb36815376.img`, with `os-system.img` for
compatibility. The previous image measured 24 250 728 bytes at v198, so the
image became 2184 bytes smaller. The retired opcode paths account for that
decrease.

The build wrote 26 package payloads of 45.4 MiB, at `baseVersion 199`. The
directory `dist/` measures 98.9 MiB and is ROM-clean. The build removed 6 ROM
entries. The build recorded the provenance `c-compiler 784d9f3c, img
0b70f0eb3681…`, with `dirty false` for both repositories.

The build printed one `WARNING overlay clang-apps built from a DIRTY tree`. This
warning is a known false alarm. The provenance of the compiler ELF has been
dirty since 2026-07-14. The images v178 to v198 all shipped with this warning.

The command `pnpm verify` printed **PASS with 18 of 18 checks** on the first
run. The count of `ok` lines is 18. The count of lines that hold the word `fail`
is 0. The count of lines that hold the word `skip` is 0. A skip counts as a
failure, so this work counted the lines directly. Check 8, `boots to ready`,
passed on the first attempt in 1.1 s. The item `todos/0435` tracks a flake in
that check, and the flake did not appear here. This result is the third clean
first run in sequence.

The command `node scripts/deploy.mjs --commit` uploaded 10 new files. 58 files
were already present. The upload took 7.86 s. Cloudflare Pages returned the
deployment `https://5226534a.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `b2c57a725bdb124508ca176b0da5100bf607253b`
(`deploy: c-compiler 784d9f3c → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote. This
work did not read the output of `git push` as evidence.

## The artifact check

This work derived the artifact set from `dist/_headers`. It did not use a typed
list. The file marks 21 patterns. Two patterns are wildcards, `/*` and
`/packages/pool/*`. The remaining 19 are concrete paths. This work checked all
19 and prints the count here so that a future shrink is visible. The set matches
the v197 set and the v198 set in size. An older note in the deploy chain named
16 artifacts. That number is wrong and it must not return.

The check fetched each artifact from `https://groundupcoder.com` and compared
the MD5 sum against the local file in `dist/`. The path `/os/os.html` returns a
308 redirect, so the check used `curl -sL` for every path. All 19 local files
resolved and none was empty, so no check was silently absent.

The check ran 4 poll rounds at 20 s spacing. Every round gave **19 of 19**. No
artifact was stale in any round. The v197 deploy and the v196 deploy each found
`/build-info.json` stale at round 1, so the 4 rounds remain necessary. A clean
round 1 is a result, not a reason to stop early. One round samples one point of
presence only.

The edge serves `image.json` with `"version": 199`. The edge serves
`build-info.json` with `c-compiler 784d9f3cf405c59a75842db0d68513785fb3aa4b`,
`dirty false` for both repositories, and `imgSha256
0b70f0eb36815376228b17ca6267e78073ffa23696b416d4e6c294c558219041`. The root path
`/kernel.js` returns 200. The path `/os/kernel.js` returns 404, and that result
is correct.

The check proved the payload, not the version number alone. This work downloaded
the image from the edge. The file measures 24 248 544 bytes. Its SHA-256 sum
equals the sum of the local image, and it equals the `imgSha256` field. The two
files are identical byte for byte.

## A false alarm from the payload probe, and the control that caught it

The first payload probe searched the edge-served image for the full path
`/usr/bin/curl`. The count was **0**. That result reads as a missing payload on
an image that was already live.

The result was false. The same probe searched for `/usr/bin/gucman` and also
returned **0**. The binary `gucman` ships in every image, so a count of 0 for it
is impossible. The control proved that the instrument was wrong, not that the
payload was absent.

The correct form uses the bare name. The image stores a file name, not a
contiguous full path. The bare probe on the edge-served image found `curl` 42
times, `libcurl` 21 times and `gucman` 127 times. The same probe on the local
image gave the same three counts. The v198 log used the bare form, and that is
why it worked there.

Use a positive control in every payload probe. Search for one symbol that must
be present beside the symbol under test. A count of 0 from a broken instrument
and a count of 0 from a missing payload look the same. The control is what
separates them, and it costs one extra term in the same command.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must
do a hard reload.

This work removed the temporary worktree `/tmp/deploy-v199` after the check. It
unlinked both `node_modules` symlinks first and confirmed that the two targets
in the main tree survived. A build symlink that points at the main tree makes
the removal of a worktree a risk, so unlink it explicitly. The count of
c-compiler worktrees is 24.

The worktree `~/worktree/clang-simplified/0330-libc-revendor` is present. That
worktree is the only evidence for `todos/0349`. Do not delete it.

This work found one new gap, and it is an instrument gap, not a code gap. The
gap is recorded in the section above and in the coordinator notes. It changed no
anchored line, so `todos/LIABILITIES.md` needs no re-anchor. This work filed no
new item in `todos/`.
