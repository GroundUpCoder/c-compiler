# 0141 — serve.js `--clang`: serve the sibling clang-apps overlay when available

**Date**: 2026-07-12
**Item**: todos/0141 (closed) · builds on todos/0118 (overlay support in
mkimage/boot/os-common) · consumes the sibling `clang-simplified` artifact

## What landed

`serve.js` gained a `--clang` flag (generic `--overlay=<id>` / `--overlays=a,b`
too) that folds the sibling-published `clang-apps` image overlay into the
browser-served system blob **when the sibling artifact is available** — a
browser boot then shows the cc2wasm-built clang apps (doom-clang, stl4,
sdldemo). A missing sibling build is a normal, opt-in-not-satisfied state: the
serve drops to the base image and logs a loud line, never errors.

## The three moving parts

1. **Flag parsing.** serve.js took positional args only; it now separates
   flags from positionals (dir, port still work) and collects requested overlay
   ids. `--clang` is the alias for `--overlay=clang-apps`, mirroring mkimage.js.

2. **Availability + a sidecar blob.** `resolveOverlayPlan()` resolves requested
   ids against `os/image.json` `overlays[]`, checks the referenced
   `overlay.json` exists (absent → loud `--clang requested but … not found —
   serving base image`, drop it, continue base), and reads producer/commitShort
   for the "folded in" line. Enabled overlays bake to a **sidecar keyed by the
   overlay set** — `os-system.<ids-joined>.img` (e.g. `os-system.clang-apps.img`)
   — so a `--clang` serve and a plain serve never thrash each other's blob.
   `os/os-system.*.img` is now gitignored.

3. **Overlay-aware freshness + the request swap.** `ensureSystemImage(dir,
   plan)` became overlay-aware: it compares the DESIRED overlay set against the
   blob's baked `OVERLAYS=` line (new `os-common.bakedOverlays()` — the second
   axis of image identity next to `bakedVersion`) on top of the existing
   version/input-mtime rules, and folds the sibling `overlay.json` mtime into
   the input-freshness check so **re-publishing the overlay re-bakes**. The
   browser still fetches `os-system.img` beside the page (no kernel-worker
   change): the HTTP handler maps that path onto the sidecar when an overlay is
   active.

## Why a sidecar (not reuse `os-system.img`)

boot.js's overlay path just force-bakes every time (overlays live in the blob,
so it never reuses). serve.js is a long-lived process re-run often, and the
todo asked for overlay-aware freshness so a re-serve doesn't pay ~90s each
time. A base blob and a `+clang-apps` blob are different images at the SAME
`VERSION_ID`, so keying the on-disk file by overlay set gives each its own
independent freshness gate — flip `--clang` on and off and neither rebakes
(both stay fresh in their own file). The `bakedOverlays` compare is the guard
against serving a mislabeled sidecar.

## Verification

- **Manual E2E (sibling present, real bake):** `mkimage --overlay=clang-apps`
  bakes a v72 blob whose `/share/os-release.overlays` lists `clang-apps` and
  carries `/bin/doom-clang` + `/share/menu/Games/doom-clang` (91s, DIRTY
  provenance → warns). `serve.js . --clang` reused the fresh sidecar (no
  rebake), logged `overlay clang-apps folded in (clang-simplified@5d95908)`,
  and served the sidecar bytes for `/os/os-system.img` (cmp-equal). Touching
  `overlay.json` newer → serve correctly decided `input-stale (…/overlay.json
  is newer) — baking (+clang-apps)`.
- **Sibling absent:** renamed the sibling `overlay.json` aside → serve logged
  the not-found/serving-base line, served base bytes, exit 0.
- **Plain serve:** unchanged — base bytes, no overlay logging.
- **Regression test:** `tests/serve/test_clang_overlay.js` (registered in
  `tests/host/run.js`) — hermetic + fast (synthetic tree with NO
  tools/mkimage.js so the freshness gate early-returns, no 90s bake, no sibling
  dependency): asserts flag parsing, the fold-in log + sidecar swap, the
  sibling-absent base fallback + loud line, and that a flagless serve neither
  logs nor swaps. All 6 checks pass; full host suite green.

## Carried limitation (pre-existing, not a follow-up)

A PERSISTENT browser OPFS image only re-fetches on a `image.json` version bump
(the in-browser gate can't stat inputs — todos/0040/0082). So toggling `--clang`
on a browser that already holds a same-version OPFS blob won't pick up the
overlay until OPFS is cleared or the version bumps. This is the standing
browser-gate limitation for ANY content change at a fixed version, not specific
to overlays; the headless/fresh-OPFS path (and the todo's acceptance) work. No
new todo — filing a per-feature item would duplicate the known 0040/0082 gap.

## No image.json version bump

The only bake-input touched was `os/os-common.js`, and the edit is purely
additive (new `bakedOverlays` reader + export) — the baked blob is byte-
identical, so the OPFS version gate has nothing new to fetch. Bumping would
force a pointless re-fetch. (Node-side gates will do one harmless conservative
rebake because os-common's mtime advanced — correct, cheap direction.)
