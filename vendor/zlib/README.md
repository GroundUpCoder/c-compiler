# zlib

Vendored from upstream [madler/zlib](https://github.com/madler/zlib) tag
[v1.3.2](https://github.com/madler/zlib/releases/tag/v1.3.2)
(February 17, 2026).

This is the first release after the 7ASecurity audit of zlib.
All source files are unmodified from the upstream tag.

## Structure

- `src/` — all `.c` and `.h` files from the upstream root
- `tool/` — zip/unzip command-line tool built on zlib
- `tests/` — demo and golden test files

## What's included

Only the source files (`*.c`, `*.h`) and LICENSE are kept from the upstream
tarball. Build system files (configure, CMakeLists.txt, Makefiles, Bazel),
platform directories (win32, amiga, msdos, os400, qnx, watcom), docs, contrib,
examples, and tests are omitted — our `project.json` handles the build.

## What's compiled

Of the 15 `.c` files, 10 are compiled (see `project.json`). The 5 omitted are:
- `gzclose.c`, `gzlib.c`, `gzread.c`, `gzwrite.c` — gz* file I/O wrappers
  (need POSIX fd operations not relevant to our use case)
- `infback.c` — specialized streaming inflate API (inflateBack)
