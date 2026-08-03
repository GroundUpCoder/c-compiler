# Deploy — gucOS image v224

## Summary

The production site runs the gucOS image v224. The previous production image
was v223. This release ships the batch #1 merge alone. The bump from 223 to
224 was the only pending bump.

The deploy source is `6f621066` (`6f621066ae694e20ed7ce948af4cbaaa457a774d`).
The command `git ls-remote origin main` confirmed this SHA before the build.
The file `os/image.json` at that SHA reads `"version": 224`.

## Content

The release contains batch #1: tickets #141, #144 and #434, plus one
browser-test fix.

Ticket #141 (0355) adds the test that proves the gucman dispatch-shadow guard
fires. Ticket #144 (0363) adds the `newestPkgInput` freshness gate with a red
control, and moves the scan into `os-common.js`. Ticket #434 adds the
build-time referential-integrity check for the manifest, and removes three
dead Desktop launchers: `/root/Desktop/pokemon`, `/root/Desktop/mario` and
`/root/Desktop/drmario`. The browser-test fix derives the os-paint
desktop-restored probe from the icon grid.

Ticket #434 is the only member that moves `os/image.json`. The launcher
removal is the reason for the bump from 223 to 224.

## The gate

The test gate was already green at the merge. This work did not repeat the
sweeps. The coordinator verified the gate from the artifacts before the merge:
the host suite exited 0, the kernel suite recorded 151 of 151 passes, the
browser suite recorded 49 of 49 passes with zero non-pass, the todos suite
passed, and `./todos/githooks/pre-commit` exited 0 on merged main.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git -C ~/git/c-compiler worktree add /tmp/deploy-v224 6f621066`.
2. Build against that clean worktree:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v224 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
3. Run `pnpm verify` against the built `dist/`. The variable `C_COMPILER`
   stayed unset here, so the verify script found Playwright in the main tree.
   The worktree needed no `node_modules` symlink.
4. Run `node scripts/deploy.mjs --commit` with the Cloudflare token.
5. Push the ledger commit.
6. Check the artifacts at the edge.

This work followed the order above.

## Results

The build wrote a sealed image of **15 672 112 bytes**. The image reads v224
and has the SHA-256 `2320bfd2b041e866…`. The size cap is 26 214 400 bytes, so
the headroom is 10 542 288 bytes. The v223 image also measured 15 672 112
bytes, so the size delta is 0 bytes. The content differs: the v223 image has
the SHA-256 `77f6edb48a551e79…`. The build wrote 77 package payloads of
72.3 MiB at `baseVersion 224`. The directory `dist/` measures 109.5 MiB and
is ROM-clean. The build recorded the provenance `c-compiler 6f621066, img
2320bfd2b041…`, with `dirty false` for both repositories.

The command `pnpm verify` ran once and printed **PASS with 19 of 19 checks**.
The boot reached `ready` in 1.1 s. The count of `ok` lines is 19. The count of
`skip` lines is 0. The count of `FAIL` lines is 0. The clang-app leg ran and
passed, because this build is the superset package build.

The command `node scripts/deploy.mjs --commit` ran once. The shell exported
the token from `~/.guc/creds/cloudflare-api-token` through substitution, so
the value stayed out of the transcript. The upload sent 38 new files; 81 files
were already present. The upload took 6.81 s. Cloudflare Pages returned the
deployment `https://2f50ee6e.comguc.pages.dev`. The script appended a record
to `deploys/log.jsonl`.

The ledger commit is `ef3f671` (`deploy: c-compiler 6f621066 →
groundupcoder.com`) in `~/git/comguc`, pushed to `origin/main`.

## The artifact check

The 16 artifacts are the set that `dist/_headers` marks `must-revalidate`,
minus `os-system.img` and `packages/index.json`. The check fetches each
artifact from `https://groundupcoder.com` and compares the MD5 sum against the
local file in `dist/`. The path `/os/os.html` returns a 308 redirect, so the
check uses `curl -sL`.

Round 1 gave 13 of 16. The stale artifacts were `/compiler.js`,
`/os/image.json` and `/build-info.json`. Rounds 2, 3 and 4, at 20 s spacing,
each gave **16 of 16**. The round-1 misses resolved in less than 20 s, so they
were edge propagation, not the 4-hour `.js` cache hazard. That hazard shows a
stale `.js` that persists against a fresh image; no artifact persisted stale.

The check also compared the 3 excluded artifacts. The hashed blob
`/os/os-system.2320bfd2b041e866.img`, the compatible path
`/os/os-system.img` and the file `/packages/index.json` all match the local
MD5 sum.

The edge serves `image.json` with `"version": 224`. The edge serves
`build-info.json` with `c-compiler 6f621066ae694e20ed7ce948af4cbaaa457a774d`,
`dirty false` for both repositories, and `imgSha256 2320bfd2b041e866…`.

## Notes

The v224 image and the v223 image have an identical byte count. The sealed
image size rounds to the block-pool geometry, so a small manifest edit can
land inside the same extent. The SHA-256 difference proves the content
changed.

This work found no new gap, so it filed no ticket. It removed the temporary
worktree `/tmp/deploy-v224` after the check and ran `git worktree prune`.
