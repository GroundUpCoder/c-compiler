# #473 — libgit2 as a gucman `srclib` package

jku, P0, queued by explicit reorder: *"I want to get to a point where gucOS can
do work independently on its own. To that end I'm thinking I want git working."*
The deliverable is his sentence — `gucman install libgit2`, then an in-OS `cc`
links a real git program against it, exactly the way libpng already works.

Branch `ticket-473`, worktree, base `481421fb`.

## Step 1: the premise reproduced

The ticket rests on a router-thread measurement that four build flags
(`--allow-old-c`, `-Dvolatile=`, `--allow-undefined`, `-DNO_STRNLEN`) are stale.
Re-run at my base tip: `vendor/fakegit/bin.json` with all four removed builds to
**1,508,417 bytes, sha256 `ff6eed11…`, exit 0, zero diagnostics — byte-identical
to the baseline.** (The ticket recorded 1,508,771 from a different tip; the
identity comparison is what matters and it holds.) Premise confirmed.

Ablating the remaining 14 one at a time then found **two more** stale flags:
`-DHAVE_LONG_LONG=1` (no reference anywhere in the tree) and `-DPCRE2_STATIC`
(byte-identical without it). The other 12 each fail the build when removed —
`-DNO_MMAP` alone costs `_SC_PAGE_SIZE` in `unix/map.c`, and dropping
`-DPCRE2_CODE_UNIT_WIDTH=8` costs 90 errors. So the honest count is **6 flags of
cruft, 12 of real configuration**, not 4 and 14.

## The shape of the problem

`srclib` sections accept only `include` and `src` — `validateSrclibShape`
throws on anything else and the shape is enforced in three places. So a source
library can carry **no compiler flags at all**. That is one constraint. The
second, which the ticket does not mention and which turned out to be the larger
one, is that libgit2's build also wants **nine `-I` roots**, and the srclib
model offers exactly ONE ambient header tier. libpng needs neither (it ships a
pre-generated `pnglibconf.h` and a flat source dir), which is why it looked easy.

Both had to be answered inside the source tree, or the in-OS `cc` would compile
different code from the host build.

### Answer 1 — configuration moves into headers

- `git2_features.h` gains `NO_MMAP` and the three caller-visible PCRE2 API
  macros (`PCRE2_CODE_UNIT_WIDTH`, `PCRE2_STATIC`, `PCRE2_EXPORT`), which
  `src/util/regexp.h` needs before it reads `pcre2.h`.
- **`deps/pcre2/config.h` is now a real, hand-written file** — the one
  CMake/autoconf generates from the `config.h.in` this tree deliberately does
  not vendor. That is upstream's own mechanism, restored. The single upstream
  edit is two lines in `pcre2_internal.h` defining `HAVE_CONFIG_H`, because
  upstream expects a build system to pass `-DHAVE_CONFIG_H` and there is none.
- `bin.json` / `lib.json` / `feature_probe.json` now carry **zero**
  `compilerArgs` and one `-I include`.

⚠️ **`features.h` is dead** — nothing in the tree includes it. It shares the
include guard `INCLUDE_features_h__` with `git2_features.h` and has a
near-identical body, including the `#define NO_MMAP 1` that would have made
this step a no-op. It did not, because `git2_util.h` includes
`git2_features.h` and only that. Recorded in the README with a warning marker;
deleting it is out of this ticket's scope.

### Answer 2 — the `-I` search path becomes files

`tools/mkgit2srclib.js` materializes the nine roots as **96 one-line forwarder
headers**: for every (directory, include name) the build cannot resolve
same-dir, it writes that directory a `#include "<rel>/<name>"`. Quote includes
search the including file's own directory first, so a forwarder wins with no
flags — in the host build and the in-OS build alike. **One resolution path, not
two**, which is the property that makes the package trustworthy.

The set is derived from the COMPILER, not from a regex scan: build, read the
"Could not find include file" diagnostics, emit, repeat until clean (3 passes).
An include inside an inactive `#if` never gets a forwarder. A missing forwarder
is not silent either — `bin.json` no longer passes the `-I` roots that used to
hide one, so `fakegit`/`projects` goes red.

The alternatives considered and rejected: putting libgit2's ~150 internal
header names (`str.h`, `vector.h`, `util.h`, `config.h`, …) on the *public*
include tier (indefensible, and `config.h`/`util.h` would collide with the next
package to want them); and merging the source dirs into one flat payload dir
(impossible anyway — a package `files` map is keyed by payload path, so two
`tree` entries cannot land in one directory).

`include/git2_srclib.h` is generated from the same tool: the
`__require_source` block for all 210 TUs, so a consumer writes two `#include`s
instead of maintaining that list. `--check` guards it against `bin.json` drift
and runs in the e2e (cheap, no build).

## 🔴 The zlib decision — libgit2 uses its OWN, and plants no `zlib.h`

**Decision: libgit2 ships and binds to its own bundled `deps/zlib`, and exposes
nothing named `zlib.h` on any include tier.** Reasons, in order of force:

1. **`libpng` already owns `/usr/local/include/zlib.h` and `/usr/include/zlib.h`.**
   gucman's include plant refuses to overwrite an existing link, and
   `foldPackages`' `claim()` throws on a collision. A libgit2 that also claimed
   `zlib.h` would make `gucman install libgit2` fail whenever libpng is
   installed **and would break the fat bake outright**. Verified by running the
   `--packages=all` fold: it succeeds, libgit2 plants exactly three public
   entries (`git2`, `git2.h`, `git2_srclib.h`), and the `zlib.h`/`zconf.h`
   entries in `/usr/include` are still libpng's alone.
2. **Depending on libpng's zlib was the alternative and it is worse.** gucman
   has no dependency mechanism; the base image has no libpng; and libgit2's
   bundled zlib is not the same tree as `vendor/zlib`. Binding libgit2's
   sources to whatever `<zlib.h>` happened to be planted is precisely the
   silent-fallback pattern the estate bans.
3. Making that deterministic required converting seven `#include <zlib.h>` to
   `#include "zlib.h"` (plus `<arpa/inet.h>` and `<pcre2.h>`): an angle include
   never looks same-dir, so no forwarder can reach it. With the quote form the
   same-dir forwarder wins unconditionally, whatever is on the system tier.

**Finding for the gucman design (the ticket asked):** include-tier namespaces
are **global and first-come**, not per-package. Two packages providing the same
top-level entry name is not a merge, a shadow or a warning — it is a hard
refusal at install and a hard throw at bake. Source *namespaces* (`srclib.src`)
are also global but are package-scoped by convention (`git2`, `png`, `z`,
`win32`), so they collide far less readily. The asymmetry is worth knowing
before a second package wants a common header name: today the only defence is
that nobody has tried.

## Behaviour changes I chose, and why

- **`stubs/pwd.h` and `stubs/sys/param.h` deleted.** Dropping `-I stubs` made
  these two ANGLE includes fall through to the compiler's builtins. That is a
  silent substitution, so I checked both rather than let it stand:
  `sys/param.h` is a strict superset (same `MAXPATHLEN`, `MIN`, `MAX`), and the
  builtin `pwd.h` is *better* — the stub's `getpwuid_r` always reported "no
  such user", so `git_sysdir_guess_home` failed outright when `$HOME` was
  unset, while the builtin returns the root entry with `pw_dir = /root`, which
  is what gucOS has. `$HOME` is tried first either way. Adopting the builtins
  and deleting the superseded stubs keeps one behaviour across every target;
  keeping the stubs would have needed same-dir shadow files whose only purpose
  was to preserve a worse answer.
- **The packaged binary is 1,479,148 bytes vs the old 1,478,016.** Fully
  accounted for: a TU reached through a forwarder is lexed under a denormalized
  path (`src/libgit2/../util/str.h`) and `compiler.js` interns that string
  verbatim, so `__FILE__` grows in 46 places. Confirmed by counting `/../`
  strings in the two binaries (46 vs 0). Normalizing resolved include paths in
  `compiler.js` would fix it, and would move bytes in every binary in the tree
  — deliberately not done here.

## Package + tests

`packages/libgit2.json` follows `packages/libpng.json`: an `include` tree, a
`src` tree (the rest of the vendored tree minus `repros/`, the two `main()`
files and the project jsons), `srclib: {include: ["include"], src: {git2: "src"}}`.
1.8 MiB compressed, 710 members.

`tests/kernel/test_gucman_libgit2_e2e.js` (registered in `tests/kernel/run.js` —
the #314 guard refuses the run otherwise) drives the whole loop on the MINIMAL
image: bare-image proof → install → the plant → an in-OS `cc` build of a real
git program with no `-I` and no TU list → run → assert a real `.git` with loose
objects → reboot → the already-built binary re-opens the repo → remove →
**the same compile now fails on the missing header** (the red control).

The run leg is also the ticket's stack-size caution: every write goes through
`lock_file`'s 64 KiB `GIT_BUFSIZE_FILEIO` buffer, so a `__minstack(1048576)`
that did not survive the in-OS compile or the OS spawn path would trap on the
first commit rather than pass quietly.

`tests/run.js`: `^vendor/libgit2/` was mapped to `['fakegit','projects']` with
the comment "NOT in the bake closure (nothing seeds or packages it)". That is
now false, so the rule gains `kernel`, `sweep`, `host` — the libpng/libjpeg
blast radius. `tools/mkgit2srclib.js` gets its own rule (the no-blanket-`^tools/`
convention).

`os/image.json` 231 → 232: the fat image gains the folded package.
