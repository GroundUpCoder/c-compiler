# todos/RUST.md — Rust on gucOS

The program document for Rust as a first-class gucOS language. The scheduled units
are `todos/0413` … `todos/0418`. This file holds what those units share: the ABI
contract, the architecture rules, and the evidence. It is not a schedule. Every
unit of work is a ticket.

- **Status**: program open (filed 2026-07-29).
- **Precedent**: `todos/CLANG-CPP-EPIC.md`. That document is the same problem, one
  language over. Every rule below inherits from it.
- **Provenance**: a feasibility investigation and a design pass ran off-repo in
  `~/git/meta/gucos/notes/` (`rust-on-gucos-investigation.md`,
  `rust-fable-designpass-kickoff.md`, `rust-p0-codex-wasm-census.md`,
  `rust-p1-c-abi-emit-probe.md`). The design pass ruled **proceed with
  modifications**. The numbers that a ruling depends on are copied into the
  tickets, so a ticket stays readable without the off-repo documents.

---

## 1. The verdict

Split the program in two, and move the gate.

- **The gucOS Rust toolchain is funded unconditionally.** `todos/0413` …
  `todos/0416`. The path is bounded work. A probe already ran it end to end.
- **The application half is gated on measurement.** The first target application is
  OpenAI's Codex CLI in its headless `codex exec` form. The design pass found that
  half materially under-costed. `todos/0418` is the decider that rules on the Rust
  standard library, and no application work starts before that ruling.
- **A ChatGPT sign-in is structurally impossible on gucOS.** The sign-in needs a
  local TCP listener for the OAuth redirect. gucOS has no TCP layer, and it has no
  listener of any kind. The design is therefore **API-key-only**. Do not schedule a
  sign-in flow.
- **`todos/0417` (HTTP transfers become OFDs) is independent.** File it, and land
  it, whatever a Rust decision says. `/bin/curl` and every future networked C
  application want it today.

---

## 2. The ABI contract a Rust module must satisfy

A gucOS process binary is not a WASI module and not a stock `wasm32-*` module. The
contract is small, and it is fixed. `todos/0413` writes it into a header comment in
the crate that supplies it.

**The import namespace is the literal string `"c"`.** `host.js:3` declares
`const ENV_KEY = "c"`. The imports are named C functions, not numbered calls. The
stable Rust attribute `#[link(wasm_import_module = "c")]` sets that name. The
attribute needs no nightly compiler and no custom target specification.

**The module must export three names.**

| Export | Why |
|---|---|
| `main` | `host.js` calls `main(argc, argv, envp)` directly. There is no `_start`. |
| `memory` | The host reads and writes the linear memory of the module. |
| `alloca` | `host.js` plays crt0 itself. It lays out `argv` and `envp` in the memory of the module, and it calls this export to get the space (`host.js:11496`, `host.js:11525-11545`). |

**`alloca` is not optional.** `host.js:11725` makes `args[0]` the path of the
module, so the argv path always runs. A module without an `alloca` export fails at
run time with `alloca is not a function`. A C module from this compiler exports
`alloca` for free. A Rust module does not.

**Two exports are optional.** `host.js` calls `__set_environ` only when the caller
supplies an environment, and it calls `__wasm_call_ctors` only when the module
exports it. Both calls are guarded.

**The memory must be growable and it must not be shared.** The probe module
declared `min=17 pages, max=NONE`, which is correct.

**Errors follow the C convention.** A failed call returns `-1` and sets the error
name. `time_t` crosses as i64.

**There is no dynamic linking.** Everything links statically into one module.

---

## 3. The architecture rules

These rules bind every ticket in the program.

1. **One ABI.** Rust reaches the host through the `"c"` import set and nothing
   else. A second import namespace is a second host ABI, and the kernel would have
   to serve both. `todos/0418` is the one place that may re-open this, because
   option (b) there costs exactly that.
2. **One libc.** `todos/0414` (`gucos-sys`) is the single Rust-side declaration of
   the import set. Link the vendored C libc only where a C body exists and Rust has
   none. Do not stand up a second libc for Rust.
3. **One heap.** The Rust `#[global_allocator]` delegates to libc `malloc`. A bump
   allocator over `__heap_base` puts two allocators in one linear memory, and each
   one then hands out memory the other believes it owns. The clang port already
   backs its `alloca` export with `malloc`
   (`~/git/clang-simplified/wasm/compat/alloca_stub.c:16`). Rust does the same.
4. **One producer.** The Rust crates and the build live in a **sibling repository**,
   as `~/git/clang-simplified` does for clang. This repository consumes artifacts.
   It never invokes `rustc`.
5. **The base image ships no Rust.** Rust binaries reach a user through opt-in
   `-rust` gucman packages, and the `-rust` packages mirror the `-clang` packages.
   `todos/0416` carries a guardrail that proves the base image stays
   byte-identical.
6. **Loud failure, never a silent skip.** An explicit request for Rust with no
   sibling present must fail with an actionable message. An **un**requested absent
   sibling stays a normal state. This is rule 2 of `todos/CLANG-CPP-EPIC.md` §4,
   unchanged.

---

## 4. The work map

| Ticket | Lane | Unit |
|---|---|---|
| `0413` | A1 | A `no_std` Rust binary runs in gucOS. |
| `0414` | A2 | `gucos-sys` — the one Rust binding to the `"c"` ABI. |
| `0415` | A3 | A real `-rust` tool over BlockFS. |
| `0416` | A4 | The `native-sibling` packaging seam. |
| `0417` | B1 | HTTP transfers become OFDs. |
| `0418` | C1 | The standard-library decider. |

Two units are named but **not filed**, because each one waits on a ruling.

- **C2 — the chosen standard-library work.** `todos/0418` writes its scope. File it
  after the ruling.
- **D1 — port `codex exec`, or write a native gucOS client on the same wire
  protocol.** This one waits on the ruling of `todos/0418` **and** on `todos/0417`.
  Do not file it earlier. A decision taken without those two inputs is a guess.

---

## 5. What the probe proved

A probe ran on 2026-07-29 (`rust-p1-c-abi-emit-probe.md`). It answered the emit
question, and the answer is yes.

- `rustc 1.96.1`, **stable**. Target `wasm32-unknown-unknown`. Crate type
  `cdylib`. The crate is `#![no_std]`.
- No nightly compiler. No custom target specification. No `wasm-bindgen`. No WASI.
- The module imported `write` from module `"c"`, exported `main`, and declared a
  growable memory. All three were correct on the first build.
- `node host.js <module>` printed the message and exited 0.
- The one property that the specification missed was the `alloca` export. Section 2
  above records it as a fixed part of the contract.

The probe did not test `alloc`, a second syscall, or the packaging path. It tested
the shape of the module and the entry contract only.
