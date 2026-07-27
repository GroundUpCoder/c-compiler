# 0351 — `/bin/zip` and `/bin/unzip` built on the item-1 library

- **Status**: open
- **Provenance**: jku by email, 2026-07-28 — *"I want to support both zip stuff
  as lib as well as zip and unzip things in gucOS itself."* Full context and
  the candidate research: `~/git/meta/meta/notes/queue-zip-mgpp-2026-07-28.md`.
- **Priority**: P2.
- **Blocked by**: `0350` (the library is the foundation; the whole point is that
  the binaries sit on it).

## Goal

Working `/bin/zip` and `/bin/unzip` in gucOS, built on whatever `0350` vendored.

## The constraint that makes this a real decision

**Build BOTH binaries on the `0350` library** so the image contains one zip
implementation with one hardening story. Do not bolt on busybox `unzip` (half a
pair, and a second implementation) plus Info-ZIP (a third).

- **busybox unzip** is nearly free — upstream `archival/unzip.c` is one file and
  `busybox.config` already carries the knobs (`# CONFIG_UNZIP is not set`,
  `CONFIG_FEATURE_UNZIP_CDF`/`BZIP2`/`LZMA`/`XZ`). But **upstream busybox has no
  `zip` applet at all**, so it cannot deliver the pair on its own.
- **Info-ZIP zip 3.0 / unzip 6.0** is the classic matched pair Debian/macOS
  ship, and the honest downsides: unmaintained since 2009, old heavily
  `#ifdef`-ed C for dead platforms, a real CVE history — though for a local,
  non-network file tool inside a sandboxed WASM OS the exposure is far lower
  than on a server.
- **If `0350` chose libarchive, this item gets much cheaper**: vendor FreeBSD's
  libarchive-backed `unzip(1)` (BSD-licensed, Info-ZIP-flag-compatible,
  standalone port at `github.com/somasis/bsdunzip`) and get zip CREATION from
  `bsdtar`, instead of writing frontends. **If `0350` chose libzip, both
  frontends are ours to write** — libzip ships no `zip`/`unzip` pair, only
  `zipcmp`/`zipmerge`/`ziptool`.

Read `0350`'s close-out before planning: which library landed changes this
ticket's shape substantially.

## Plan

1. Read `0350`'s close-out and take its library as given.
2. Build the pair. Match Info-ZIP's common flags where cheap — that is what
   users and scripts expect — and state which flags you did NOT implement.
3. Path safety, again non-optional: reject absolute member paths and `".."`
   components on extract, reusing `gucman`'s rules.
4. `openwith`/manifest wiring as the other binaries do it.

## Acceptance

- `zip` creates an archive that `unzip` and a host `unzip` both read; a
  host-created zip extracts correctly in-image. Round-trip both directions.
- Zip-slip refused on extract, under test — absolute path AND `".."`.
- Exactly one zip implementation in the image (this ticket must not add a
  second).
- The flags implemented, and those deliberately not, are written down.
- `node tests/run.js --diff` green. Image version bump is **master's to
  assign** — ask.
