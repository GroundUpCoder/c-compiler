# 0354 — newestBakeInput misses non-dep sources (vendor/cjson) so the freshness gate under-invalidates

- **Status**: open
- **Priority**: P0 (correctness bug in the shipped 0082 freshness gate)
- **Difficulty**: light
- **Design**: this file. Found by todos/0318 while deriving the vendor→suite map.

## Goal

The 0082 input-freshness gate (`newestBakeInput` in `os/os-common.js`) is the
estate's answer to "is this blob/fixture stale?". Its contract, stated in its
own header comment, is *"the newest mtime across everything that can change the
system blob's bytes"*.

It does not meet that contract. `addProject` expands a project through its
**`deps`** only:

```js
(proj.deps || []).forEach(function (d) { addProject(dir + '/' + d); });
```

and separately walks the project's **own directory**. A source file pulled in
from outside the project directory by a `sources`/`includes` entry — rather
than by a `deps` project reference — is therefore in neither set.

`vendor/cjson` is exactly that shape. It has no `bin.json` of its own; five
seeded projects compile `../../vendor/cjson/cJSON.c` directly:

- `os/gucman/bin.json`, `os/win32/software.json`, `os/deck/bin.json`,
  `os/gcode/bin.json`, `os/deskdefaults.json`

So an edit to `cJSON.c` changes the bytes of five baked binaries while leaving
every gate that consults `newestBakeInput` believing the blob is fresh: a
same-version blob baked before the edit is silently reused by `boot.js`,
`serve.js` and `tests/lib/image-fixture.js`. That is the precise failure the
0082 gate was built to prevent, and it is the failure mode the header comment
tells the reader is handled.

Note the mirror-image case is already handled deliberately: `os-common.js`
scans `packages/` and each package's project closure *unconditionally*,
with a comment explaining that over-invalidation is the cheap direction.
The same reasoning applies here.

## Plan

1. Extend `addProject` to also enrol a project's `sources` and `includes`
   entries that resolve OUTSIDE its own directory — `statFile` for a file,
   `walk` for a directory, reusing the existing `normalize()` + `seenDirs`
   memoisation so the scan stays linear and cycle-safe.
2. Confirm the fix against the shape that motivated it: touching
   `vendor/cjson/cJSON.c` must make a freshly baked blob read stale.
3. Sweep for other instances rather than fixing only cjson — any project
   whose `sources` reach outside its directory has the same hole. Grep
   `os/**/*.json` and `vendor/**/bin.json` for `"../` entries under
   `sources`/`includes` and check each against the closure.
4. `vendor/cjson` currently carries a `kernel`+`sweep` rule in
   `tests/run.js` derived from its *real* blast radius, plus a comment
   naming this ticket (register entry **L44**). When this lands, re-check
   whether that comment should be retired and retire L44 with it.

## Acceptance

- A probe that instruments `newestBakeInput`'s fs access reports
  `vendor/cjson` inside the bake-input closure (it currently does not —
  the closure holds 25 of 37 vendor dirs, and cjson is not one of them).
- Touching `vendor/cjson/cJSON.c` restales a just-baked `os/os-system.img`
  by the same predicate `tests/lib/image-fixture.js` uses.
- Step 3's sweep is recorded in this file: either "no other project's
  sources escape its directory", or an entry per instance found.

## Step 3 sweep — recorded (2026-07-28)

Every `*.json` under `os/`, `vendor/` and `packages/` was expanded and each
`sources`/`includes`/`srcRoots`/`-I` entry resolved against its own directory
(`buildProject`'s normalize rule). **22 projects reach outside their own
directory.** Grouped by target:

- **`vendor/cjson`** ← `os/gucman/bin.json`, `os/gcode/bin.json`,
  `os/deck/bin.json`, `os/deskdefaults.json`, `os/win32/software.json`
  (all five: `sources` + `includes`)
- **`os/win32/wwinmain.c`** ← `vendor/winmine`, `vendor/notepad`, `vendor/calc`
- **`vendor/freetype/{demo,include}`** ← `os/ksvc`, `os/term`, `os/win32/lib.json`,
  `os/win32/menucore.json`, `vendor/cairo`, `vendor/sent`, `vendor/magicpoint`
  (×2), `vendor/netsurf/gucos`, `vendor/freetype/{demo,sdl-demo}`
- **`vendor/libpng`, `vendor/giflib`, `os`** ← `vendor/magicpoint` (×2),
  `vendor/sent`, `os/gucman`
- **`vendor/libgit2/**`** ← `vendor/fakegit` (172 sources + 10 include dirs)
- **`vendor/zlib/src`, `vendor/netsurf/{shim,netsurf}`** ← the three netsurf
  projects
- no project's `srcRoots` escapes its own directory.

Measured against the FAT manifest (`foldPackages(…, 'all')` — what
`tests/lib/image-fixture.js` bakes), the fix enrols **exactly three new files**:
`vendor/cjson/{cJSON.c,cJSON.h,LICENSE}` (5652 → 5655 files stat'd, 24 → 25
top-level vendor dirs, scan 45 → 61 ms). Every other escaping target was
already inside the closure because the project also `deps` on a lib.json in the
same tree — i.e. **`vendor/cjson` was the only live instance**, and it was live
five times over. The rule is now enforced generally, not patched for cjson:
`tests/host/test_bakeinput_sources.js` re-derives the closure independently and
fails on any future project whose inputs escape unenrolled.

`tools/mkpkg.js`'s `newestPkgInput` carried the identical `deps`-only hole and
is fixed with the same shared helper (`COMMON.projectExternalDirs`). It is a
no-op on today's package set (the escaping targets there are freetype/libpng/
os/win32, all already walked as deps) and — checked deliberately — does **not**
widen that gate's documented narrow scope: no packaged project's external dirs
reach the `os/` tree at large.
