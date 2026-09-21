# 0231 — busybox bake off_t assert

- **Status**: done (2026-07-17) — 121f32d; __attribute__ un-swallowed under __wasm__ + 64-bit uoff_t; cold mkimage bakes again, gated with 0229
- **Design**: vendor/busybox/README.md patch table (`src/include/libbb.h` row)

## Goal

Fresh bakes at HEAD were BROKEN: every busybox TU failed with
`libbb.h:335: declared as an array with a negative size (-1)`. The 0227/G22
parser change (6970269, "diagnose negative array sizes") started diagnosing
busybox's `BUG_off_t_size_is_misdetected` compile-assert — which has been
legitimately FIRING all along: the port builds with `CONFIG_LFS` off, whose
upstream branch assumes `sizeof(off_t)==sizeof(long)` (4 on ILP32), but this
libc's `off_t` is `long long` (8). `uoff_t` was 4-byte against an 8-byte
`off_t`, and `OFF_FMT "l"` popped 4 bytes of an 8-byte printf vararg (a
latent large-file formatting bug in ls/dd/tar/cksum/…). The old compiler
accepted `char x[-1]` silently, so the assert never bit.

It escaped the 0227 gate because no suite REBUILDS busybox on a fresh tree:
the image-fixture staleness check compares mtimes, and the prebaked fixture
was newer than compiler.js's checkout mtime — the diff→suite mapping has no
"does mkimage still bake from cold" leg.

## Plan

- Patch the vendored fork (the README patch-table convention): a `__wasm__`
  branch in libbb.h's !LFS `uoff_t` block typedefs `uoff_t` as
  `unsigned long long` and switches `XATOOFF`/`BB_STRTOOFF`/`STRTOOFF`/
  `OFF_FMT` to the long-long family — exactly what the assert wanted, and
  fixes the vararg mismatch as a bonus. (Alternative rejected: flipping
  `CONFIG_LFS=y` regenerates autoconf.h and flips code paths across all 81
  applets for the same net effect.)
- Landed with the 0229 gate (which forced the cold rebake that exposed it).

## Acceptance

- `node tools/mkimage.js` bakes from cold (busybox recompiles cleanly).
- Kernel suite green (busybox is pid 1 + coreutils — every e2e exercises it).
- Follow-up idea recorded: a cold-bake tripwire so a compiler change that
  breaks a vendor build can't hide behind a fresh fixture again.
