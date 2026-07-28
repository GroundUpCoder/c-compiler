# zipmeasure — todos/0350 step-1 measurement harness (libarchive vs libzip)

Answers the one deciding question of `todos/0350`: the honest wasm image cost
of each zip-library candidate, built by OUR compiler against the EXISTING
`vendor/zlib` (never a second inflate/deflate).

Usage: `tools/zipmeasure/fetch.sh` (pinned tarballs + sha256 into
`build/zipmeasure/`, gitignored), then `tools/zipmeasure/run.sh` (builds the
three binaries, runs each — all must print OK — and prints the size table).

## What gets built

- `zt-baseline` — the substrate both candidates share: libc runtime + zlib +
  a stdio frontend doing a deflate/inflate file round-trip. Lib-attributable
  size = candidate binary − this.
- `zt-libzip` — libzip 1.11.4, the COMPLETE library (upstream's full CMake
  source list; deflate only, no crypto/bzip2/xz/zstd backends), plus a
  frontend that creates a 3-member zip (text, 4K pseudo-random binary, a
  stored pre-compressed payload), reopens it and verifies every member
  byte-identical. `zipconf.h`/`config.h` are hand-generated for the ILP32
  wasm target; `zip_err_str.c` is generated from zip.h/zipint.h by the same
  regex CMake uses.
- `zt-libarchive` — libarchive 3.8.1 cut to the set we would ship: zip
  read+write, tar read, ustar+pax write, gzip filter both ways, plus the
  archive_write_disk extraction seam (what a vendored bsdunzip drives). The
  by-code/by-name dispatch tables (`archive_read_support_format_by_code.c`,
  `archive_write_set_format.c`, …) are EXCLUDED — they reference every
  format in the tree and would pull the whole world in; `la_shim.c` carries
  the one small utility function that lives in an excluded table TU.
  Same round-trip frontend, libarchive API.

## Results (2026-07-28, this harness, gzip -9)

| binary | raw bytes | gzip -9 |
|---|---|---|
| baseline | 78,973 | 32,435 |
| libzip | 181,111 | 70,461 |
| libarchive (no disk writer) | 357,259 | 128,619 |
| libarchive (+ write_disk, as committed here) | 381,425 | 136,494 |

Lib-attributable (candidate − baseline): libzip **102 KB raw / 38 KB gz**;
libarchive **278 KB raw / 96 KB gz** (302/104 with the disk writer). The
candidates differ by **~58 KB compressed** (66 with the disk writer) — inside
the ruling's ~100 KB noise band; see the ticket for the resulting call.

Control worth keeping: adding the two disk-writer TUs UNREFERENCED grew the
binary by 24 KB raw, so the linker does NOT drop unreferenced TU functions —
these numbers price the TU set you ship, not the calls you make. The libzip
number is its complete library; the libarchive number is already the cut-down
set, so the comparison leans in libzip's favor, and libarchive still lands
inside the noise band.

## libc gaps found (matter for the real vendoring, todos/0350/0351)

- `strcasecmp` lives in `<strings.h>` and libzip never includes it (expects
  the platform to). `zt-libzip/config.h` pulls it in.
- `umask(2)` and `id_t` are ABSENT from the embedded libc —
  `zt-libarchive/config.h` shims them (no-op umask). The real vendoring wants
  both added to the libc (archive_write_disk uses umask for secure-dir modes).
- Absent but harmlessly config'd around: `gmtime_r`/`ctime_r`/`timegm`/
  `tzset`, `fchdir`/`fstatat`/`openat`/`linkat`, `mkfifo`, `arc4random`
  (libzip falls back to /dev/urandom).
