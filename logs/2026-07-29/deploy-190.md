# Deploy — gucOS image v190

## Summary

The production site runs the gucOS image v190. The previous production image was
v189. This release is not a bundle. The bump to v190 was the only pending bump,
so v190 ships alone.

The deploy source is `46ea6544` (`46ea65442392e5a13c85a4635ebd218ded3a76a5`).
The command `git ls-remote origin main` confirmed this SHA before the build. The
file `os/image.json` at that SHA reads `"version": 190`.

## Content

The release contains todos/0397. That item adds `/usr/bin/pbcopy` and
`/usr/bin/pbpaste`, which are the macOS names for the clipboard.

The two programs are separate binaries. They share the header `os/clipio.h`.
They are not one multicall binary. They drive the same single kernel clipboard
slot that `/bin/clip` drives (todos/0090). Therefore the three names interoperate
in both directions. The item also moves `os/clip.c` onto the same header. The
contract of `clip` stays byte-identical. The file `os/image.json` gains the two
`/usr/bin` entries and the `hdrs` wiring for all three programs.

## The gate

The test gate was already green at `46ea6544`. This work did not repeat the
sweeps.

The kernel suite recorded 128 of 128 files, resumed 0, and carried 124. It ran
138 result legs. 137 legs passed and 1 leg failed. The failed leg is
`test_netsurf_mutation_e2e.js`. That failure carries the documented signature of
the open item todos/0386, which is a load-dependent flake (`static 285 vs ticking
234 ink pixels`). The coordinator ran that file alone on a quiet machine with
`--repeat 3`. The file passed 3 times of 3, at a flake rate of 0 percent. The
diff of todos/0397 has no causal path to a NetSurf DOM mutation.

The browser suite recorded 41 of 41 files, resumed 0, and carried 37. All 49
result legs passed. No suite reported a flaky file. Both summaries read
`done: true`. Both full sweeps started after the last code commit. The todos
suite passed 5 of 5. The command `node todos/queue.js check` passed at 120 items
and 282 done items.

## Procedure

1. Create a clean worktree at the deploy SHA:
   `git worktree add /tmp/deploy-v190 46ea6544`.
2. Build against that clean worktree BEFORE you make any symlink:
   `cd ~/git/comguc && C_COMPILER=/tmp/deploy-v190 CLANG_SIMPLIFIED=/Users/jku/git/clang-simplified pnpm build`.
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

The build wrote a sealed image of 23 625 240 bytes and 26 package payloads of
45.4 MiB. The directory `dist/` measures 97.7 MiB. The build recorded the
provenance `c-compiler 46ea6544, img 20c6bb601890…`. The file
`dist/build-info.json` records `dirty: false` for both repositories. The build
printed one `WARNING overlay clang-apps built from a DIRTY tree`. This warning is
a known false alarm. The provenance of the compiler ELF has been dirty since
2026-07-14, and v178 shipped with the same flag.

The command `pnpm verify` printed **PASS with 18 of 18 checks**. It printed no
skip and no failure. A skip counts as a failure, so this work counted the `ok`
lines directly.

The command `node scripts/deploy.mjs --commit` uploaded 6 new files. 62 files
were already present. The upload took 8.63 s. Cloudflare Pages returned the
deployment `https://de7457b3.comguc.pages.dev`. The script appended a record to
`deploys/log.jsonl`.

The ledger commit is `2223df067cf7ef89b4af9d1b68a3e6e9f39dad9b`
(`deploy: c-compiler 46ea6544 → groundupcoder.com`) in `~/git/comguc`. The
command `git ls-remote origin main` confirmed that commit at the remote.

## The artifact check

The 16 artifacts are the set that `dist/_headers` marks `must-revalidate`. This
set holds the 14 runtime assets, plus `/os/image.json` and `/build-info.json`.
The check fetches each artifact from `https://groundupcoder.com` and compares the
MD5 sum against the local file in `dist/`. The path `/os/os.html` returns a 308
redirect, so the check uses `curl -sL`.

The propagation was fast. Round 1 gave **16 of 16**. This work ran 2 more rounds
to confirm the result, because one round can reach one point of presence only.
Rounds 2 and 3 each gave 16 of 16. The total is **3 poll rounds, all 16 of 16, 0
stale**.

An earlier probe measured the propagation from a different angle. That probe read
`/os/image.json` and `/build-info.json` 16 times each, and it ran directly after
the push of the ledger. Round 1 gave 13 of 16. Three samples were stale: two read
the image version 189, and one read the commit `f0951f5a`, which is v189. Round 2
gave 16 of 16, and a confirm round gave 16 of 16. This result shows that the edge
cache holds a stale copy at some points of presence for a short time after a
deploy. A single probe is therefore not sufficient evidence.

The edge serves `image.json` with `"version": 190`. The edge serves
`build-info.json` with `c-compiler 46ea65442392e5a13c85a4635ebd218ded3a76a5`,
`dirty false`, and `imgSha256 20c6bb601890a44d`. The edge serves
`/packages/index.json` with `baseVersion 190`. The hashed blob
`/os/os-system.20c6bb601890a44d.img` returns 200 with
`max-age=31536000, immutable`. The compatible path `/os/os-system.img` returns
200 with `max-age=0, must-revalidate`. Both blobs measure 23 625 240 bytes, the
same as the local file.

The check also proved the content of the release. The `image.json` at the edge
contains the entries `/usr/bin/pbcopy` and `/usr/bin/pbpaste`. A version number
alone does not prove that the payload shipped.

## Notes

Do not probe `gucos.groundupcoder.net`. That host is a placeholder. Every probe
against it fails to parse, so a healthy deploy reads as dead. The edge is
`groundupcoder.com`.

Clients can lag the edge by up to 4 hours for a cached asset. The runtime JS and
`image.json` carry `max-age=0, must-revalidate`, so a returning client
revalidates them. A client that reports old behaviour soon after a deploy must do
a hard reload.

This work found no new gap, so it filed no new item in `todos/`. The work removed
the temporary worktree `/tmp/deploy-v190` after the check.
