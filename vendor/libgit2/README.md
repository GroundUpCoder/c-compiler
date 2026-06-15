# vendor/libgit2 — libgit2 as a c-compiler stress test

libgit2 vendored as a compile-and-run target for the c-compiler. Its real
purpose is to **stress the compiler** on a large, real-world C codebase — and it
currently does its job: it surfaces a c-compiler **codegen bug** (see Status).

Upstream: **libgit2 @ `44c05e5`** (core only — the networking *transports* are
stubbed, not used by the smoke test). Copied in as real files (no symlinks, no
submodule), matching the other vendored deps (lua/doom/zlib/sqlite).

## Status (2026-06-15)

- **Builds:** ✅ `node compiler.js vendor/libgit2/bin.json -o /tmp/libgit2.wasm`
  → exit 0, ~1.74 MB wasm. A handful of `-Wlarge-stack-frame` warnings remain
  (functions with ≥64 KB frames — `write_file_stream`, `git_filter_list_stream_file`,
  `id_from_fd`, `lock_file`, `cp_by_fd` — that would trap *if called*; not on the
  smoke-test path, but they block full functionality later).
- **Runs:** ❌ **blocked on a c-compiler codegen bug.** `node host.js
  /tmp/libgit2.wasm` (smoke test = `git_index_open()`) crashes with
  `free: double free detected` → `unreachable`.

### The bug (for whoever picks this up)

`parse_index()` is miscompiled: its stack-frame layout is wrong under the full
libgit2 build context, so a stack-local `git_str buffer` gets its `.ptr` field
clobbered from a valid heap pointer to garbage. After `parse_index()` returns,
`git_str_dispose()` calls `free()` on that corrupted pointer; the allocator
detects the bad address and traps. It is a **compiler bug, not a libgit2 bug**.

Isolation attempts live in `repros/` (see below) but none is yet a minimal
green/red reproducer — the crash so far only reproduces in the full build.

## Build / run

```bash
# from the c-compiler repo root
node compiler.js vendor/libgit2/bin.json -o /tmp/libgit2.wasm   # build
node host.js /tmp/libgit2.wasm                                  # run (crashes — see Status)
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

### `repros/` — codegen-bug isolation attempts (not wired into the test runner)
- `pool_corruption.c` — exercises the pool-allocator patterns `parse_index` uses,
  in isolation. Intentionally does **not** reproduce the full crash (per its header).
- `ptr_size_bug.c` — 32-bit (WASM) `sizeof(void*)`/`long` vs 64-bit struct-layout
  assumptions in libgit2's pool allocator.
- `stack_corruption.c` — a reduced `parse_index` shape (static fn, `goto done`,
  macros) — the closest to the actual trigger.

These were loose `.c` files in `tests/unit/core/`, which **breaks the test
runner** (a directory can't have both `.c` files and subdirectories). They live
here until the bug is minimized; once there's a clean reproducer, move it into
its own `tests/unit/core/<name>/` with an `expected.stdout`.

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
added afterward.

## Next steps (for a dedicated thread)

1. **Minimize the `parse_index` codegen bug** into a standalone reproducer
   (start from `repros/stack_corruption.c`); then inspect the compiler's
   stack-frame layout / codegen for that function.
2. Fix it, then chase the `-Wlarge-stack-frame` functions (move big locals to the
   heap or `__minstack`).
3. Once the smoke test runs clean, add a `libgit2` category to `tests/run.py`
   (like `lua`/`sqlite`) and promote a `repros/` file to a real unit test.
