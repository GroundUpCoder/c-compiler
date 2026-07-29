# 0413 — A `no_std` Rust binary runs in gucOS (Lane A1)

- **Status**: open
- **Design**: `todos/RUST.md` §2 (the ABI contract) and §3 (the architecture rules).
- **Provenance**: the Rust program, filed 2026-07-29. The design pass ruled
  "proceed with modifications" and funds Lane A unconditionally.

## Goal

Make Rust a language that produces a real gucOS binary. This ticket lands the
first one, and it writes the ABI contract down as a fixed contract.

The emit question is already answered. A probe on 2026-07-29 built a `#![no_std]`
crate with **stable `rustc 1.96.1`** for the target `wasm32-unknown-unknown`, and
`node host.js <module>` printed its message and exited 0. The probe needed **no
nightly compiler, no custom target specification, no `wasm-bindgen` and no WASI**.
`todos/RUST.md` §5 holds the result. Do not re-open that question. Build on it.

## The contract this ticket fixes

`todos/RUST.md` §2 is normative. The three exports are **`main`, `memory` and
`alloca`**, not two.

`host.js` plays crt0 itself. It enters at `main(argc, argv, envp)` and not at
`_start`, so it lays out `argv` and `envp` in the memory of the module, and it calls
the module's own exported `alloca` to get that space (`host.js:11496`,
`host.js:11525-11545`). `host.js:11725` makes `args[0]` the path of the module, so
this path always runs. A module without `alloca` fails with `alloca is not a
function`. A C module gets the export for free from the compiler. A Rust module does
not.

`__set_environ` and `__wasm_call_ctors` are optional. `host.js` guards both calls.

## Where the code lives

The crate lives in a **sibling repository**, not here. `~/git/clang-simplified` is
the precedent: one producer, and this repository consumes artifacts and never
invokes the compiler of the sibling. See `todos/RUST.md` §3 rule 4.

## Plan

1. Create the sibling repository with one crate. Use the probe crate as the start.
   `~/git/meta/gucos/notes/rust-p1-c-abi-emit-probe.md` §6 holds the full source.
2. Set `panic = "abort"`, and write a panic handler that calls the `"c"` import
   `__exit`. The handler of the probe is an infinite loop, which hangs the process.
   Do not ship that.
3. Supply the `alloca` export. This ticket has no allocator yet, so a bump allocator
   over a static arena is correct **here only**. `todos/0414` replaces it with a
   `malloc`-backed export, because two allocators in one linear memory is the trap
   that `todos/RUST.md` §3 rule 3 exists to prevent. Record that hand-off in the
   source of the crate.
4. Write the ABI contract into a header comment of the crate, and point the comment
   at `todos/RUST.md` §2.
5. Add the test. The next section specifies it.

## The test, and why it is unconditional

This repository has no `rustc`, and it must not gain one. A test that runs only when
the sibling is present is a test that a normal `node tests/run.js kernel` never
runs. That is the vacuous-leg pattern of `todos/0287`, and this ticket refuses it.

Land **two** legs.

1. **An unconditional leg.** Commit ONE small `hello-rust.wasm` fixture. The module
   of the probe was 639 bytes, so the cost is small. Write the fixture into the root
   volume, spawn it from the shell, and assert the output. This proves in-OS
   execution with no sibling and no `rustc`.
2. **A freshness leg.** When the sibling is present, rebuild the module and assert
   that the bytes equal the committed fixture. A fixture with no freshness check
   rots quietly, and a rotted fixture proves nothing about the crate of today. When
   the sibling is absent and nobody asked for it, this leg skips. That is the normal
   state of `todos/CLANG-CPP-EPIC.md` §4 rule 2. When somebody asks for Rust and the
   sibling is absent, fail loudly and print the fix command.

Record the sha256 of the fixture beside it.

## What this ticket does NOT do

A run in a real gucOS terminal in the browser needs the module inside the image, and
the image only takes it through the packaging seam. That seam is `todos/0416`. This
ticket proves in-OS execution through the kernel suite, and `todos/0416` adds the
browser leg. Do not read the absent browser leg as a cut scope. It is a sequencing
fact, and it is named here so that nobody has to derive it again.

## Acceptance

- A `#![no_std]` Rust module built by **stable** `rustc` imports from the module
  `"c"`, exports `main`, `memory` and `alloca`, and declares a growable memory.
- `node host.js <module>` prints the message and exits 0.
- A kernel-suite test spawns the committed fixture from the shell in a booted
  gucOS, and asserts the output.
- The freshness leg rebuilds the fixture from the sibling, and proves the bytes are
  equal.
- A panic calls `__exit` and ends the process. It does not hang.
- `node todos/queue.js check` passes. The planner selects the suites
  (`node tests/run.js --diff`), and each one is green and reported with a NUMBER.

## Notes

The `todos` suite checks `todos/LIABILITIES.md`. If a change here rewrites an
anchored line, re-anchor the entry or retire it in the same commit.
