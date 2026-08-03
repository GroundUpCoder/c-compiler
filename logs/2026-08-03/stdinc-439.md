# #439 — the C standard library is readable in-OS (baked /usr/include + libc-sources)

jku's ask (P0, manually promoted): an in-OS agent that compiles
`#include <stdio.h>` had **no file to read** — `/usr/include/stdio.h` did not
exist. The ruling: bake ALL headers into the base image; the `.c`
implementation units ship as a separate `-sources`-convention package.

## What landed

**`foldStdlibHeaders(manifest, CompilerJS)`** (os-common) plants the
compiler's MERGED builtin-header map — `standardHeaders` plus libc-ext.js's
`.h` entries, read through `createDefaultPPRegistry()` — as inline `content`
entries at `/usr/include/<name>`. It folds inside `bakeSystemImage`, the one
bake choke point, so mkimage, boot.js and the in-worker browser fallback all
agree, and the MINIMAL image carries the headers (the acceptance is a VIRGIN
boot, no install step). 83 headers, 198,341 B raw: 78 builtin + 5 ext
(`regex.h fnmatch.h glob.h locale_impl.h tre.h` — the whole `.h` side of
`EXT_LIB_MAP` merges into the includable surface, so all of it bakes; the
ticket's "3 public headers" undercounted by the two internal shims).

**`libc-sources`** is a third `sourcePackageDefs` derivation (kind
`'builtin'`): the 26 builtin `.c` units + 6 ext `.c` (TRE/musl) + the 83
headers, all generated `content` entries, landing at `/usr/local/src/libc`
per the #407 convention. `opts.CompilerJS` is REQUIRED — a call site that
forgets it fails loud rather than silently shrinking the index by one unit.

## Why generated, never hand-copied (hazard 1)

Builtins resolve BEFORE any filesystem include path by design (compiler.js,
"System include dirs": only an explicit `-I` may shadow a builtin). So the
planted files are **documentation of the compile surface, not the compile
input** — if they drifted from the literal map, an agent would read a
confident lie. Generation from the live map at bake time makes drift
structurally impossible in a fresh bake; the kernel e2e's full-set sha256
equality (every map entry present, byte-equal, NOTHING extra) is the gate
against a stale image. A merged map missing the ext headers **fails the bake
loudly** — the compiler treats libc-ext.js as optional, but a bake that
proceeded without it would ship an environment-dependent `/usr/include`.

## Collisions (hazard 2)

The fold claim()-throws on any pre-existing entry, file OR derived dir path
(a package srclib symlink top squatting `/usr/include/sys` would otherwise
be silently replaced by `seedEntries`' unlink-then-symlink). Verified
disjoint against every shipped package def's include tops (explicit files
AND `tree` expansions — win32's `windows.h` set rides a tree entry that a
naive `files` scan misses).

## Numbers (measured)

- Minimal image v225: **15,760,208 B** vs the v224 production baseline
  **15,672,112 B** (reproduced byte-exact from main before editing) =
  **+88,096 B**, 0.84 % of the 10,542,288 B headroom under the
  26,214,400 B cap. (Delta < raw content: the v224 blob carried allocator
  slack the new files partly filled.)
- libc-ext.js joins `newestBakeInput` — its `.h` entries are bake CONTENT
  now, so an `ext/` regeneration restales fixtures.

## Tests

- `tests/host/test_stdinc_fold.js` — fold mechanics: exact-set byte
  equality, parent-first dirs, both collision throws, all-packages
  coexistence, missing-ext loudness.
- `test_source_packages.js` — builtin-derivation legs (byte-equal vs both
  literal maps, inputs, loud no-CompilerJS).
- `tests/kernel/test_stdinc_e2e.js` — virgin minimal boot: full-set sha256
  equality over `find /usr/include -type f`; fat image agrees (srclib tier
  coexists); `gucman install libc-sources` and in-OS sha256 of `.c` units
  vs the maps. Gotcha: busybox `find` does not traverse a symlink argument
  even with a trailing slash — count at the payload root, not through
  `/usr/local/src/libc`.

Image v224 → v225; the ship is owed and owned by the coordinator.
