# Deploy — gucOS image v191

## Summary

The production site runs the gucOS image v191. The previous production image was
v190. This release is not a bundle. The bump to v191 was the only pending bump,
so v191 ships alone.

The deploy source is `34cad0dc` (`34cad0dc3279e0037ed40e176e1632ba8c00df5e`).
The command `git ls-remote origin main` confirmed this SHA before the build. The
file `os/image.json` at that SHA reads `"version": 191`. Before the deploy, the
edge served the image version 190 and the commit `46ea6544`.

## Content

The release contains todos/0386 and todos/0402. Both items are closed. The two
items fix the NetSurf focus during the live re-conversion window. Before the fix,
NetSurf discarded a keystroke and a click in that window without a message. The
verdict was M1, a product defect.

The fix replaces the mechanism. It does not patch the symptom. The old code took
a focus snapshot at the start of the window. That snapshot held a DOM node and a
caret position. The new code holds a `struct form_control *reconvert_focus_claim`
instead. Therefore the focus stays valid for the full build-then-swap interval,
and the code re-binds the focus to the new tree at the swap.

The diff touches `vendor/netsurf/`. The changed files are `box_textarea.c`,
`html.c`, `private.h` and `netsurf.diff`. These files bake `/usr/bin/netsurf`.
That binary is the reason for the bump from 190 to 191.

The branch also carries the items 0406, 0407, 0408, 0409, 0410 and 0411. These
items are text in `todos/` only. They change no runtime path.

## The gate

The test gate was already green at `34cad0dc`. This work did not repeat the
sweeps. The coordinator verified the gate from the artifacts, not from prose.

The kernel suite recorded 128 of 128 files. It resumed 0 files and carried 0
files. The tally of `results[].status` is 128 pass and 0 fail. The summary reads
`done: true`. All 8 NetSurf e2e legs are in those 128 files, and all 8 legs pass.
The set includes `test_netsurf_mutation_e2e.js`, which is the test that the fix
targets.

The browser suite recorded 41 of 41 files. The tally is 41 pass. The summary
reads `done: true`. One leg failed in the first full sweep under the load of 41
parallel files. The leg is the "vi edits a file through xterm" leg of
`os-boots.mjs`. The coordinator characterised that failure instead of accepting
the re-run. The leg waits for the needle `VI-CAT-OK`, but the terminal echo of
the typed command satisfies that wait. Therefore the leg samples the buffer
before `cat` writes the text. This is a test defect. The item todos/0409 records
it. The defect has no causal path to this diff, because the only runtime paths in
this diff are `vendor/netsurf/` and `os/image.json`, and that leg runs `vi` in
the gucOS terminal. Solo runs on a quiet machine passed 4 times of 4.

Both sweeps started after every commit on the branch. The last code commit is at
08:41:05 KST. The kernel sweep started at 08:58:23 KST. The browser sweep started
at 09:16:41 KST.

The flake gate ran `test_netsurf_mutation_e2e.js` 5 times under the D2 conditions
that reproduce the bug. Those conditions are a page of 3000 elements and a tick
of 300 ms. The file passed 5 times of 5. The todos suite passed 5 of 5 in 11.6 s.
The command `node todos/queue.js check` passed at 124 items and 284 done items.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v191 34cad0dc`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v191 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
   The variable `CLANG_SIMPLIFIED` is mandatory. The script `deploy.mjs` gates on
   the provenance that the build records. A symlink before the build makes that
   provenance dirty.
3. Make both symlinks after the build. Link `node_modules` and
   `tests/browser/node_modules` to the main tree.
4. Run `pnpm verify`.
5. Run `node scripts/deploy.mjs --commit` with the Cloudflare token.
6. Push the ledger commit.
7. Check the artifacts at the edge.

This work followed the order above. The check at step 1 showed no `node_modules`
in the new worktree, which proves the build ran clean.

## Results

The build wrote a sealed image of 23 625 360 bytes. It wrote 26 package payloads
of 45.4 MiB. The directory `dist/` measures 97.7 MiB and is ROM-clean. The build
recorded the provenance `c-compiler 34cad0dc, img 8cd56343356a…`. The file
`dist/build-info.json` records `dirty: false` for both repositories.

The build printed one `WARNING overlay clang-apps built from a DIRTY tree`. This
warning is a known false alarm. The provenance of the compiler ELF has been dirty
since 2026-07-14, and v178 shipped with the same flag.

The command `pnpm verify` printed **PASS with 18 of 18 checks**. It printed no
skip and no failure. A skip counts as a failure, so this work counted the `ok`
lines directly. The count of `ok` lines is 18. The count of lines that hold the
word `skip` is 0.

The command `node scripts/deploy.mjs --commit` uploaded 6 new files. 62 files
were already present. The upload took 8.09 s. Cloudflare Pages returned the
deployment `https://750b8a81.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `89159c19db8e75a834795dbb574283e30e23bac2`
(`deploy: c-compiler 34cad0dc → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

The 16 artifacts are the set that `dist/_headers` marks `must-revalidate`. This
set holds the 14 runtime assets, plus `/os/image.json` and `/build-info.json`.
The check fetches each artifact from `https://groundupcoder.com` and compares the
MD5 sum against the local file in `dist/`. The path `/os/os.html` returns a 308
redirect, so the check uses `curl -sL`.

The propagation was fast. Round 1 gave **16 of 16**. This work then ran a second
independent pass, because one round can sample one point of presence only. That
pass also gave 16 of 16 at round 1. The total is **2 poll rounds, both 16 of 16,
0 stale**. The history shows a slower result: the v190 deploy needed more rounds,
and one earlier probe gave 13 of 16 at round 1. A single probe is therefore not
sufficient evidence, even when round 1 is complete.

The edge serves `image.json` with `"version": 191`. The edge serves
`build-info.json` with `c-compiler 34cad0dc3279e0037ed40e176e1632ba8c00df5e`,
`dirty false`, and `imgSha256 8cd56343356aa789`. The hashed blob
`/os/os-system.8cd56343356aa789.img` returns 200 with
`max-age=31536000, immutable`. The compatible path `/os/os-system.img` and the
file `/packages/index.json` both match the local MD5 sum.

The check proved the payload, not the version number alone. The proof is a chain
of three links. First, the source at `34cad0dc` holds the new symbol
`reconvert_focus_claim` in `private.h`, `html.c` and `box_textarea.c`, and the
two deleted symbols `reconvert_focus_node` and `reconvert_focus_caret` are
absent. Second, the build recorded the provenance `c-compiler 34cad0dc`, and
`os/image.json` bakes `/usr/bin/netsurf` from `vendor/netsurf/gucos/bin.json`.
Third, the sealed image at the edge matches the local image byte for byte. The
binary that carries the fix is therefore in the image that the edge serves.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

The file `build-info.json` records the comguc commit `2223df0`. That commit is
the ledger of the previous deploy. The build stamps this file, and the build runs
before the ledger commit. Two different ledger SHAs are therefore correct. The
comguc commit `89159c1` is the ledger of this deploy.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must do
a hard reload.

This work found no new gap, so it filed no new item in `todos/`. The work removed
the temporary worktree `/tmp/deploy-v191` after the check.
