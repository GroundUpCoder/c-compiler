# #632 — `<git2.h>` linkability: the decision is an honest diagnostic (`__link_hint`), not a require block

The ticket asked which of three remedies `<git2.h>` deserves: (1) a require
block, (2) unshipping the header, (3) an honest diagnostic. The answer is
**option 3, generalized** — a new compiler directive `__link_hint("prefix",
"message")` that any header can carry, with `git2/common.h` as the founding
consumer. An undefined `git_*` symbol at link now reads

    Undefined symbol 'git_libgit2_init' during linking — libgit2 does not
    link automatically: add '#include <git2_srclib.h>' after the git2
    headers (shipped by the 'libgit2' srclib package)

instead of the bare two lines it read before (probe P1, literal).

## The referent set, re-derived from code — the ticket's premise is FALSE

**libgit2 is NOT unlinkable from the in-OS cc, and has not been since #473.**
The ticket (and #498's residual note) missed the existing mechanism:

- `vendor/libgit2/include/git2_srclib.h` is a GENERATED header
  (`tools/mkgit2srclib.js`, #473) carrying a **211-TU** `__require_source`
  block derived from `os/git/bin.json` minus `test_main.c`. `#include
  <git2.h>` + `#include <git2_srclib.h>` compiles, links and RUNS from the
  in-OS cc with no `-I` and no TU list — acceptance-tested on the minimal
  image by `test_gucman_libgit2_e2e.js`, and re-proven on the FAT image by
  this ticket's probe P2 (`P2-OK 1.9.0`, real repository written).
- The cross-dir `-I` problem the kickoff called structural is already solved:
  96 generated same-dir FORWARDER headers materialize libgit2's nine `-I`
  roots as files (quote includes search the includer's dir first).
- `git2_srclib.h` has its own drift gate: `mkgit2srclib.js --check` (run by
  the e2e) fails when the block and `bin.json` disagree. The #623
  literal-list hole does not apply — libgit2 is not in the #498 srclibs
  table and needs no entry in it.
- `vendor/libgit2/lib.json` is an ORPHAN: 32 `src/util` TUs from the old
  stress-test port, consumed by nothing (`grep -rl libgit2/lib.json` over
  json/js finds only itself). It is NOT a gate input and NOT a viable
  source-of-truth for the header (it covers none of the public API).

So the real residual was exactly one gap: `<git2.h>` ALONE — the header a
developer naturally reaches for — died with a bare `Undefined symbol`
that never named `<git2_srclib.h>`. That gap is what this ticket closes.

## The `zlib.h` shadow — answered with probes, both directions

**Which zlib does an in-OS libgit2 TU resolve? Its own `deps/zlib`, by
construction, and provably in practice.** #473 already engineered this:
every `<zlib.h>` angle include in the libgit2 tree was converted to a quote
include resolved same-dir through forwarders chaining to `deps/zlib/zlib.h`
(zstream.c/h carry the comment saying exactly this). The live probe is
sharp: since #498/#631, `/usr/include/zlib.h` carries a require block, so if
even ONE of the 211 required TUs resolved it, the `z/*` TUs would join the
link and duplicate-define against the `deps/zlib` TUs. Probe P2 (fat image,
`/usr/include/zlib.h` present) links clean and runs → zero TUs resolve our
header.

**The collision the shadow implies is real, and it is the reason option 1
lost.** Probe P3: a program including `<zlib.h>` + `<git2.h>` +
`<git2_srclib.h>` fails with `Duplicate definition of symbol 'adler32'`
(+ crc32 etc.) — libgit2's vendored zlib and our `z/*` set cannot coexist in
one link. This is also the negative control proving P2's instrument could
have detected a resolution leak.

## Why not option 1 (require block in `git2.h`) — measured, then rejected

- **Cost**: 211 TUs; 14.4 s host-side (`node compiler.js
  vendor/libgit2/bin.json`), **19 s in-OS** on the fat image (probe P2,
  `date +%s` hush-side, 1-s granularity). Not prohibitive for a git
  program — the opt-in path pays it identically — but auto-require charges
  it to every TU set that merely includes the header.
- **The decisive reason is P3, not cost**: an auto-requiring `<git2.h>`
  makes ANY program that also includes `<zlib.h>` or `<png.h>` fail with
  duplicate definitions even if it never calls a `git_*` function, because
  the two zlib TU sets are different physical paths (require-name dedup
  cannot merge them — the #631 listed-vs-listed lesson, one level up).
  The opt-in header keeps `<git2.h>` composable with the whole `z`-universe;
  auto-require would trade one honesty gap for a worse, less diagnosable one
  (`Duplicate definition of symbol 'adler32'` names neither zlib).
- Unifying libgit2 onto OUR zlib (require `z/*` for its zlib layer) would
  dissolve P3's conflict class entirely, but it is a real project:
  mkgit2srclib's forwarders cannot point outside `vendor/libgit2`, the
  require-name derivation is single-namespace, `os/git/bin.json` and the
  git CLI would recompile against zlib 1.3.2 (deps ships 1.3.1), and the
  git e2es (network legs included) would need a full regate. Surfaced as a
  possible follow-on, deliberately NOT folded into this ticket.

Option 2 (unship the header) was rejected without much ceremony: the header
is the working, tested, documented interface of the #473 srclib package.

## What landed

- `compiler.js`: `__link_hint("prefix", "message")` — top-level directive
  (the `__require_source` grammar family), unioned across TUs at link,
  first-match prefix append on `Undefined symbol` errors, exact-duplicate
  collapse, loud errors on empty prefix/missing argument. Diagnostic-only:
  the `git` package binary is byte-identical under the new compiler
  (measured by payload sha), i.e. zero codegen effect.
- `vendor/libgit2/include/git2/common.h`: the hint (every public git2
  header reaches common.h, so direct `<git2/repository.h>` consumers are
  covered too).
- Tests: `tests/host/test_link_hint.js` (7 legs: prefix scope + control,
  cross-TU, dedup, two malformed-directive reds, and leg 5 pinning the hint
  in the REAL header — the wiring red control, exercised on every
  compiler.js diff) + `==hint` legs in `test_gucman_libgit2_e2e.js` (in-OS:
  bare `<git2.h>` fails naming the fix; non-`git_` undefined symbol in the
  same program stays bare).
- `packages/libgit2.json` 1.9.0 → 1.9.0-2 (payload ships the edited
  common.h, +517 B); `packages/git.json` gains `sourcesVersion: "0.3-2"`
  (the `git-sources` closure carries common.h, +557 B; the git BINARY is
  byte-identical so its own version deliberately does not move).
- `vendor/libgit2/README.md`: the "fails honestly" paragraph.

## `os/image.json` — NO bump, argued from the container

The changed bytes live exclusively in two package payloads. The minimal
(shipped) image bakes no git2 header (`test ! -e /usr/include/git2.h` is a
standing e2e assertion) and no libgit2 binary; the compiler change is
codegen-neutral (git binary sha unchanged), so no minimal-baked artifact
moves. Fat-image delta is fold-only — the #615 precedent (fat-fixture-only
delta, no bump). #467/#631 rule applied: bump only when a minimal-baked
artifact provably changes bytes.

## Incidental finding (not mine, filed separately)

`packages/quake` payload sha drifts on EVERY mkpkg build with zero input
change: `vendor/quake/src/host.c`/`host_cmd.c` embed `__TIME__` (the Quake
build banner), so the compiled wasm differs per build — reproduced with the
UNCHANGED HEAD compiler (two consecutive builds differ at the same offset).
This falsifies mkpkg's "deterministic payloads" claim for quake and causes
spurious republishes. Filed as its own ticket; deliberately not fixed here.
