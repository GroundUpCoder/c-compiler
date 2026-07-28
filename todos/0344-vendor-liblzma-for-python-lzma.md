# 0344 — vendor xz/liblzma so CPython's `lzma` (and `tarfile`'s xz leg) imports

- **Status**: open
- **Provenance**: **jku instruction** — `~/git/meta/meta/notes/jku-RULING-queue-stdlib-ports-bz2-lzma-curses-tkinter.md`
- **Blocked by**: `0340` (CPython vendor tree + expanded inittab)
- **Sibling**: `0343` (bz2). **Together these two complete `tarfile`.**

## Goal

Add a `vendor/xz/` (liblzma) port and build CPython's `_lzma` static extension
against it, so `import lzma` succeeds on `cpython-clang`.

## What is established (measured, not assumed)

`todos/CPYTHON.md:161` records `_lzma` as **OUT** — *"no libbz2/xz vendor"*.
Verified 2026-07-28: `vendor/` holds no `xz` directory.

## Why this is the moderate one, not another `0343`

**Do not price this as a second bzip2.** liblzma is substantially larger than
bzip2 and carries build-system surface bzip2 does not:

- a **CMake/autotools configure layer** with real platform probing, where
  bzip2 has essentially none;
- **optional threading** in the encoder (must be compiled out deliberately for
  gucOS, not left to a configure default);
- **SIMD / CPU-feature dispatch** paths that must be forced to the portable
  build for wasm;
- a much wider public header surface.

The port is still routine, but the estimate should reflect a configure-layer
port, not a file-list port. **Verify these characteristics against the actual
upstream tarball before estimating** — they are stated here from the general
shape of liblzma, not from a measurement of a checked-out tree, and this ticket
should not be the place a wrong number gets laundered into a plan.

## Plan

1. `vendor/xz/lib.json`, portable build only: threads off, SIMD/CPU-dispatch
   off, encoder+decoder both on (`lzma.compress` is part of the ask).
2. Add `_lzma` to the inittab expansion `0340` builds.
3. Report binary-size delta and import-sweep delta against `0340`'s baseline.

## Acceptance

- `cpython-clang -c "import lzma; print(lzma.decompress(lzma.compress(b'x'*1000)))"`
  runs **in-OS**, not only host-side.
- With `0343` landed: a real `.tar.xz` **and** a real `.tar.bz2` both extract
  through `tarfile` in-OS. That is the joint acceptance the pair exists for —
  neither ticket may claim it alone.
- Stdlib import-sweep count stated **before and after**.
- Confirm threading and SIMD are actually compiled **out** in the shipped
  artifact (check the build flags in the emitted config, do not assume the
  default) — assert on the artifact, never on the exit code.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry, the gate goes RED — re-anchor or
  retire it in the same commit. If your work leaves a gap, file a ticket AND a
  register entry; a gap that does not enter `todos/` does not exist.
- Touching `vendor/` forces an image rebake ⇒ **full gate + an `os/image.json`
  bump, which the master assigns.** Executors never touch `os/image.json`.
