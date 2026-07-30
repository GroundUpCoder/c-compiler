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
  **RULED 2026-07-30**: the standard library is upstream's, on `wasm32-wasip1`
  (option b) — stable rustc, no fork, no rebase, a `wasi_snapshot_preview1` host
  shim beside `"c"`. The full ruling with its numbers and open inputs is
  `todos/done/0418-rust-std-decider.md` §"Result". C2 is filed as `todos/0442`.
- **The plan of record is API-key-only, because `codex login` is out of scope.**
  This program targets the headless `codex exec` form, and a sign-in flow is not part
  of it. Do not schedule one.
  ⚠️ **Do not carry the old reasoning for this line.** An earlier draft said a
  ChatGPT sign-in was "structurally impossible" because the sign-in needs a local TCP
  listener for an OAuth redirect. **That mechanism is false.** A listener-free
  device-code flow exists in the tree at `login/src/device_code_auth.rs`: it polls
  over HTTP, so it needs no redirect and no listener. `TcpListener` appears in no
  file under `login/src/`. Read that file first if the scope ever changes.
  ⚠️ **A second corrected fact, 2026-07-30. This line said "WebSockets are the
  hardcoded default transport, and no configuration key turns them off."** The
  first half is true and the second half is false, so read them separately.
  **True**: the **built-in** OpenAI provider does hardcode
  `supports_websockets = true` (`model-provider-info/src/lib.rs:362`).
  **False**: `supports_websockets` IS a configuration key on a model provider
  (`model-provider-info/src/lib.rs:138-140`, `#[serde(default)]` false), so a
  custom provider entry runs pure HTTP with **no code change** — which is the
  API-key-only mode above. codex also has an automatic, tested, sticky HTTP
  fallback (`core/src/client.rs:508-527`).
  ⇒ **A WebSocket transport is NOT a prerequisite for this program. `todos/0417`
  is.** `todos/0418` scope fact (a) carries the full correction, including which
  original observations survive; the authority is
  `~/git/meta/gucos/notes/websockets-and-platform-limits.md` §1.1(a).
  ⚠️ **This correction is about transport selection ONLY.** Do not extend it to
  codex's feature-flag surface, which is a separate and UNVERIFIED question.
- **`todos/0417` (HTTP transfers become OFDs) is a hard, unconditional
  prerequisite.** It is not contingent on any ruling, and it blocks a port and a
  native client equally. Two independent design passes reached it separately.
  `/bin/curl` and every future networked C application want it today.

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

**`alloca` is not optional, and the lookup is UNGUARDED.** `host.js:11523` reads
`instance.exports.alloca` and calls it without a test. `host.js:11725` makes
`args[0]` the path of the module, and the OS always passes an argv, so that path
always runs. **A Rust module without an `alloca` export traps at start-up, before
`main`.** A C module from this compiler exports `alloca` for free. A Rust module
does not. `todos/0413` Trap 1 holds the detail.

**Every Rust `extern` block names the import module explicitly.** Rust attributes an
unmarked block to the module `env`, and `wasm-ld` with `--allow-undefined` sends a
missing symbol there too. `host.js` supplies `"c"` and nothing else, so anything in
`env` is unsatisfiable and the module fails when it loads. Mark every block
`#[link(wasm_import_module = "c")]`, and link **without** `--allow-undefined` so a
miss fails at link time with the name of the symbol. `todos/0413` Trap 2 holds the
detail.

**Two exports are optional.** `host.js` calls `__set_environ` only when the caller
supplies an environment, and it calls `__wasm_call_ctors` only when the module
exports it. Both calls are guarded.

**The memory must be growable and it must not be shared.** The probe module
declared `min=17 pages, max=NONE`, which is correct.

**Errors follow the C convention.** A failed call returns `-1` and sets the error
name. `time_t` crosses as i64.

**There is no dynamic linking.** Everything links statically into one module.

### The wasip1 entry — the `todos/0442` amendment

A wasip1 std module does not follow the host-played crt0 contract above. The
host detects the shape and uses the wasip1 convention instead.

- **Detection.** The module imports `wasi_snapshot_preview1`, exports
  `_start`, and does not export `main`. The host then calls `_start()` and
  does not touch `alloca` or `__set_environ`. Such a module does not need
  the `alloca` or `main` exports.
- **Arguments and environment.** The program pulls argv and envp through
  `args_get` and `environ_get`. The shim serves them from the same values
  that the host lays out for a `"c"` module.
- **Exit.** A normal return from `_start` is exit 0. A nonzero exit goes
  through `proc_exit`. Both paths run the ordered exit handshake of the
  kernel.
- **Both namespaces in one module.** `gucos-sys` compiles unchanged for
  `wasm32-wasip1` with `default-features = false` — the standard library
  owns the panic handler on that rung. Every `"c"` rule above applies to
  the `"c"` imports of the module.
- **The runtime.** The shim is `BlockFS.prototype.toWasiPreview1` in
  `host.js`. It delegates to the same fs method surface as `toWasmEnv`, so
  BlockFS (standalone `--block-fs`) and RemoteFS (each OS process) share
  one shim. The Node-fs flavor of `node host.js` does not serve the
  namespace and refuses with an actionable message.
- **Preopens.** The shim preopens exactly ONE directory: `/`. The preopen
  is a REAL fd in the process fd table, opened before wasm runs, so it
  takes the lowest free fd — 3 in the normal spawn shape. wasi-libc probes
  the fds from 3 up and stops at the first `EBADF`. Do not seed extra fds
  above 2 into a wasip1 process: an fd below the preopen stops the probe
  early.
- **Recorded limits.** WASI preview 1 has no process cwd. wasi-libc
  emulates one, and it starts at `/` in every process, whatever cwd the
  spawn set. The `"c"` errno bridge (`__errno_set`) is absent unless the
  module links a provider, so a failed `"c"` call reports through its
  return value only. `std::net` stays unsupported — the four `sock_*`
  imports are absent from the shim on purpose, and a module that imports
  one fails at instantiation with the name.

---

## 3. The architecture rules

These rules bind every ticket in the program.

1. **One ABI — amended by the `todos/0418` ruling (2026-07-30).** Rust reaches
   the host through the `"c"` import set, plus exactly ONE sanctioned second
   namespace: `wasi_snapshot_preview1`, served by `host.js` for wasip1 std
   programs (`todos/0442`). That namespace is frozen upstream, so it has no
   churn and no version chase. Every gucOS-specific capability (spawn, signals,
   tty, http, clipboard, …) still reaches the host through `"c"` and nothing
   else. **No third namespace, ever.**
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
| `0418` | C1 | The standard-library decider. Ruled 2026-07-30: option (b), wasip1. |
| `0442` | C2 | std on wasip1: the `wasi_snapshot_preview1` shim. Shipped 2026-07-30 (`toWasiPreview1` in host.js; the wasip1 entry in §2). |

| `0445` | C3 | codex feasibility: close the census nulls. Closed 2026-07-31 (ticket `#190`): all 102 codex crates measured; report `~/git/meta/gucos/notes/rust-codex-feasibility-2.md`. |
| `0446` | A5 | `gucos-sys::http` still binds the HTTP ABI that `0417` retired. Ticket `#191`, open — the root of the D2 chain. |
| `0447` | **D1** | codex on gucOS: port `codex exec`, or write a native client. **Ruled 2026-07-31** (ticket `#192`): `todos/RUST-D1-RULING.md`. |
| `#292` | D2 | gucos-rust: a codex `HttpTransport` implementation over the fd HTTP ABI, with a streamed SSE proof. Blocked by `#191`. |
| `#293` | D3 | M1 — the port runtime spike on the 0442 shim: size, startup, `current_thread` verdict. Blocked by `#292`. |
| `#294` | D4 | M2 — the wasm C toolchain experiment: verdicts for the 9 asm-FFI crates. |
| `#295` | D5 | Apply the D1 selection rule (`RUST-D1-RULING.md` §7) to the M1+M2 numbers. Blocked by `#293`, `#294`. |

**D1 is RULED, 2026-07-31** (ticket `#192`; the document is
`todos/RUST-D1-RULING.md`). The ruling is staged, and it does not pre-judge —
it keeps the `todos/done/0418` §Result item 9 refusal. What it settles now: a
port is not blocked at the compile level (0445 closed class D — all 102 codex
crates measured, 41 with zero intrinsic platform coupling); the wire protocol
is the Responses API alone, unversioned, with a real two-method transport seam
(`HttpTransport`); and both arms share the same HTTP prerequisites (`#191`,
then `#292`). What still decides the arm is two missing measurements — M1
(runtime, size, startup: `#293`) and M2 (the wasm C toolchain: `#294`) — and
the selection rule over them is FIXED in the ruling's §7. `#295` applies that
rule; it does not reopen the debate. The reopen triggers are the ruling's §9.

---

## 5. What the probe proved

A probe ran on 2026-07-29 (`rust-p1-c-abi-emit-probe.md`). It answered the emit
question, and the answer is yes.

- `rustc 1.96.1`, **stable**. Target `wasm32-unknown-unknown`. Crate type
  `cdylib`. The crate is `#![no_std]`.
- No nightly compiler. No custom target specification. No `wasm-bindgen`. No WASI.

⚠️ **That result covers ONE path, and it does not generalize.** A custom target
specification needs `-Zbuild-std`, which is unstable, so that path is nightly-only.
`todos/0418` ruled (2026-07-30): the program takes the `wasm32-wasip1` path for
std programs, which is a stable tier-2 target — **no path in this program needs a
nightly compiler**. Lanes A1 to A4 stay on a stable compiler, because `core` and
`alloc` ship precompiled for `wasm32-unknown-unknown`.
- The module imported `write` from module `"c"`, exported `main`, and declared a
  growable memory. All three were correct on the first build.
- `node host.js <module>` printed the message and exited 0.
- The one property that the specification missed was the `alloca` export. Section 2
  above records it as a fixed part of the contract.

The probe did not test `alloc`, a second syscall, or the packaging path. It tested
the shape of the module and the entry contract only.
