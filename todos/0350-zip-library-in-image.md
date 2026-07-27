# 0350 — zip as a LIBRARY in the image — measure libarchive vs libzip, then vendor one

- **Status**: open
- **Provenance**: jku asked for this by email, 2026-07-28 — *"I do want to
  support zip - could we queue that as its own thing to work on? I want to
  support both zip stuff as lib as well as zip and unzip things in gucOS
  itself."* Candidate research + the verified tree state are in
  `~/git/meta/meta/notes/queue-zip-mgpp-2026-07-28.md` — **read that note
  first; it is the design input and it already checked the tree.**
- **Priority**: P2. jku set no deadline and asked to QUEUE it, not to drop
  current work.
- **Interlocks**: `0351` (the binaries) and `0352` (the `.mgpp` bundle) both
  build on whatever this lands. A companion PWA item lives outside this repo in
  `netguc/magic` — see `0352`.

## Goal

One real zip read+write implementation linked into the image the way `zlib`
already is. The image must end up with **exactly one** zip implementation — not
a library plus an unrelated one bundled inside some binary.

## Verified tree state — do not re-derive

- **`zlib` IS vendored** at `vendor/zlib`, but **core only**: `lib.json` lists 10
  src files (deflate/inflate/crc32/trees/…). Upstream's `contrib/minizip` was
  NOT vendored. zlib is already linked by libpng, cairo, netsurf, fakegit,
  libgit2, `os/gucman` and `os/image.json`, so deflate+inflate+crc32 are proven
  in-image.
- **gucOS already has a hardened in-C tar+gzip EXTRACTOR** in
  `os/gucman/gucman.c`: `gm_gunzip()` over zlib (`inflateInit2` +32 auto-gzip)
  plus a ustar walker (`tar_next`/`tar_octal`) that rejects absolute member
  paths and `".."` components. Writer side is `tools/mkpkg.js`.
- **busybox is vendored** and `busybox.config` already carries the pkzip knobs
  (`# CONFIG_UNZIP is not set`, plus `CONFIG_FEATURE_UNZIP_CDF`/`BZIP2`/`LZMA`/
  `XZ` unset), but upstream `archival/unzip.c` was NOT vendored. **Upstream
  busybox has no `zip` creator applet at all** — it only ever gets you half the
  pair.

## The recommendation, and the one measurement that decides it

The queue note's revised recommendation is **libarchive (BSD-2), not libzip**,
and jku's initial libzip lean was explicitly demoted to an input after the
adoption picture was checked. The reasoning, on the axis jku asked about:

- It is the only option where the library AND a maintained,
  license-compatible, Info-ZIP-flag-compatible `unzip` frontend come from the
  same place — FreeBSD's base-system `unzip(1)` is a libarchive-backed
  reimplementation, BSD-licensed, with a standalone vendorable port
  (`github.com/somasis/bsdunzip`). That makes `0351` mostly vendoring instead of
  writing two frontends.
- `bsdtar` covers zip CREATION, so the pair is covered without Info-ZIP.
- It SUBSUMES `gucman`'s hand-rolled tar+gz extractor (and the bz2/xz arriving
  via `0343`/`0344`), collapsing three bespoke archive paths into one hardened
  seam. That is the clean general case rather than accumulating a third.
- Windows 11 and FreeBSD independently made this same bet.

**Stated fairly, where libzip still wins**: random-access zip manipulation and
in-place archive modification with clean in-memory sources
(`zip_source_buffer`). libarchive is streaming-first, so random access to one
member means a scan. For `.mgpp` — small decks, a handful of files — that
difference is irrelevant. libzip's real cost is that **it ships no `zip`/`unzip`
pair** (only `zipcmp`/`zipmerge`/`ziptool`), so picking it means writing both
frontends ourselves.

**The one genuine unknown is IMAGE SIZE.** libarchive is materially bigger than
libzip and this is a WASM image. **Do not guess it — MEASURE it as step one**,
and if libarchive's cost is unacceptable, fall back to libzip and accept writing
both frontends. State the number and the call.

Other candidates, recorded so they are not re-researched: **minizip** (zlib
licence, lives in zlib's own `contrib/`, cheapest correct path, dated API,
upstream calls it unmaintained); **minizip-ng** (zlib licence, maintained fork,
CMake-oriented); **miniz** (MIT, single-file, in-memory archives, but bundles
its own inflate/deflate so it duplicates zlib unless built in use-existing-zlib
mode); **libzip** (BSD-3, complete, PHP's `ZipArchive` is libzip).

## Plan

1. **Measure first.** Build both candidates far enough to get an honest image
   delta. Report the bytes. That measurement is the deciding input.
2. Vendor the winner under `vendor/<name>` with a `lib.json` in the shape the
   other vendored libs use, linking the EXISTING `vendor/zlib` — never a second
   inflate/deflate.
3. Wire it into the image the way zlib is wired.
4. Path safety is not optional: reuse `gucman`'s rules — reject absolute member
   paths and `".."` components. This is the zip-slip bug class and `gucman`
   already solved it for tar.
5. Record explicitly whether subsuming `gucman`'s tar+gz extractor is in scope
   for this ticket or deferred to a follow-up. If deferred, **file the
   follow-up** — a gap that does not enter `todos/` does not exist.

## Acceptance

- The chosen library is in the image and linked, with the measured image delta
  stated in the close-out, alongside the number for the option not chosen.
- Round-trip test: create a zip containing several members (including one
  already-compressed payload) and read it back byte-identical, in-image.
- Zip-slip is rejected: an archive with an absolute member path and one with a
  `".."` component both refuse, under test.
- Exactly one zip implementation is present in the image — demonstrated, not
  asserted.
- `node tests/run.js --diff` green. `os/image.json` version bump is **master's
  to assign** — ask, do not pick one.
