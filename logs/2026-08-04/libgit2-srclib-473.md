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

## 🔴 A latent port bug the acceptance criterion flushed out

`git_libgit2_init()` **always returned -1**, in every build of this tree, since
it was vendored. The acceptance ("actually links AND runs") is what caught it:
the demo program checks the documented return of the library's mandatory first
call, and could not get past it.

`missing_stubs.c` stubbed three absent-feature initializers as `return -1`
(`git_openssl_stream_global_init`, `git_mbedtls_stream_global_init`,
`git_transport_ssh_libssh2_global_init`). `git_runtime_init` runs its
`init_fns` in order and **stops at the first non-zero**, so the last nine
subsystems never initialized:

| Skipped | Consequence |
|---|---|
| `git_stream_registry_global_init`, `git_socket_stream_global_init`, openssl, mbedtls | no network transports registered (moot here — they are stubs) |
| `git_mwindow_global_init` | pack-window mutex uninitialized, shutdown hook never registered |
| **`git_pool_global_init`** | **`system_page_size` stayed 0 — every `git_pool` page was sized from zero** |
| `git_settings_global_init` | shutdown hook never registered |
| `git_reftable_global_init` | reftable kept its own allocator instead of libgit2's |

Nothing crashed because the nine that DO run cover the local-repository path,
and `feature_probe.c` / `test_main.c` both call `git_libgit2_init()` **and
throw the result away** — which is exactly why it survived. Upstream's own
"feature not compiled in" variants all `return 0` and report the failure at
the `*_new`/`_connect` that needs it; the stubs now match. This is a fix to
the vendored port, not to my packaging, and it is worth a separate look: it
means every prior claim that "libgit2 works here" rested on callers that
ignored an error return.

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

## Gate

`node tests/run.js --diff origin/main --dry-run` mandated **todos, host,
projects, fakegit, kernel, sweep**. One invocation, `origin/main` = `cefc2915`,
tree = `f790c431`:

| suite | result |
|---|---|
| todos | pass (13.1s) |
| host | pass (243.5s) |
| py[projects,fakegit] | pass (304.2s) |
| kernel | pass (1187.7s) — **156/156 selected, 156/156 recorded** |
| sweep | pass (1163.3s) — **50/50 selected, 50/50 recorded** |

5 passed, 0 failed (2911.9s). Read from `build/test-run/summary.json`
(`results[].suite` / `.status` / `.files`), not from the runner's summary line.
`recorded == total` on both artifact-backed suites, so nothing was filtered.
The kernel total is 156 because this ticket adds the 156th file.

## Result

`node tests/kernel/test_gucman_libgit2_e2e.js` — **41/41 PASS**. The in-OS
`cc` builds the demo from two `#include`s with no `-I` and no TU list, and the
commit it writes has the **same oid as the host build's** (`78d09cb1…`), whose
repository `git log` / `git fsck` / `git cat-file` accept unmodified.

## Rebase onto #474 (`afc46b92`)

#474 merged first and moved `vendor/fakegit/` to `os/git/`, so the tree the
Step 1 measurement above names no longer exists — that measurement stands on
its own tip (`481421fb`) and `os/git/bin.json` inherits the same 210 libgit2
TUs (verified identical set) plus the same four stale flags already dropped.

**The `tests/run.js` conflict was semantic, not textual.** #474 and this
ticket independently rewrote the same rule, each supplying a DIFFERENT true
reason why `^vendor/libgit2/` is now in the bake closure: #474's is that
`os/git/bin.json` compiles the tree and `packages/git.json` ships the binary;
this ticket's is that `packages/libgit2.json` ships the tree ITSELF as a
srclib package. Both are recorded in the merged comment on purpose — each
independently justifies kernel+sweep, so retiring one must not read as grounds
to narrow the rule.

The suite list is #474's `['fakegit','projects','kernel','sweep']`, NOT the
`+ host` this branch originally had.

**The first justification I wrote for that was false, and the Codex delta
review was right to block on it.** I had written "no test under `tests/host/`
or `tests/serve/` reads this tree". It does: because #473 gives
`packages/libgit2.json` two `tree` entries,
`tests/host/test_bakeinput_sources.js`'s real-repo legs enumerate
`vendor/libgit2` through `newestBakeInput` / `newestPkgInput`. I had checked
`test_source_packages.js` and `test_mkpkg_isolation.js` and generalized from
two files to a whole directory — the generalization was the error, and it is
the same "a true-sounding sentence is more dangerous than a false one" shape
the liability register exists for.

Excluding `host` still holds, for the reason I should have measured the first
time: **nothing a tree edit can do to that guard's outcome is unique to it.**
Four probes, one edit at a time, each reverted:

| edit under `vendor/libgit2/**` | host guard | also caught by a selected suite? |
|---|---|---|
| modify a file's content | green | — |
| add a plain file | green | — |
| delete a file | green | only if the deletion is BUILD-REFERENCED (below) |
| **add a symlink** | **RED** | **yes — `foldPackages('all')` AND `mkpkg` both throw** |

The guard's assertions are about *which directories the scan enumerated* and
*which `files` entry kinds the definition uses* — neither of which a file's
content or presence moves. The one class that does fire is the symlink, and
that is caught by two suites this rule already selects, through the exact code
paths they run: every kernel and sweep fixture bake is `--packages=all`
(`foldPackages` throws: *"package 'libgit2': … is a symlink — tree payloads
carry files and dirs only"*), and `tests/kernel/lib/gucman.js
ensurePackages()` shells out to `tools/mkpkg.js`, which throws the same. Both
verified RED against the same planted symlink.

On the deletion row, the narrow true statement: deleting a file that the build
REACHES (a TU in `bin.json`'s `sources`, or a header some TU includes) breaks
`fakegit`/`projects`, both selected. Deleting an *arbitrary* payload file need
not give any signal at all — much of the payload is deliberately not compiled
(`deps/llhttp`, `deps/ntlmclient`, `src/util/win32`), and removing one of those
is invisible everywhere. That is not a gap this rule can close, and `host`
would not close it either: the guard was green on the deletion probe.

### Why the enumeration is exhaustive — the space is bounded by git

Listing classes only closes the question inductively, which is exactly where an
exhaustiveness argument fails. The structural closure is that **git can
represent only three entry modes**, and this repo uses all three: `100644`
(12,542 files), `100755` (53), `120000` (1 symlink). Under `vendor/libgit2/`
today: 713 files, every one `100644`. So the complete set of edits that can
*arrive through a commit* is: change content, add, delete, flip the mode bit,
or introduce a symlink. All five are measured above and in the mode-bit probe
below; only the symlink turns the host guard red.

The five further classes the reviewer pressed on were probed anyway, each
mutating the real tree and reverting in a `finally` — and the interesting
result is that four of them are not in the space at all, because git stores
none of them:

| further class | host guard | in git's model? |
|---|---|---|
| permission bits (`chmod +x`) | green | yes — `100644` ⇄ `100755` |
| hardlink (second name, one inode) | green | no — stored as a second ordinary file |
| empty directory | green | no — git tracks no empty dirs |
| NFD + NFC filename pair | green | no — a name collision, not an entry kind |
| non-UTF8 filename | **not producible** — APFS rejects with `EILSEQ` | n/a |

`packages/libgit2.json` itself still draws `host` from the `^packages/` rule,
which is the right place for definition-shaped coverage.

**`os/image.json` 232 → 233.** #474 took main to 232 and this branch had
independently chosen 232 for the same fat-image reason; git reported no
conflict *because* the two sides agreed, which is exactly the failure mode —
the agreement was the bug, not the resolution.

`os/git` needs no change: its 14 remaining `-D` flags are now redundant
duplicates of the header config (`#ifndef`-guarded, or an identical
redefinition in `NO_MMAP`'s case), and its ten `-I` roots resolve to the same
files the forwarders already reach same-dir. Trimming them is a follow-up for
whoever owns that file, not a change this branch should make. Confirmed by the
`fakegit` category building `os/git/bin.json` green (11/11) after the rebase.
