# 0414 — `gucos-sys`: the ONE Rust binding to the `"c"` ABI (Lane A2)

- **Status**: done (2026-07-30)

## Result

`gucos-sys` is live, and `alloc` works on gucOS through the one heap.

- **The sibling repository is `~/git/gucos-rust`, branch `0414-gucos-sys`,
  HEAD `e97a0a1a3959f5297d16dba21063c22a80425a15`** (pushed to
  `https://github.com/josephkimgpt/gucos-rust.git`). This c-compiler branch
  is `0414-gucos-sys`. Merge the two branches in lockstep.
- `crates/gucos-sys` declares the whole `"c"` import set: **86 imports in
  13 family files** (process, spawn, signal, stdio, fs, wait, tty, time,
  entropy, sockets, clipboard, egress, http). Each file holds one private
  extern block with `#[link(wasm_import_module = "c")]`, and safe wrappers
  over it. The set comes from host.js. The lib.rs header lists the
  families that stay behind their C bodies on purpose: the math
  transcendentals, the printf/scanf/strtod glue, setjmp/longjmp, the
  SDL/WebGPU veneers, the emscripten shims, the ss helpers, and the
  legacy aliases (`mkdir`, `__tcgetattr`, `__tcsetattr`).
- The `#[global_allocator]` delegates to libc `malloc`/`free`/`realloc`
  (over-aligned requests over-allocate and stash the raw pointer). The
  `alloca` export calls `malloc`. **The 0413 static arena is deleted.**
  No Rust-side heap region exists. The panic handler reports the panic on
  stderr from a fixed stack buffer, then calls `__exit(101)`.
- **A measured premise correction (ES).** The plan said: link the vendored
  C libc bodies. The mechanism needed one repair. The libc's `__import`
  marker sets only `import_module("c")`, and wasm-ld does not let such a
  symbol stay undefined — only an explicit `import_name` or an allow flag
  does. rustc's `#[link]` attribute sets both, which is why 0413 linked
  clean. This is the reason cc2wasm links with blanket
  `--allow-undefined`. The resolution keeps the loud-failure rule:
  `build.sh` passes `--allow-undefined-file` with the 187 names derived
  from the libc's own `__import` declarations. A listed symbol becomes a
  module `"c"` import. An unlisted undefined symbol still fails at link
  time with its name. Both directions are test-verified.
- `build.sh` compiles `__malloc __stdlib __string __stdio __errno` from
  the clang-simplified sibling with cc2wasm's exact flags and links the
  objects into every program (`CLANG_SIMPLIFIED` overrides the default
  path). It builds `out/hello-rust.wasm` (9,113 bytes) and
  `out/alloc-rust.wasm` (26,507 bytes), byte-deterministic (proven by a
  clean rebuild). A bare `cargo build` fails with
  `undefined symbol: malloc` — build.sh is the one build entry.
- The fixtures moved, and both are recorded: `hello-rust.wasm` sha256
  `5ec3a25673ae1074bb0ce464081ebbd2a3b4f83dce4b2705215404002e6c5cf2`
  (was `03ede92f…d5`; the crate now goes through gucos-sys), and the new
  `alloc-rust.wasm` sha256
  `842dde724b8b98ae47be021370b23d58c53b86bbc165b80cfa87cd0922d5c9e7`.
- `tests/kernel/test_rust_e2e.js` (39 checks with the sibling): the
  alloc-demo program builds a Vec, a String, a Box and a BTreeMap, sorts,
  formats, prints, and runs in a booted gucOS from the shell with `$?`
  asserted. The interop leg interleaves Rust growth with C
  `strdup`/`free` on the one heap and checks that nothing corrupts
  (`interop strdups=32 len_ok=true vec_intact=true`). The absent-import
  module fails at load, and the test asserts the message names
  `__gucos_absent_import` and `"c"`. The single-declaration guard scans
  the sibling: no `wasm_import_module` outside gucos-sys, and no import
  is declared twice (0 duplicates over the 86). The negative fixtures
  (`missing-link-attr`, `no-alloca`, `absent-import`) declare their own
  defect imports by construction; the sibling README records that.
- Gate: `node tests/run.js --diff` selected the kernel suite.
  **kernel 137/137 passed, `filter: null`, `recorded == total`, one
  run, exit 0.** The todos suite ran green at close
  (queue + liabilities checks pass).

Dev log: `logs/2026-07-30/0414-gucos-sys.md`.

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

## Lane A stays on a stable compiler

Say this in the crate, because it is easy to lose. `core` and `alloc` ship
**precompiled** for `wasm32-unknown-unknown`, so this ticket needs **no
`-Zbuild-std`** and therefore **no nightly compiler**. Lanes A1 to A4 are all
stable.

⚠️ **Do not generalize that to the whole program.** "Stable is sufficient" was
measured on one path: `wasm32-unknown-unknown`, `#![no_std]`, crate type `cdylib`.
A custom target specification with `-Zbuild-std` is a **different** path, and it is
nightly-only. `todos/0418` resolves which path the program takes, and it prices the
nightly cost if it picks that one.

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
   `#[link(wasm_import_module = "c")]` block per file. 🔴 **Every block carries that
   attribute.** Rust attributes an unmarked block to the module `env`, `host.js`
   supplies only `"c"`, and the result is an unsatisfiable import. `todos/0413`
   Trap 2 holds the rule and the link setting that makes a miss fail loudly.
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
