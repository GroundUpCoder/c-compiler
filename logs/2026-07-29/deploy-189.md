# Deploy — gucOS image v189

## Summary

The production site runs the gucOS image v189. The previous production image
was v186. This release is a bundle. It ships v187, v188 and v189 together.

The deploy source is `f0951f5a` (`f0951f5ae69c9898d3ecd1c41e75a0037e3ff22b`).
The command `git ls-remote origin main` confirmed this SHA before the build.
The file `os/image.json` at that SHA reads `"version": 189`.

## Content

The release contains todos/0398, the host-to-gucOS file transfer seam. It
contains all three steps of that item.

- Step 1 (v187): the EGRESS RPC, the kernel materializer, the store-only zip
  writer, `os/egress.h`, and the `boot.js --egress-dir` headless twin.
- Step 2 (v188): the Download UI in `os/wm.c` and `os/win32/fileman.c`, and the
  download actor and the save actor in `os.html`.
- Step 3 (v189): the ingress paste. This step adds the chord carve-out, the
  staging area, the shadow memo, the desktop paste chord, and the directory
  drops.

## The gate

The test gate was already green at `f0951f5a`. This work did not repeat the
sweeps. The kernel suite recorded 127 of 127 files, resumed 0, carried 123. All
135 result legs passed. The browser suite recorded 41 of 41 files, resumed 0,
carried 37. All 51 result legs passed. Neither suite reported a flaky file. Both
summaries read `done: true`.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v189 f0951f5a`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v189 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
   The variable `CLANG_SIMPLIFIED` is mandatory. The script `deploy.mjs` gates on
   the provenance that the build records. A symlink before the build makes that
   provenance dirty.
3. Make both symlinks after the build. Link `node_modules` and
   `tests/browser/node_modules` to the main tree.
4. Run `pnpm verify`.
5. Run `node scripts/deploy.mjs --commit` with the Cloudflare token.
6. Push the ledger commit.
7. Check the artifacts at the edge.

## Results

The build wrote a sealed image of 22.5 MiB and 26 package payloads of 45.4 MiB.
The build recorded the provenance `c-compiler f0951f5a, img ed710d34bb33…`. The
file `dist/build-info.json` records `dirty: false` for both repositories. The
build printed one `WARNING overlay clang-apps built from a DIRTY tree`. This
warning is a known false alarm. The compiler ELF provenance has been dirty since
2026-07-14.

The command `pnpm verify` printed **PASS with 18 of 18 checks**. It printed no
skip and no failure.

The command `node scripts/deploy.mjs --commit` uploaded 23 new files. 45 files
were already present. The upload took 7.75 s. Cloudflare Pages returned the
deployment `https://be92b712.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `0bca7191f176aa74102264c60c3bb3df61c648ff`
(`deploy: c-compiler f0951f5a → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

The 16 artifacts are the set that `dist/_headers` marks `must-revalidate`. This
set holds the 14 runtime assets, plus `/os/image.json` and `/build-info.json`.
The check fetches each artifact from `https://groundupcoder.com` and compares the
MD5 sum against the local file in `dist/`. The path `/os/os.html` returns a 308
redirect, so the check uses `curl -sL`.

The propagation was fast. Round 1 gave **16 of 16**. An earlier deploy needed 8
rounds and gave only 4 of 16 at round 1. This work ran 2 more rounds to confirm
the result, because one round can reach one point of presence only. Rounds 2 and
3 each gave 16 of 16. The total is **3 poll rounds, all 16 of 16, 0 stale**.

The edge serves `image.json` with `"version": 189`. The edge serves
`build-info.json` with `c-compiler f0951f5a` and `imgSha256 ed710d34bb333e7d`.
The edge serves `/packages/index.json` with `baseVersion 189`. The hashed blob
`/os/os-system.ed710d34bb333e7d.img` returns 200 with
`max-age=31536000, immutable`. The compatible path `/os/os-system.img` returns
200 with `max-age=0, must-revalidate`. Both blobs measure 23 582 128 bytes, the
same as the local file.

## Notes

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must
do a hard reload.

The work removed the temporary worktree `/tmp/deploy-v189` after the check.
