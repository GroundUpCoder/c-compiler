# vendor/libgit2 — libgit2 as a c-compiler stress test

libgit2 vendored as a compile-and-run target for the c-compiler. Its real
purpose is to **stress the compiler** on a large, real-world C codebase — and it
did its job: it surfaced a real c-compiler **codegen bug**, now fixed (see
Status / History).

Upstream: **libgit2 @ `44c05e5`** (core only — the networking *transports* are
stubbed, not used by the smoke test). Copied in as real files (no symlinks, no
submodule), matching the other vendored deps (lua/doom/zlib/sqlite).

## Status (2026-08-04)

- **Shipped as a gucman source library** (#473): `gucman install libgit2`, then
  `cc prog.c -o prog` in gucOS links a real git program against it — no `-I`,
  no TU list. See "The srclib package" below; the acceptance test is
  `tests/kernel/test_gucman_libgit2_e2e.js`.
- **Builds:** ✅ `node compiler.js vendor/libgit2/bin.json -o /tmp/libgit2.wasm`
  → exit 0, ~1.5 MB wasm.
- **Runs:** ✅ the `git_index_open()` smoke test prints `git_index_open -> 0`.
- **Real git workflows work:** ✅ `feature_probe.c` exercises a full
  init → config → blob → tree → commit → revparse → revwalk → status flow.
  Every step succeeds and the **resulting repo passes real `git fsck` / `git log`
  / `git cat-file`** — libgit2-on-WASM produces byte-valid git repositories.
  (`node compiler.js vendor/libgit2/feature_probe.json -o /tmp/probe.wasm &&
  node host.js /tmp/probe.wasm`.)

Two things were needed to get here beyond the incomplete-type fix below:

- **1 MB shadow stack** (`__minstack(1048576)` in `missing_stubs.c`). libgit2's
  file-I/O helpers (`lock_file`, `write_file_stream`, `cp_by_fd`, …) put a 64 KB
  `GIT_BUFSIZE_FILEIO` buffer on the stack; the default 1-page (64 KB) WASM
  stack underflows the moment one is entered (every file write goes through
  `lock_file`). The `-Wlarge-stack-frame` warnings for those functions are
  expected and harmless with the larger stack.
- **A `utimes()` libc fix** (in `compiler.js` + `host.js`). The bundled libc's
  `utimes()` was a no-op returning 0 even for a missing path; libgit2's ODB
  "freshen" uses `utimes`/`touch` to decide whether an object already exists, so
  it concluded every object was present and **silently skipped every write**
  (create returned the right OID but nothing hit disk). `utimes()` (and
  `futimes`/`utime`/`utimensat`/`futimens`) now actually set the file's
  atime/mtime through a host primitive wired into all three FS backends, and
  honor POSIX errors (ENOENT for a missing path). A companion fix corrected the
  host `struct stat` layout (a missing `st_rdev` slot had shifted `st_mtime`),
  so the times read back correctly.

### The bug (fixed) — incomplete-type struct member

The crash was a **compiler codegen bug, not a libgit2 bug**, with a libgit2
**misconfiguration** as the trigger:

1. **Compiler bug:** the compiler silently accepted a `struct`/`union` member of
   *incomplete* type (a constraint violation — clang/gcc reject it with "field
   has incomplete type"), sizing the member as 0 and so under-sizing the whole
   aggregate. Fixed in `compiler.js`: such a member is now a compile error.
   Regression test: `tests/unit/core/struct_incomplete_member/`.
2. **libgit2 trigger:** `hash/sha.h` only `#include`s the completing header
   `collisiondetect.h` under `#if defined(GIT_SHA1_BUILTIN)`, but the vendored
   feature config defined the *unread* macro `GIT_SHA1_COLLISIONDETECT` instead.
   So in every TU that included `hash.h` (but not `collisiondetect.h` directly),
   `git_hash_sha1_ctx` stayed forward-declared — incomplete. `git_hash_ctx` (a
   union over it) was then sized **120 bytes instead of ~2408**. At runtime
   `git_hash_buf`'s stack-local `ctx` overflowed during SHA1 hashing, clobbering
   the caller's `git_str buffer.ptr` (→ `0x5`); `git_str_dispose`→`free()` then
   trapped. Fixed by defining `GIT_SHA1_BUILTIN` (the macro the code actually
   checks; upstream `cmake/SelectHashes.cmake` sets it for the builtin/
   collisiondetect backend) in `features.h`, `git2_features.h`, and `lib.json`.

## Build / run

```bash
# from the c-compiler repo root
node compiler.js vendor/libgit2/bin.json -o /tmp/libgit2.wasm   # build
node host.js /tmp/libgit2.wasm                                  # → git_index_open -> 0
```

- `bin.json` — the smoke-test **executable** target (`test_main.c` + the libgit2
  subset it needs).
- `lib.json` — a **core library** target (the `util` sources). Secondary.

Manifest paths are **repo-relative** (resolved against this directory), so the
tree is self-contained and portable.

## Layout

### Porting layer (hand-written, c-compiler-specific — keep)
- `stubs/` — minimal POSIX/platform headers the WASM target lacks (`netdb.h`,
  `memory.h`, `netinet/{in,tcp}.h`, `sys/socket.h`, `arpa/inet.h`).
  `pwd.h` and `sys/param.h` were dropped by **#473**: the compiler's own libc
  now ships both, and its `pwd.h` is strictly better than the stub was — the
  stub's `getpwuid_r` always returned "no such user", so with `$HOME` unset
  `git_sysdir_guess_home` failed; the builtin returns the root entry with
  `pw_dir = /root`, which is what gucOS actually has. (`$HOME` is tried first
  either way — `sysdir.c` only reaches the password entry as a fallback.)
- `features.h`, `git2_features.h` — **hand-written replacements for the
  CMake-generated feature headers** (no threads, builtin SHA, PCRE2 regex, etc.).
  ⚠️ **`git2_features.h` is the live one; nothing includes `features.h`.**
  `src/util/git2_util.h` includes `git2_features.h`, and that is the only path
  into either file. The two carry the same include guard
  (`INCLUDE_features_h__`) and near-identical bodies, so an edit to
  `features.h` alone is silently inert — #473 hit exactly that when the
  `NO_MMAP` line that lives there turned out never to reach `unix/map.c`.
- `deps/pcre2/config.h` — **hand-written replacement for the CMake/autoconf
  `config.h`** (#473). See "Build configuration lives in headers" below.
- `git_stubs.c`, `missing_stubs.c` — out-of-line definitions for `GIT_INLINE`
  functions. The c-compiler has no `inline`, so `GIT_INLINE` becomes plain
  `static`, and the matching `extern` decls would otherwise be unresolved imports.
  `missing_stubs.c` also stubs the networking transports.
- `attr_patched.c`, `iterator.h` — patched copies of the upstream files (carry
  the libgit2 copyright header; edited to compile under the c-compiler).
- `wasm-compat.h` — POSIX shims for functions absent in the WASM runtime.
  Its `gmtime_r` shim was removed by **todos/0325 Group A**, which added the
  real one to the libc: a local `static inline` then conflicts with the
  header declaration.
- `test_main.c` — the smoke test (`git_index_open`), which triggers the bug.
- `include/git2_srclib.h` + the `srclib forwarder` headers scattered through
  the tree — **generated** by `node tools/mkgit2srclib.js` (#473). See
  "The srclib package" below. Do not hand-edit either.

### Upstream source (copied from libgit2 @ 44c05e5)
`include/`, `src/{util,libgit2}/`, `deps/{pcre2,xdiff,reftable,zlib,llhttp,ntlmclient}/`.

## Build configuration lives in HEADERS, not in `-D` flags (#473)

`bin.json`, `lib.json` and `feature_probe.json` used to carry 18 `compilerArgs`
each. They now carry **none**, and one `-I include`. This was forced by the
gucman package: `srclib` sections accept only the keys `include` and `src`
(`validateSrclibShape`, enforced in mkpkg, `foldPackages` and `gucman.c`), so a
source library **cannot ship compiler flags** — anything a `-D` used to say has
to be readable from the source tree itself, or the in-OS `cc` builds different
code from the host build.

Where the 18 went:

| Former flag | Now | Why |
|---|---|---|
| `--allow-old-c`, `-Dvolatile=`, `--allow-undefined`, `-DNO_STRNLEN` | **deleted** | stale cruft: removing all four left **byte-identical** output (measured 2026-08-04) |
| `-DHAVE_LONG_LONG=1` | **deleted** | no reference anywhere in the tree; removal byte-identical |
| `-DNO_MMAP` | `git2_features.h` | reaches `posix.c` / `unix/map.c` / `indexer.c` through `git2_util.h` |
| `-DPCRE2_CODE_UNIT_WIDTH=8`, `-DPCRE2_STATIC`, `-DPCRE2_EXPORT=` | `git2_features.h` **and** `deps/pcre2/config.h` | the caller-visible half of the PCRE2 API; `src/util/regexp.h` needs them before it reads `pcre2.h`. `#ifndef`-guarded in both places so they cannot disagree |
| `-DLINK_SIZE`, `-DMAX_NAME_SIZE`, `-DMAX_NAME_COUNT`, `-DMATCH_LIMIT`, `-DMATCH_LIMIT_DEPTH`, `-DHEAP_LIMIT`, `-DNEWLINE_DEFAULT`, `-DPARENS_NEST_LIMIT`, `-DMAX_VARLOOKBEHIND` | `deps/pcre2/config.h` | PCRE2's own build config, back where upstream puts it |

Each of the 12 surviving values was ablated individually: every one except
`PCRE2_STATIC` fails the build when removed, and `PCRE2_STATIC` is kept anyway
because upstream's export logic is written against it.

**One upstream edit makes this work:** `deps/pcre2/pcre2_internal.h` defines
`HAVE_CONFIG_H` itself (2 lines + a comment) so its own — unmodified —
`#include "config.h"` block fires. Upstream expects a build system to pass
`-DHAVE_CONFIG_H`; there is no build system here.

## The srclib package (`packages/libgit2.json`, #473)

`gucman install libgit2` plants `/usr/local/include/{git2.h, git2/,
git2_srclib.h}` and `/usr/local/src/git2`; the fat image bake folds the same
tiers under `/usr/{include,src}`. A consumer then writes:

```c
#include <git2.h>
#include <git2_srclib.h>     /* __require_source() for every library TU */
```

and builds with `cc prog.c -o prog` — no `-I`, no TU list.

**Forwarders.** libgit2's own build wants nine `-I` roots; the srclib model
offers exactly one ambient header tier, and putting libgit2's ~150 internal
header names (`str.h`, `vector.h`, `util.h`, `config.h`, …) on a *system*
include path would be indefensible. So the search path is materialized as
files instead: for every (directory, include name) the build cannot resolve
same-dir, `tools/mkgit2srclib.js` writes a one-line forwarder into that
directory. Quote includes search the including file's own directory first, so
the forwarder wins with no flags — **in the host build and the in-OS build
alike, which is the point: one resolution path, not two.** 96 forwarders as of
#473, all carrying a `c-compiler srclib forwarder` marker comment; the
generator deletes and re-derives the whole set on every run.

**Angle includes had to become quote includes** in nine places (`<zlib.h>` ×7,
`<arpa/inet.h>`, `<pcre2.h>`): an angle include never looks same-dir, so no
forwarder can reach it. The `<zlib.h>` conversions matter beyond mechanics —
libgit2 must bind to ITS OWN bundled `deps/zlib`, and `libpng`'s package
already owns `/usr/local/include/zlib.h`. Same-dir resolution makes that
deterministic; the gucman plant refuses to overwrite an existing link, so a
second package claiming `zlib.h` would make `install` (and the fat bake's
`claim()`) fail outright.

**Regenerate after touching the tree:**

```bash
node tools/mkgit2srclib.js           # forwarders + git2_srclib.h
node tools/mkgit2srclib.js --check   # git2_srclib.h vs bin.json (cheap)
```

A missing forwarder is not silent: `bin.json` no longer passes the `-I` roots
that used to hide one, so the ordinary `fakegit` / `projects` build fails.

**Known cosmetic cost:** a TU reached through a forwarder is lexed under a
denormalized path (`src/libgit2/../util/str.h`), and the compiler interns that
string verbatim, so `__FILE__` in 46 places grows by a few characters — the
whole reason the packaged binary is 1,479,148 bytes against the old build's
1,478,016. Normalizing resolved include paths in `compiler.js` would fix it
estate-wide and is deliberately NOT done here (it would move bytes in every
binary in the tree).

### `repros/` — historical isolation attempts (superseded; not wired into the runner)
These were early guesses at the crash, written before the root cause was known.
None of them reproduced it, because the actual bug had nothing to do with the
pool allocator or `parse_index`'s shape — it was an incomplete-type struct
member mis-sized by the compiler (see "The bug" above). The real regression test
now lives in `tests/unit/core/struct_incomplete_member/`. Kept here only as a
record of the hunt:
- `pool_corruption.c` — exercised the pool-allocator patterns `parse_index` uses.
  Does **not** reproduce the crash (correctly — wrong theory).
- `ptr_size_bug.c` — 32-bit (WASM) vs 64-bit struct-layout assumptions. A red herring.
- `stack_corruption.c` — a reduced `parse_index` shape. Also doesn't reproduce.

## What is deliberately NOT vendored (generated / build-system files)

The c-compiler build uses `bin.json`/`lib.json`, **not CMake**, so the CMake
build system and its generation templates are omitted:

- `CMakeLists.txt` (all), `*.cmake.in`, `git2.rc` — CMake/Windows build files.
- `git2_features.h.in`, `experimental.h.in`, `deps/pcre2/config.h.in` — CMake
  **generation templates**. The values they'd produce come instead from the
  hand-written `git2_features.h` and `deps/pcre2/config.h` (see "Build
  configuration lives in HEADERS" above). They used to come from `-D…` flags
  in `compilerArgs`; #473 moved every one of them into a header, because a
  gucman `srclib` package cannot carry compiler flags.

Kept on purpose (the build `#include`s them and there is no generation step
here, so they are treated as source):
- `include/git2/version.h`, `include/git2/experimental.h` — libgit2 ships these
  pre-committed.
- PCRE2's pre-generated Unicode tables — `pcre2_ucd.c`, `pcre2_ucp.h`,
  `pcre2_ucptables_inc.h`, `pcre2_chartables.c` — shipped pre-generated in every
  PCRE2 release; regenerating them needs PCRE2's maintainer tooling.

## History

Originally wired with absolute symlinks (`src`/`include`/`deps` →
`/Users/jku/git/libgit2`) plus absolute include paths — a dev shortcut during the
bug hunt that only built on one machine. De-symlinked to real files with
relative paths in `b6b0205`; generated/build-system files pruned and the README
added afterward. The `git_index_open` crash was then root-caused to the
incomplete-type-member compiler bug (and the `GIT_SHA1_BUILTIN` misconfig) and
fixed — both build and smoke-test run now pass.

## Next steps

1. Chase the remaining `-Wlarge-stack-frame` functions (move big locals to the
   heap or use `__minstack`) before exercising paths that call them.
2. Add a `libgit2` category to `tests/run.py` (like `lua`/`sqlite`) so the
   `git_index_open` smoke test runs in CI, then broaden coverage beyond it.
