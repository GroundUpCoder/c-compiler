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

## ⚖️ RULING 2026-07-28 — SCHEDULE NOW; TIE-BREAK **PRE-COMMITTED**; ⚠️ RULES AGAINST JKU'S LEAN

**Provenance: FABLE DECIDER call, relayed by master cont-123, annotated by master
cont-124.** ⚠️ **Decider ruling, NOT jku's** — and on this item that distinction
is load-bearing (see the veto note below). Full reasoning:
`meta/notes/decisions-cont123-fable.md` (meta main `f16db6d`).

**Scope for the first lane: step-1 MEASUREMENT + vendoring prep ONLY.** Disjoint
from the P0 chain's surface. **Worktree.** 🔴 **NO heavy-lock gates while the P0
chain holds the lock** — that scope restriction is the entire reason a 4th lane
was permitted; if a lane widens it, the objection returns. **Image bump is the
master's to assign; the lane never touches `os/image.json`.**

**TIE-BREAK, pre-committed so the lane never bounces back to ask:**
> **libarchive**, unless its **NET compressed image delta** (crediting gucman
> `tar`+`gz` subsumption) exceeds **libzip's by more than 1 MB**. Within
> **~100 KB** = noise = **libarchive**.

🔴 **THIS RULES AGAINST jku's STATED LEAN.** He leaned **libzip**; the ruling goes
**libarchive** *on his own stated criterion* (image size as the deciding
measurement), because libarchive is FreeBSD base + the Win11 default **and ships
the `unzip`/`bsdtar` frontend pair, while libzip ships no frontends**.
~~**HIS VETO STANDS ABOVE THIS RULING.**~~ He was emailed the flag on 2026-07-28
(token `-EPW89cn-OpM`), then emailed the measured numbers (token `D7xHYg02YvOt`).
⭐ This ruling is also the **answer to his still-open email question** (*how
widely is libzip used, and what frontend would we ship?*).

## ✅ VETO RESOLVED 2026-07-28 — jku CONFIRMED **libarchive**. THIS IS NOW A jku CALL, NOT A DECIDER CALL.

Once he had the numbers he replied, verbatim (relayed to master cont-126):

> *"Wait libzip vs lib archive - I thought I said libarchive is fine? It's ok it
> sounded like that path gave a more streamlined cli path so I'm ok just using
> that instead"*

⇒ **The veto is WITHDRAWN and libarchive is jku-confirmed.** His stated reason is
the **frontend/CLI** story (`bsdtar`/`unzip`), which is exactly the axis the
ruling turned on — not image size. 🔴 **`0351`/`0352` are UNBLOCKED and scope
against libarchive.** Do **not** re-open the library choice, and do **not** cite
"his veto" — it no longer exists. ⚠️ Note for the record that his lean (libzip)
was **right on the merits of size** — libzip is smaller by 58–66 KB compressed —
so if a future item re-prices this, the size argument favours libzip and only the
frontend argument favours libarchive.


## ✅ STEP-1 MEASUREMENT DONE (2026-07-28, lane `0350-zip`) — THE CALL IS **libarchive**

**Method** (harness committed at `tools/zipmeasure/` — `fetch.sh` pins
libarchive 3.8.1 + libzip 1.11.4 by sha256, `run.sh` rebuilds and re-verifies):
both candidates built by OUR compiler against the existing `vendor/zlib`, each
into a frontend that creates a 3-member zip, reopens it and verifies every
member byte-identical (system `unzip` cross-reads both outputs). A baseline
binary (libc + zlib + stdio frontend, no archive lib) isolates the
lib-attributable cost. libzip is its COMPLETE upstream source list (deflate
only, no crypto); libarchive is cut to the shippable set (zip r/w, tar r,
ustar+pax w, gzip r/w, archive_write_disk) with the pull-the-world dispatch
tables excluded. Control: the linker does NOT drop unreferenced TU functions
(two unreferenced TUs grew the binary 24 KB), so these numbers price the
vendored TU set — and the comparison thereby leans in libzip's favor, since
libzip's number is its whole library.

| binary | raw | gzip -9 |
|---|---|---|
| baseline | 78,973 | 32,435 |
| libzip 1.11.4 | 181,111 | 70,461 |
| libarchive 3.8.1 (no write_disk) | 357,259 | 128,619 |
| libarchive 3.8.1 (+ write_disk) | 381,425 | 136,494 |

Lib-attributable: **libzip 38 KB compressed / 102 KB raw**; **libarchive
96 KB compressed / 278 KB raw** (104/302 with write_disk). Per-binary delta
libarchive−libzip ≈ **58 KB compressed** (66 with write_disk) — INSIDE the
ruling's ~100 KB noise band. Even shipping two separate frontend binaries
instead of one multicall (doubling the lib) puts the gap at ~132 KB, nowhere
near the 1 MB that would flip the call. **Tie-break applied as pre-committed:
libarchive.**

**Correction to the ruling's framing — subsumption is a COST here, not a
credit.** Every binary in the image is statically linked; "subsuming" gucman's
tar+gz extractor means gucman LINKS libarchive and grows by ~100 KB raw, while
the bespoke code it sheds (`gm_gunzip` + the ustar walker, ~150 lines) is
~2–3 KB, and its zlib stays regardless. Measured recommendation for the
implementing lane: do NOT fold gucman onto libarchive while linking is static
— it is a pure size regression with no functional gain; the three-paths-to-one
consolidation only pays off if a shared-library story lands (dlopen lane).
This does not move the call: at zero credit the gap is still inside the noise
band. The **frontends** (`unzip`/`zip` as one multicall binary, bsdunzip +
bsdtar-derived) are where libarchive's value shows up, per the ruling.

**libc gaps found for the real vendoring** (details in
`tools/zipmeasure/README.md`): `umask(2)` and `id_t` are absent from the
embedded libc (archive_write_disk needs umask — measurement shims it);
`strcasecmp` needs `<strings.h>` pulled in for libzip-style code;
absent-but-config'd-around: gmtime_r/ctime_r/timegm/tzset, fchdir/fstatat/
openat/linkat, mkfifo, arc4random.

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

## Priority — raised from P2 to P1 (master, 2026-07-29)

Ticket 0352 has a real consumer now. The 013 deck pipeline made the file
`videos/013-ground-up-bulldozer/013.mgpp` in the repository `~/git/story`. Git
tracks that file. Master verified this off the repository, not off a report.

Ticket 0352 is blocked by this ticket. Therefore this ticket is on the critical
path, and its priority goes up with it.

Ticket 0351 stays at P2. The consumer needs the reader. The consumer does not
need the `zip` and `unzip` programs.
