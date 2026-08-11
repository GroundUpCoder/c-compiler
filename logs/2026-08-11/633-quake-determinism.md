# #633 — quake payload sha drifted every build: `__TIME__` in the banner

## The bug

Two consecutive `node compiler.js vendor/quake/bin.json -o out.wasm` runs of an
unchanged tree produced different wasm bytes. Reproduced literally:

```
fcd8c502a8a3…  /tmp/q633-a.wasm
be519a4ab5f2…  /tmp/q633-b.wasm
/tmp/q633-a.wasm /tmp/q633-b.wasm differ: char 477760
```

The differing region is the classic Quake build banner — `xxd` at the diff
offset shows `Exe: 10:28:29 Aug 11 2026` vs `Exe: 10:28:34 Aug 11 2026`.
`host.c` (Host_Init) and `host_cmd.c` (Host_Version_f) both print
`"Exe: "__TIME__" "__DATE__"\n"`, so every compile baked the wall clock into
the data segment. Consequence: mkpkg re-published a "changed" quake payload
with zero input change — the tar layer was already deterministic (mtime 0,
fixed gzip); the drift was in the compiled bytes it wrapped.

## The fix (option 1 of the ticket's two)

Both sites pinned to the fixed string `"Exe: xx:xx:xx xx/xx/xx"`, tagged
`// PATCH:` and recorded in `vendor/quake/README.md`'s Changed-files table.

What decided option 1 over a compiler-level `__TIME__`/`__DATE__` determinism
flag: a sweep of the whole vendor estate (`grep -r '__TIME__\|__DATE__\|
__TIMESTAMP__' vendor/ os/ packages/` + gucos-packages src) found **quake is
the only offender**:

- `vendor/tcc/*` — tcc *implements* the macros for programs it compiles
  (`tccpp.c:3306` generates the string at tokenization time); tcc's own
  compiled bytes carry no timestamp. Not a determinism issue.
- `vendor/cpython/Modules/getbuildinfo.c` — already pinned in-TU
  (todos/0340), banner reads `xx/xx/xx, xx:xx:xx`. That patch is the
  convention this one copies.
- gucos-packages, `os/`, `packages/` — zero hits.

A compiler flag is surface for a class of one, and the estate's existing
convention (cpython) is pin-in-the-TU. If a future port lands with wider
timestamp embedding, that's the moment to revisit option 2.

## Verification

- Post-patch, two consecutive compiles are byte-identical
  (`b5e3ba1d6eb3…` both, `cmp` clean).
- mkpkg level, non-vacuously: mkpkg's reuse gate is mtime-based
  (`tools/mkpkg.js:917`), so a plain second build reuses without recompiling —
  that alone would prove nothing. Forced a genuine recompile with
  `touch vendor/quake/src/host*.c`: mkpkg rebuilt (`quake 1.09: building… 2.5s`)
  and landed on the identical payload
  (`quake_1.09_a6f6fbf9cf19381d.pkg.tar.gz`); the full 87-package `index.json`
  is byte-identical across builds (`diff` clean). Pre-patch, this recompile
  path is exactly what flipped the sha every build.

## No image bump — the container argument

quake is `packages/quake.json`, a gucman package: zero references in
`os/image.json`, and prod (`groundupcoder.com/os/image.json`, checked live)
is at **v256** with `defaultPackages: doom, gcode, calc, paint` — quake is not
a member. `newestBakeInput`'s closure is the toolchain + os/ tree + *the
manifest's* vendor closure, which quake is outside of, so the system blob's
bytes don't change and nothing gates on `image.json version` (tree already at
257, unshipped). The fat (`--packages=all`) test fixture picks the new payload
up through the Node-side mtime gates; no version bump involved.
