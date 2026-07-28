# 0343 — vendor libbz2 so CPython's `bz2` (and `tarfile`'s bz2 leg) imports

- **Status**: open
- **Provenance**: **jku instruction** — `~/git/meta/meta/notes/jku-RULING-queue-stdlib-ports-bz2-lzma-curses-tkinter.md`
- **Blocked by**: `0340` (CPython vendor tree + expanded inittab)
- **Sibling**: `0344` (lzma). **Together these two complete `tarfile`.**

## Goal

Add a `vendor/bzip2/` port and build CPython's `_bz2` static extension against
it, so `import bz2` succeeds on `cpython-clang` instead of raising
`ModuleNotFoundError`.

## What is established (measured, not assumed)

`todos/CPYTHON.md:161` records `_bz2` and `_lzma` as **OUT** with the cause
*"no libbz2/xz vendor. Vendoring either is a normal small port if demand
appears."* Verified 2026-07-28: `vendor/` holds no `bzip2` directory. The
existing `vendor/zlib` is the shape to copy — it is already the reason
`tarfile`'s **gzip** leg works today.

⭐ **Why this pairs with `0344`.** `tarfile` itself imports and its gzip leg
works. Its **bz2 and xz legs are the only missing ones**, so `0343` + `0344`
together take `tarfile` from partial to complete. Either alone leaves a
`tarfile` that still fails on a `.tar.xz` or `.tar.bz2`. Sequence them
adjacently and say so in both close-outs; do **not** claim "tarfile works" on
landing only one.

## Why this is the small one

bzip2 is a single-purpose compressor with no configure-time platform probing
worth the name (~8 C files, no threads, no dlopen, no networking). It is the
cheapest of the three ports jku queued, which is why it is first.

## Plan

1. `vendor/bzip2/lib.json` following `vendor/zlib`'s structure exactly — do not
   invent a new vendoring shape.
2. Add `_bz2` to the CPython inittab / `Modules/config.c` expansion that `0340`
   builds, alongside the extensions it already turns on.
3. Record the resulting binary size delta and the new import count against
   `0340`'s measured baseline.

## Acceptance

- `cpython-clang -c "import bz2; print(bz2.compress(b'x'*1000)[:4])"` runs in-OS
  (not only host-side) and round-trips through `bz2.decompress`.
- The stdlib import sweep count rises from `0340`'s landed figure by the
  `bz2`-dependent set; state the **before and after numbers**, not "improved".
- `cpython-clang -c "import tarfile"` still imports (regression check).
- Binary-size delta reported in bytes. CPython ships as a **gucman package,
  never baked**, so this costs the base image **zero bytes** — say so
  explicitly rather than leaving a size number to look alarming.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry, the gate goes RED — re-anchor or
  retire it in the same commit. If your work leaves a gap, file a ticket AND a
  register entry; a gap that does not enter `todos/` does not exist.
- Touching `vendor/` forces an image rebake ⇒ **full gate + an `os/image.json`
  bump, which the master assigns.** Executors never touch `os/image.json`.
