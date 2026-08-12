# #663 — Lua + SQLite as linkable source libraries

Lane: lane/663, baseline main `59ba3395`. Both trees shipped shell-only
packages; this promotes each to a srclib so the in-OS `cc` links the library
from a bare `#include <lua.h>` / `#include <sqlite3.h>` — no `-I`, no TU
list. epic:pkgdev (the reusable-dependency promise) + epic:gamedev (Lua =
game scripting, SQLite = save/asset store).

## The (a)/(b) ruling — ONE package owns the name (a); the -dev split is rejected

The ticket demanded an explicit decision: extend the existing `lua` /
`sqlite3` packages with a `srclib` block (a), or mint `lua-dev` /
`sqlite3-dev` (b). Re-measured on `59ba3395` (JSON-parse of top-level keys,
not a text grep — `"bin"` also appears as a file-source kind inside `files`,
which a grep counts falsely): 44 packages, 12 with top-level `srclib`, 31
with top-level `bin`, intersection EMPTY, zero `*-dev` names (the `*lib*`
glob returns 7, so the instrument fires). So both options were new shapes:
(a) mints the first bin+srclib package, (b) mints the first `-dev` split.
The ruling is **(a)**, applied identically to both libraries:

1. **The disjointness is provenance, not design.** Applications were
   packaged in one campaign (todos/0417/0418), libraries promoted in
   another (#464/#498/#661/#662). No rule anywhere in mkpkg, gucman, or
   os-common keys on the combination — the drift gate reads `pkg.srclib` +
   `files`, gucman plants `bin`/`srclib`/`menu`/`openwith` tiers
   independently from one definition. Verified by building and installing:
   nothing objects.
2. **It dissolves the plant-ownership question instead of answering it.**
   gucman refuses to overwrite an existing plant, so under (b) the ticket's
   "install in either order" acceptance is a real hazard to engineer
   around; under (a) there is no second owner, so there is nothing to
   collide. #661's actual precedent — one package owns the plant,
   consumers declare `deps` — generalizes to: **the package that owns the
   NAME owns everything planted under it.**
3. **The -dev split solves a problem this system does not have.** It is a
   binary-distro economy (headers cost space beside a shared .so). Here
   the library IS its sources, payloads dedup through the
   content-addressed pool, and the shells are small. The split would buy
   naming-convention breakage (all 12 srclib packages are plainly named)
   plus permanent double bookkeeping.

Cost accepted with (a): sources-only or shell-only installs don't exist —
`gucman install lua` is ~380 KB, `sqlite3` ~3.1 MB; negligible. Precedent
for the next case: when a vendored tree ships an application and a
same-named linkable library, extend the ONE plainly-named package.

Consequence for acceptance: "install order both ways" is satisfied **by
construction** (one package). The e2e instead proves the shape's real
contracts: ONE install plants bin+include+src together, `gucman remove`
unplants all three, reinstall restores them.

## Lua: the ABI trap, and why luaconf.h is patched

`bin.json` passed `-DLUA_USE_C89`. That define is ABI-visible:
`LUA_C89_NUMBERS` makes `lua_Integer` `long` (32-bit under ILP32) instead
of `long long`. A flagless in-OS consumer (`cc app.c`) would compile
against 64-bit `lua_Integer` while the required library TUs (also
flagless) got… whatever they got — the config MUST live where every TU
sees it. So `luaconf.h` now pins `LUA_USE_C89` in-header (guarded
`#if !defined`), which upstream's own header comment endorses for
ABI-affecting config, and the `-D` left `bin.json`. The e2e pins
`sizeof(lua_Integer)==4` from a flagless consumer as the regression
instrument.

Lua was vendored verbatim until now; the README gained a patch table
(lua.h require block, luaconf.h pin). `lib.json` owns the 32 library TUs
(everything but `lua.c`, the shell main), `includes`, and
`srcRoots {lua: src}`; `bin.json` became `deps:["lib.json"]` +
`src/lua.c` (the libpng bin.json shape). The require block in `lua.h`
path-identity-dedups in project builds via the srcRoot.

## SQLite: in-file config instead of a shim TU

The amalgamation needs 8 `-D` flags (SQLITE_WASI etc.) to build here. The
srclib pull is flagless, so the same set now lives at the top of
`sqlite3.c`, every entry `#ifndef`-guarded — command-line flags stay the
authority when present (bin.json, cpython's bin.json, and clang-simplified's
image manifest all pass the identical set; verified). A shim TU
(`sqlite3_srclib.c` with defines + `#include "sqlite3.c"`) was considered
and REJECTED: vendor/cpython compiles `../sqlite/sqlite3.c` explicitly (so
does the cpython-clang manifest, which derives sources from the same
bin.json), and a shim's require name would NOT path-dedup against that
listed TU — it would compile the engine twice. With the require block
naming `sqlite3/sqlite3.c` directly, `vendor/cpython/bin.json` just adds
`"sqlite3": "../sqlite"` to its existing `srcRoots` (its zlib pattern) and
dedups in both producers. NB the amalgamation inlines its own copy of the
header, so the block in `sqlite3.h` fires only in real consumers.

The native-cc cpython build fails at link (`PyArg_ParseTupleAndKeywords`
conflicting types) IDENTICALLY on pristine main and on this branch —
pre-existing, unrelated, and after the compile phase where this change
acts. The shipped python is cpython-clang; its kernel e2e gates the clang
side.

`sqlite3ext.h` is deliberately not planted: `SQLITE_OMIT_LOAD_EXTENSION=1`
is baked into the config, so the extension API cannot work; planting the
header would advertise it.

## image.json 260 → 261 (argued, not reflex)

The minimal (deployed) image's bytes are unchanged — lua/sqlite3 are
packages, not image entries, and not `defaultPackages`. The bump is owed by
the FAT image, which bakes both packages into `/usr`: the new
`/usr/include/{lua.h,luaconf.h,lualib.h,lauxlib.h,lua.hpp,sqlite3.h}` and
`/usr/src/{lua,sqlite3}` tiers are **user-addressed** bytes (an in-OS
developer's `cc app.c` behavior changes), and a persistent browser OPFS
image only re-fetches on a version bump. #623's no-bump precedent covered
developer-addressed prose inside baked files; this is the other side of
that line. Package versions moved to `5.5.0-2` / `3.53.1-2` so gucman
upgrade carries the change to installed systems independently of any
image deploy.

## Measurements

- In-OS `cc luaembed.c`: **1.20 s**; `cc sqlembed.c` (the 250 KLOC
  amalgamation, IRREDUCIBLE_LOWERING and all): **1.64 s**. The srclib
  path is interactive-speed even for SQLite.
- Drift gate (`requireDriftErrors`): 0 errors with both rows enrolled in
  SRCLIB_TABLE; red-controlled both directions (a dropped lua require line
  and a renamed sqlite require name each fire the exact §4.4 error).
- `tests/kernel/test_cc_lua_sqlite_e2e.js`: 19/19 on first full run
  (3:48 cold, incl. the minimal-blob bake). Fat: both consumers link+run,
  both `-D*_NO_REQUIRE_SOURCES` hatches fail loud at link, both shells
  unchanged. Minimal: honest absence → served-index install → link+run →
  remove unplants bin+include+src → reinstall works.
