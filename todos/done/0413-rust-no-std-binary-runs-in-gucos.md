# 0413 — A `no_std` Rust binary runs in gucOS (Lane A1)

- **Status**: done (2026-07-30)

## Result

The first Rust binary runs in gucOS, and the ABI contract is fixed by tests.

- **The sibling repository is `~/git/gucos-rust`, branch `main`, HEAD
  `1bcf3e3771500eb3b7aa54de28739170b8908975`.** The repository is LOCAL-ONLY —
  it has no remote, so this ledger line is the record that it exists. The name
  is provisional. The one point that resolves the sibling path is the
  `RUST_ROOT` env var in `tests/kernel/test_rust_e2e.js` (default
  `~/git/gucos-rust`); nothing else in this repository names it.
- The crate is `crates/hello-gucos`: stable `rustc 1.96.1`,
  `wasm32-unknown-unknown`, `#![no_std]` cdylib, 887 bytes. It imports only
  `write` and `__exit` from module `"c"`, exports `main`/`memory`/`alloca`,
  and declares a growable memory. The panic handler calls `__exit(101)` — the
  probe's `loop {}` hang is not shipped. `alloca` is a bump allocator over a
  static arena, with the hand-off note to `todos/0414` in the source. The
  build is byte-deterministic (`codegen-units = 1`, proven by a clean
  rebuild), which is what makes the freshness leg meaningful.
- The committed fixture is `tests/kernel/fixtures/hello-rust/hello-rust.wasm`
  (sha256 recorded beside it:
  `03ede92f9343ea7cef1a6513c946604f8092ac40c033dfef5e0f0296a4efd6d5`). The
  repo-wide `*.wasm` gitignore gained an explicit unignore for exactly this
  file — the one committed wasm binary in the tree.
- `tests/kernel/test_rust_e2e.js` (registered in the kernel suite, IMG):
  legs 1–4 are UNCONDITIONAL (fixture sha, module shape, `node host.js`
  hello + panic paths, and the in-OS shell spawn on a booted gucOS with
  `$?` asserted for both paths). Legs 5–7 are sibling-gated: the freshness
  rebuild must be byte-equal; the `missing-link-attr` crate must FAIL AT LINK
  with a message that names `write` (this proves rustc's default link has no
  `--allow-undefined`); the `no-alloca` crate must trap at start-up with
  `alloca is not a function`. An absent sibling SKIPs legs 5–7 (normal
  state); `RUST_REQUIRE=1` turns that absence into a loud failure that
  prints the fix. All three branches were exercised: 18/18 checks with the
  sibling, SKIP without it, exit 1 under `RUST_REQUIRE=1`.
- Measured confirmations of the ticket's premises: rustc's default `wasm-ld`
  invocation carries no `--allow-undefined` (the negative crate fails with
  `undefined symbol: write`), and the no-alloca module exits 1 with the
  documented trap before `main`.

Dev log: `logs/2026-07-30/0413-rust-a1.md`.
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
`host.js:11525-11545`). A C module gets the export for free from the compiler. A
Rust module does not.

### Trap 1 — `alloca` is effectively mandatory, not one option of three

🔴 The lookup is **unguarded**. `host.js:11523` reads
`const alloca = instance.exports.alloca` inside the `args.length > 0` branch, and it
tests nothing before it calls the value. `host.js:11725` makes `args[0]` the path of
the module, and the OS always passes an argv, so that branch always runs.

**A Rust module without an `alloca` export therefore traps at start-up**, before
`main`, with `alloca is not a function`. This is not a degraded mode and it is not a
missing feature. It is an immediate failure of every Rust binary. Record it in the
crate as a fixed part of the contract, with this consequence spelled out.

`__set_environ` and `__wasm_call_ctors` are optional. `host.js` guards both calls.

### Trap 2 — link WITHOUT `--allow-undefined`

🔴 `wasm-ld` with `--allow-undefined` turns an undefined symbol into an import from
the module **`env`**. `host.js` supplies the module **`"c"`** and nothing else
(`host.js:3`, `const ENV_KEY = "c"`). So an import that lands in `env` is
unsatisfiable, and the module fails when it loads — far from the `extern` block that
caused it.

Two rules follow, and both are loud-failure requirements, not style notes.

1. **Every Rust `extern` block carries an explicit
   `#[link(wasm_import_module = "c")]`.** Rust attributes the block to `env` by
   default, so a missing attribute is silent.
2. **The Rust build links without `--allow-undefined`.** A symbol nobody defined
   then fails at **link** time, where the message names the symbol, instead of at
   run time, where it names only the module.

The clang sibling uses `--allow-undefined` in one test harness
(`~/git/clang-simplified/wasm/tools/run-libc-test.sh:94`). Do not copy that setting
into the Rust build.

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
- The build links without `--allow-undefined`. A test drops the
  `#[link(wasm_import_module = "c")]` attribute from one block and asserts that the
  **link** fails, and that the message names the symbol.
- A test builds a module with no `alloca` export and asserts the start-up trap. The
  contract is only fixed once something proves it.
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
