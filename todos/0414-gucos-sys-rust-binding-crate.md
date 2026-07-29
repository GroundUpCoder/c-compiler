# 0414 — `gucos-sys`: the ONE Rust binding to the `"c"` ABI (Lane A2)

- **Status**: open
- **Design**: `todos/RUST.md` §2 (the ABI contract) and §3 (the architecture rules).
- **Provenance**: the Rust program, filed 2026-07-29.

## Goal

Give Rust one crate that declares the `"c"` import set, and one allocator. Every
later Rust program on gucOS reaches the host through this crate and through nothing
else.

`todos/0413` proved that a single import works. This ticket makes the import set a
library, and it lights up `alloc`. After it, `Vec`, `String`, `Box`, `BTreeMap`,
iterators, sorting and `format!` all work. Those types live in `core` and `alloc`.
They are **not** in the Rust standard library, so this ticket needs no standard
library at all. `todos/0418` rules on the standard library separately.

## The heap rule — the reason this ticket exists

🔴 **Two allocators in one linear memory is the trap.** A gucOS process has ONE
linear memory. The C libc `malloc` owns a heap in it. A Rust `#[global_allocator]`
that takes a second region — a bump allocator over `__heap_base`, for example — then
hands out memory that `malloc` also believes it owns. The two allocators overwrite
each other, and the damage appears far from its cause.

Therefore the `#[global_allocator]` of `gucos-sys` **delegates to libc `malloc` and
`free`**. It never manages a region of its own.

The same rule covers the `alloca` export. `todos/0413` supplies a bump allocator
over a static arena, because it has no allocator yet. **This ticket replaces that
with a `malloc`-backed export.** The clang port already does exactly this
(`~/git/clang-simplified/wasm/compat/alloca_stub.c:16`). Delete the arena in the
same change. An arena that stays becomes a second heap by accident.

## Loud failure, never a silent stub

A missing host import must fail loudly. Do not declare an import and give it an
empty Rust body, and do not answer a call with a plausible zero. Both make a broken
program look like a working one.

The host already models this. A kernel with no network answers `__http_open` with
`-1` and `ENOSYS` (`host.js:6009`), which is a refusal the caller can see. Follow
that shape: where the host declines, return the declared error; where the import
is absent, fail at instantiation. A wasm module with an unsatisfied import fails
when it loads, which is loud and early, and that is the behaviour to keep.

## Plan

1. Declare the import set in one module of the crate, grouped by family: process
   exit, stdio, the filesystem, time, entropy, `posix_spawn`, sockets, the
   clipboard, and HTTP. Give each family its own file, and keep one
   `#[link(wasm_import_module = "c")]` block per file.
2. Write safe Rust wrappers over the raw imports. The raw block stays private.
3. Add the `#[global_allocator]`. It calls `malloc`, `free` and `realloc`.
4. Move the `alloca` export here, and back it with `malloc`.
5. State the rule of §3 of `todos/RUST.md` in a header comment of the crate: **one
   ABI, one libc, one heap.**

## Scope of the import set

Declare the **whole** `"c"` set that a gucOS program can use, not the subset that
the test of this ticket needs. The set is fixed, it is small, and it is already
enumerated in `host.js`. A crate that declares only the imports of today forces
every later ticket to extend it, and each extension is a chance to declare the same
import twice with two signatures.

The one exception is a family whose C body has no Rust caller and no Rust
equivalent, such as the math family or `strtod`. Link the vendored C libc for those
instead of re-declaring them, and say so in the crate.

## Acceptance

- One crate declares the `"c"` import set. No second declaration of any import
  exists anywhere in the sibling repository.
- The `#[global_allocator]` calls libc `malloc`. No Rust-side heap region exists.
- The `alloca` export calls `malloc`. The static arena of `todos/0413` is deleted.
- A Rust program builds a `Vec`, builds a `String`, sorts, formats and prints, and
  it runs in gucOS through the kernel suite.
- A test proves the allocator answer: allocate from Rust, free from Rust, and call
  a libc function that allocates in the same run. Nothing is corrupted.
- A module that names an absent import fails when it loads. A test asserts the
  failure message.
- The planner selects the suites (`node tests/run.js --diff`), and each one is green
  and reported with a NUMBER.

## Notes

The `todos` suite checks `todos/LIABILITIES.md`. If a change here rewrites an
anchored line, re-anchor the entry or retire it in the same commit.
