# 0350 step 1 — libarchive vs libzip, measured (the call: libarchive)

The decider pre-committed the tie-break (libarchive unless libzip's NET
compressed image delta wins by >1 MB; within ~100 KB = noise = libarchive), so
the lane's whole job was to make the measurement decisive rather than
indicative. Method + numbers live in `tools/zipmeasure/README.md` and the
ticket; the call is **libarchive** — the compressed per-binary gap is ~58 KB
(66 with the disk-writer seam), inside the noise band, and even the
two-separate-binaries worst case (~132 KB) is nowhere near 1 MB.

Decisions and gotchas worth keeping:

- **Both candidates really build and run on our compiler today.** libzip
  1.11.4 (complete source list) and libarchive 3.8.1 (zip r/w + tar r +
  ustar/pax w + gzip + write_disk) each compile against `vendor/zlib`, create
  a zip, and round-trip it byte-identical under `node host.js`; the system
  `unzip` reads both outputs. No compiler bugs surfaced — the whole exercise
  was config-header archaeology, not codegen work.
- **The linker does not tree-shake unreferenced TU functions.** Adding
  archive_write_disk_posix.c UNREFERENCED grew the wasm by 24 KB. So image
  cost is decided by which TUs you vendor, not which functions you call —
  and libarchive's by-code/by-name dispatch tables
  (archive_read_support_format_by_code.c, archive_write_set_format.c,
  archive_write_add_filter.c, archive_read_append_filter.c,
  archive_read_set_format.c) reference EVERY format in the tree, so they must
  stay out of the vendored set. One small utility function
  (`__archive_write_entry_filetype_unsupported`) lives inside an excluded
  table TU; the harness carries it as `la_shim.c` — the real vendoring should
  patch the table file down instead and record it in the patch table.
- **"Subsume gucman's tar+gz" flips sign under static linking.** The ruling
  framed subsumption as a credit; in a statically-linked image, gucman
  adopting libarchive grows gucman by ~100 KB raw to shed ~150 lines (~2–3 KB)
  of bespoke extractor, and zlib stays for sha256/inflate either way.
  Recorded in the ticket: don't fold gucman in while linking is static; the
  consolidation argument becomes real only with a shared-library story.
- **libc gaps for 0351:** `umask(2)` and `id_t` don't exist in the embedded
  libc (write_disk wants umask); libzip needs `<strings.h>` for strcasecmp;
  gmtime_r/timegm/tzset/fstatat/openat/mkfifo absent but cleanly
  config'd around.
- The harness is committed (`tools/zipmeasure/`), with pinned sha256 fetches
  into gitignored `build/zipmeasure/` — `fetch.sh` + `run.sh` reproduce the
  table in one command each. This is deliberately step-1 only: no vendor/
  tree, no image.json touch (master assigns bumps), no heavy-lock gates.
