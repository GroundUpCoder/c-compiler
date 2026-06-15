# vendor/libgit2 — libgit2 as a c-compiler stress test

libgit2 vendored as a compile-and-run target for the c-compiler. Its real
purpose is to **stress the compiler** on a large, real-world C codebase — and it
did its job: it surfaced a real c-compiler **codegen bug**, now fixed (see
Status / History).

Upstream: **libgit2 @ `44c05e5`** (core only — the networking *transports* are
stubbed, not used by the smoke test). Copied in as real files (no symlinks, no
submodule), matching the other vendored deps (lua/doom/zlib/sqlite).

## Status (2026-06-15)

- **Builds:** ✅ `node compiler.js vendor/libgit2/bin.json -o /tmp/libgit2.wasm`
  → exit 0, ~1.8 MB wasm. A handful of `-Wlarge-stack-frame` warnings remain
  (functions with ≥64 KB frames — `write_file_stream`, `git_filter_list_stream_file`,
  `id_from_fd`, `lock_file`, `cp_by_fd` — that would trap *if called*; not on the
  smoke-test path, but they block full functionality later).
- **Runs:** ✅ `node host.js /tmp/libgit2.wasm` (smoke test =
  `git_index_open()`) prints `git_index_open -> 0` and exits cleanly. The
  former `free: double free detected` crash is gone.

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
- `stubs/` — minimal POSIX/platform headers the WASM target lacks (`pwd.h`,
  `netdb.h`, `memory.h`, `netinet/{in,tcp}.h`, `sys/{param,socket}.h`,
  `arpa/inet.h`).
- `features.h`, `git2_features.h` — **hand-written replacements for the
  CMake-generated feature headers** (no threads, builtin SHA, PCRE2 regex, etc.).
- `git_stubs.c`, `missing_stubs.c` — out-of-line definitions for `GIT_INLINE`
  functions. The c-compiler has no `inline`, so `GIT_INLINE` becomes plain
  `static`, and the matching `extern` decls would otherwise be unresolved imports.
  `missing_stubs.c` also stubs the networking transports.
- `attr_patched.c`, `iterator.h` — patched copies of the upstream files (carry
  the libgit2 copyright header; edited to compile under the c-compiler).
- `wasm-compat.h` — POSIX shims for functions absent in the WASM runtime.
- `test_main.c` — the smoke test (`git_index_open`), which triggers the bug.

### Upstream source (copied from libgit2 @ 44c05e5)
`include/`, `src/{util,libgit2}/`, `deps/{pcre2,xdiff,reftable,zlib,llhttp,ntlmclient}/`.

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
  **generation templates**. The values they'd produce come instead from:
  - the `-D…` flags in `bin.json`/`lib.json` `compilerArgs` (PCRE2 config, GIT_*
    feature flags), and
  - the hand-written `features.h` / `git2_features.h` overrides above.

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
