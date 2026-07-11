# 0121 — Reproducible image bakes: strip wall-clock inode mtimes so os-system.img is blob-deterministic (verify overlays/base by hash)

- **Status**: open
- **Design**: this file; surfaced by `todos/done/0118-image-overlays-opt-in.md`

## Background

0118's Acceptance (a) asked that a base bake be **byte-identical** to the current
output ("same seal + version"). That is **not achievable today**: `bakeSystemImage`
(→ BlockFS) stamps every inode's mtime/ctime from the wall clock, so two otherwise
identical bakes differ in ~24 bytes (8-byte-spaced inode time fields) *and* in the
sealed superblock hash that covers them. Measured this session: two back-to-back
base bakes of a tiny manifest differed only in those inode-time bytes + the seal.

Consequences:

- The published `os/os-system.img` is not reproducible — you cannot verify a blob
  by re-baking and comparing hashes, only by `verifySeal` (which checks internal
  consistency, not "was this baked from tree X").
- 0118 fell back to asserting **inertness** (base os-release is the exact canonical
  string; no overlay dir/file/companion) instead of a whole-blob compare. Fine as
  far as it goes, but it means "byte-identical output" as literally specified is
  unmet, and an overlay image's provenance can't be pinned by blob digest.

## Goal

Make a bake deterministic given identical inputs: same manifest + same sources +
same overlay artifacts → same blob bytes → same seal. Then overlay/base image
identity can be verified by hashing the blob, and 0118's Acceptance (a) becomes
literally checkable.

## Plan (sketch — design when picked up)

- Give the baker a fixed "bake epoch" (e.g. `SOURCE_DATE_EPOCH`-style, or a
  manifest field, or simply 0) and thread it so BlockFS inode create/mtime/ctime
  use it instead of the wall clock during a bake. Must NOT change runtime FS
  behaviour — only the offline bake path (mkimage/boot bake, kernel-worker bake).
- Confirm nothing else in the blob is nondeterministic (allocator order, hash-map
  iteration in seedEntries, compiler output — compiler.js is believed
  deterministic; verify).
- Add a test: two bakes of the same manifest are byte-identical; and an overlay
  bake is reproducible given the same `overlay.json` + payloads.
- Consider recording the bake epoch in os-release so the determinism is auditable.

## Acceptance

- Two `node tools/mkimage.js` runs over an unchanged tree produce byte-identical
  blobs (identical seal).
- A `--overlay=<id>` bake is likewise reproducible given identical overlay inputs.
- Runtime filesystem timestamps are unaffected (files created/modified in a booted
  OS still get real mtimes).

## Non-goals

- Not about overlay correctness (0118 landed that) — purely the baker's
  time-source determinism.
