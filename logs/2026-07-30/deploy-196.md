# Deploy — gucOS image v196

## Summary

The production site runs the gucOS image v196. The previous production image was
v195. This release is not a bundle. The bump to v196 was the only pending bump,
so v196 ships alone.

The deploy source is `3bf24893` (`3bf24893e18e14da0b73794f2ac34c2d919ecea2`).
The command `git ls-remote origin main` confirmed this SHA before the build. The
file `os/image.json` at that SHA reads `"version": 196`.

## Content

The release contains todos/0422. The item is closed. The item makes the
`<select>` element reachable in the gucOS browser. The release holds two real
changes.

First, the function `set_defaults` in `gucos/main.c` now calls
`nsoption_set_bool(core_select_menu, true)`. The Choices file and the command
line still read over this default. This is the `enable_javascript` precedent.

Second, the release fixes a genuine defect beyond the option flip. The gucOS
mutation bridge treats `DOMSubtreeModified` as a render-tree edit. The function
`form__select_process_selection` writes the option state back to the DOM with
`set_selected`. That write-back re-converted the document under the click that
toggled the option. The re-conversion destroyed the open menu on every
multi-select toggle. The fix adds a `form_selfmutation` guard around the
write-back loop. The bridge checks the guard. This is the TEXTAREA and INPUT
value-edit precedent. A JS-originated `option.selected` write keeps the
re-conversion path.

The three edited files are `form.c`, `dom_event.c` and `private.h` under
`vendor/netsurf/netsurf/content/handlers/html/`. These files are
upstream-derived, so their sections in `patches/netsurf.diff` were regenerated.
The coordinator proved the mirror genuine: all three files reverse-apply with
zero fuzz to a byte-identical pristine. These files bake `/usr/bin/netsurf`.
That binary is the reason for the bump from 195 to 196.

## The gate

The test gate was already green at `3bf24893`. This work did not repeat the
sweeps. The coordinator verified the gate from the artifacts, not from prose.

The kernel suite recorded 133 of 133 files. It selected 133 files and executed
133 files. It resumed 0 files. The tally of `results[].status` is 133 pass and
0 other. The summary reads `filter: null`.

The browser suite recorded 42 of 42 files. It selected 42 files and executed 42
files. It carried 0 files. The tally is 42 pass and 0 other. The summary reads
`filter: null`.

Both sweeps started after the last code commit. The last code commit is
`cb4178b6` at 01:16:41 KST. The kernel sweep started at 01:21:32 KST. The final
commit `3bf24893` holds todos and logs only, so it owes no bump.

The todos suite passed 5 of 5 in 11.6 s. The command `node todos/queue.js check`
passed with 136 items, 294 done items and 48 liability entries.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v196 3bf24893`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v196 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
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

The build wrote a sealed image of 23 653 752 bytes. The image measures 22.6 MiB
and reads v196. The build baked `/usr/bin/netsurf` at 5 659 564 bytes. The
build wrote 26 package payloads of 45.4 MiB, at `baseVersion 196`. The
directory `dist/` measures 97.7 MiB and is ROM-clean. The build recorded the
provenance `c-compiler 3bf24893, img 2237d5da02b3…`, with `dirty false` for
both repositories.

The build printed one `WARNING overlay clang-apps built from a DIRTY tree`.
This warning is a known false alarm. The provenance of the compiler ELF has
been dirty since 2026-07-14, and v178 through v192 shipped with the same flag.

The command `pnpm verify` ran twice. The first run failed at check 8 with
`page.waitForFunction: Timeout 120000ms exceeded` at `verify.mjs:106`. That
check waits for the boot state `ready` in headless Chromium. The 7 checks
before it passed. The port 3187 was free, and the page printed no console
error. The second run, on the same `dist/`, printed **PASS with 18 of 18
checks**, and the boot check passed. The first failure was therefore a
transient boot timeout, not a defect in the payload. The count of `ok` lines in
the second run is 18. The count of lines that hold the word `skip` is 0. The
count of `FAIL` lines is 0. A skip counts as a failure, so this work counted
the lines directly.

The command `node scripts/deploy.mjs --commit` also ran twice. The first run
failed because the non-interactive environment had no `CLOUDFLARE_API_TOKEN`.
The second run exported the token from `~/.guc/creds/cloudflare-api-token`
through shell substitution, so the value stayed out of the transcript. That run
uploaded 6 new files. 62 files were already present. The upload took 9.57 s.
Cloudflare Pages returned the deployment `https://ecf3355d.comguc.pages.dev`.
The script appended a record to `deploys/log.jsonl`.

The ledger commit is `cfb6c35ff4463a543973046dfdc5838930fc940f`
(`deploy: c-compiler 3bf24893 → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

The 16 artifacts are the set that `dist/_headers` marks `must-revalidate`. The
file marks 18 patterns. Remove `os-system.img` and `packages/index.json`, and
16 remain. This set holds the 14 runtime assets, plus `/os/image.json` and
`/build-info.json`. The check fetches each artifact from
`https://groundupcoder.com` and compares the MD5 sum against the local file in
`dist/`. The path `/os/os.html` returns a 308 redirect, so the check uses
`curl -sL`.

The propagation was fast. Round 1 gave **16 of 16**. One round can sample one
point of presence only, so this work ran 3 more rounds at 20 s spacing. Each
round gave 16 of 16. The total is **4 poll rounds, all 16 of 16, 0 stale**. The
history shows a slower result. The v190 deploy gave 13 of 16 at round 1, and an
earlier deploy needed 8 rounds. A single probe is therefore not sufficient
evidence, even when round 1 is complete.

The check also compared the 3 artifacts that the canonical set excludes. The
hashed blob `/os/os-system.2237d5da02b347f9.img`, the compatible path
`/os/os-system.img` and the file `/packages/index.json` all match the local MD5
sum.

The edge serves `image.json` with `"version": 196`. The edge serves
`build-info.json` with `c-compiler 3bf24893e18e14da0b73794f2ac34c2d919ecea2`,
`dirty false`, and `imgSha256 2237d5da02b347f9…`. The root path `/kernel.js`
returns 200. The path `/os/kernel.js` returns 404, and that result is correct.

The check proved the payload, not the version number alone. The proof is a
chain of three links. First, the source at `3bf24893` holds the
`core_select_menu` default flip at `gucos/main.c:219`, and the
`form_selfmutation` guard in `form.c`, `dom_event.c` and `private.h`. Second,
the build recorded the provenance `c-compiler 3bf24893`, and `os/image.json`
bakes `/usr/bin/netsurf` from `vendor/netsurf/`. Third, the sealed image at the
edge matches the local image byte for byte. The binary that carries the fix is
therefore in the image that the edge serves.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS
and `image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must
do a hard reload.

This work found no new gap, so it filed no new item in `todos/`. It changed no
anchored line, so `todos/LIABILITIES.md` needs no re-anchor. The work removed
the temporary worktree `/tmp/deploy-v196` after the check. The count of
c-compiler worktrees is 23.
