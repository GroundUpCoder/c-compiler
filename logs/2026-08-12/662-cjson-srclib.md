# #662 — cJSON as a standalone srclib package

cJSON (1.7.19, one TU, zero deps) joins the reusable source-library tier:
`gucman install cjson` plants `/usr/local/include/cJSON.h` +
`/usr/local/src/cjson`, and a bare `#include <cJSON.h>` links the parser
from the in-OS cc. epic:pkgdev (declare a dependency instead of vendoring a
parser) + epic:gamedev (JSON is the default game config/save/asset format).

## Shape (the #661 conventions, no second pattern)

- `vendor/cjson/lib.json` — `type: lib`, `srcRoots {cjson: .}`, one source.
- `packages/cjson.json` — the giflib shape: header `bin` entry + whole-dir
  `tree` with `exclude: [lib.json, LICENSE, README.md]` + top-level LICENSE.
- `vendor/cjson/cJSON.h` tail grows the `__require_source("cjson/cJSON.c")`
  block behind `CJSON_NO_REQUIRE_SOURCES` (the FT_NO_REQUIRE_SOURCES of this
  library).
- ONE registration: the `SRCLIB_TABLE` row in `os/os-common.js`. The #661
  derivation (`srclibDriftPackages`) makes tools/mkpkg.js and
  tools/win32ports.js --check adjudicate the drift gate from that row — the
  ticket's "register in BOTH hardcoded places" criterion was written before
  #661 landed and is stale; there is no second list (verified: the only call
  site is mkpkg.js:862 reading the derived set).

## Consumers converted to the dep route

gucman, gcode, software, deck, deskdefaults all listed
`vendor/cjson/cJSON.c` + a `-I` by hand. All five now dep on
`vendor/cjson/lib.json` (srcRoots resolves the require to the same path;
the explicit listing and the include entry are gone). All five verified by
host `buildProject` compiles. The `-sources` closures still carry
`vendor/cjson/cJSON.c` — the closure walks `deps` — so the
`test_source_packages.js` pins hold unchanged.

`os/gcode/build-native.sh` (real clang, the reference oracle) passes
`-DCJSON_NO_REQUIRE_SOURCES`: `__require_source` is this compiler's
keyword, and clang links the explicitly listed cJSON.c.

## Drift-gate coverage PROVEN, not assumed

A green build is not evidence of coverage; a refused build is. Sequence
(scoped `mkpkg --packages-dir` with only cjson.json, temp out dir):

1. green: `cjson_1.7.19_*.pkg.tar.gz` built, exit 0;
2. drifted the require to `cjson/cJSON_drifted.c` → mkpkg exit 1:
   `package 'cjson': require-block drift` naming BOTH the missing
   `cjson/cJSON.c` and the stray drifted name;
3. restored → exit 0 again.

## Test

`tests/kernel/test_cc_cjson_e2e.js` (registered; PKG class derived from its
`ensureMinimalImage` call): fat image parses/mutates/round-trips a
non-trivial document (serialize → re-parse → re-serialize byte-identical),
`-DCJSON_NO_REQUIRE_SOURCES` is the red control (link error naming a cJSON
symbol), os-release `PACKAGES=` carries cjson; minimal image fails clean,
`gucman install cjson` from the served index plants both tiers and the same
program runs. 9/9 on first run.

## Misc

- `os/doc/toolchain.md` auto-link table grows the `<cJSON.h>` row — baked
  base-image content, so image.json bumps 259 → 260 (the #661/d4dae738
  precedent).
- Gotcha: `os/os-common.js` contains a byte that makes BSD grep treat it as
  binary — plain `grep srclib os/os-common.js` prints NOTHING on a file
  where `grep -a` finds 40 hits. Positive-control your greps.
