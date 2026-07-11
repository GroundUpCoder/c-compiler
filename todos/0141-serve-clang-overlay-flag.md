# 0141 — serve.js --clang: pull in the sibling clang-simplified overlay build if available

- **Status**: open
- **Difficulty**: medium
- **Design**: this file

## Background (full context, no prior conversation assumed)

`serve.js` serves the OS tree over http for the browser boot, and before listening
it runs `ensureSystemImage(dir)` — a freshness gate (todos/0040 + 0082) that rebakes
`os/os-system.img` via `tools/mkimage.js` when the baked blob is version-stale or
older than any bake input, so the browser fetches a current prebaked blob instead of
falling back to the ~16s in-worker bake.

Separately, the **overlay** mechanism (todos/0118) lets `mkimage.js`/`boot.js` fold a
sibling-published `overlay@1` manifest into the image behind an opt-in `--overlay=<id>`
flag. The sibling `~/git/clang-simplified` publishes `out-image/overlay.json` (id
`clang-apps`: cc2wasm-built C/C++ apps — doom-clang, stl4, sdldemo, …) which
`os/image.json`'s `overlays[]` already references at
`../clang-simplified/out-image/overlay.json`. Today only `mkimage.js`/`boot.js`
accept `--overlay`; **`serve.js` does not**, so the browser-served image is always
base-only.

## Goal

Add a `--clang` flag to `serve.js` that, **when the sibling overlay artifact is
available**, serves an image with the `clang-apps` overlay folded in — so a browser
boot shows the clang-built apps. "Available" = the referenced `overlay.json` exists;
if it doesn't, proceed with the base image (this is opt-in convenience, and a missing
sibling build is a normal state, not an error). Requesting `--clang` must be **loud**
about which path it took (folded in vs. sibling-absent).

## Plan

1. **Flag parsing.** `serve.js` currently takes positional args only
   (`arg` = dir/file, `port`). Add a `--clang` flag (and keep positionals working).
   Recommended: also accept `--overlay=<id>` generically, with `--clang` as the alias
   for `--overlay=clang-apps`, mirroring `mkimage.js`.
2. **Resolve availability.** From `os/image.json` `overlays[]`, resolve the
   `clang-apps` entry's `manifest` path (relative to repo ROOT). If the file exists →
   enable; else log `"[serve] --clang requested but ../clang-simplified/out-image/
   overlay.json not found — serving base image"` and continue base. (Do NOT error, and
   do NOT trigger the sibling's build.)
3. **Bake with the overlay.** Thread the enabled overlay id into `ensureSystemImage`
   so its `mkimage.js` invocation passes `--overlay=clang-apps`. The freshness gate
   must become **overlay-aware**: a base blob and a `+clang-apps` blob are different
   images. Use the baked image identity that todos/0118 already stamps
   (`/usr/share/os-release` `OVERLAYS=` line + `/usr/share/os-release.overlays`
   companion): rebake when the *desired* overlay set ≠ the *baked* overlay set (in
   addition to the existing version/input-mtime rules), and factor the sibling
   `overlay.json` mtime into the input-freshness check so re-publishing the overlay
   re-bakes.
4. **Serve to a stable path.** Decide whether the overlay image reuses
   `os/os-system.img` or a sidecar (e.g. `os/os-system.clang.img`) so a `--clang`
   serve and a plain serve don't thrash each other's blob on alternating runs. A
   sidecar keyed by overlay set is the safer default; `kernel-worker.js` fetches
   whatever `serve.js` publishes at the served path.
5. **Loud logging.** On enable: `"[serve] overlay clang-apps folded in
   (clang-simplified@<short>)"`. On base: the not-found line from step 2.

## Acceptance

- `node serve.js` (no flag) is unchanged — base image, byte-identical freshness
  behaviour.
- `node serve.js build --clang` with the sibling `out-image/overlay.json` present:
  bakes/serves an image whose `/usr/share/os-release.overlays` lists `clang-apps`, and
  a browser boot (or a headless mount check) finds `/usr/bin/doom-clang` +
  `/usr/share/menu/Games/doom-clang`. Logs the loud "folded in" line.
- `node serve.js build --clang` with the sibling artifact **absent**: serves the base
  image and logs the "not found — serving base" line; **exit 0, no error**.
- Overlay-awareness: after a `--clang` serve, a subsequent plain `serve.js` rebakes
  back to base (and vice-versa) rather than serving the wrong blob; re-publishing the
  sibling overlay triggers a rebake.

## Coordination / deps

- **Depends on** todos/0118 (overlay support in `mkimage.js`/`boot.js`/`os-common.js`
  — landed) and the `overlay@1` `link` type (landed). No sibling change needed.
- Sibling artifact is produced by `clang-simplified`'s `wasm/tools/mk-overlay.mjs`
  (its todos/0051); this task only *consumes* the published `out-image/overlay.json`.

## Non-goals

- Do not build or trigger the sibling toolchain — consume the prebuilt artifact only.
- Do not change base-serve behaviour when `--clang` is absent.
- No new overlay content here — this is purely the serve-path on-ramp for the existing
  `clang-apps` overlay.
