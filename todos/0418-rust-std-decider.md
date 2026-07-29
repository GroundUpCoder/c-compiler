# 0418 — DECIDER: which Rust standard library does gucOS get?

- **Status**: open
- **Design**: `todos/RUST.md` §1 and §3.
- **Provenance**: the Rust program, filed 2026-07-29. The design pass ruled
  "proceed with modifications", and this ticket is the modification: **the gate moved
  in front of the application half.**

## What this ticket is

🔴 **This is a decider. It writes a ruling, not code.** Its output is a written
answer in `todos/`, with the numbers below in it.

🔴 **Do not start the standard-library work (C2) without this ruling.** C2 is not
filed, because its scope is what this ticket decides.

The gate that held this ticket was a wasm-resolvability census of the `codex-exec`
dependency graph. **The census ran on 2026-07-29, and the gate cleared.** Section
"The evidence" holds its result.

## The question

Rust programs on gucOS have `core` and `alloc` today. `todos/0414` gives them a
working `#[global_allocator]`, so `Vec`, `String`, `Box`, `BTreeMap`, iterators,
sorting and `format!` all work. Those types are **not** in the standard library.

What the standard library uniquely adds is the layer that faces the operating
system: `fs`, `net`, `thread`, `process`, `time`, `env`, standard input and output,
and the seeded hasher of `HashMap`. The reason to want it is not the types. The
reason is that most of the crate ecosystem is written against it and will not
compile without it.

So: **which standard library, at what recurring cost?**

## The three options

### (a) A patched standard library on a custom `"c"` target

Write `wasm32-unknown-gucos.json`, build the sysroot with `-Zbuild-std`, and back
the `sys` layer of the standard library onto the `"c"` imports.

🔴 **This is the biggest mispricing in the original investigation, and the ruling
must price it honestly.** The investigation presented it as the clean general
answer. Its recurring costs are:

- `-Zbuild-std` is unstable, so this option is **nightly forever**. Every build of
  every Rust program on gucOS then depends on a nightly compiler.
- A patched standard library is a **fork that needs a rebase on every rustc
  release**. That is a standing maintenance debt with no end date, carried by this
  estate alone.
- A novel `target_os = "gucos"` matches **no** `cfg` arm in the ecosystem. Every
  crate with platform code has to grow an arm, or be patched. **The census did not
  measure this** (see claim 6 below), so treat the size of it as open.

### (b) `wasip1`, with a host shim onto the same kernel RPCs

Build for `wasm32-wasip1`, and serve `wasi_snapshot_preview1` in `host.js` by
delegating to the kernel RPCs that already exist.

- The standard library for `wasip1` is upstream, it is maintained, and it is
  **stable**. No fork, no nightly, no rebase.
- The shim is a real cost: it is a **second host import namespace** that the kernel
  must serve beside `"c"`. `todos/RUST.md` §3 rule 1 forbids that in general, and
  this ticket is the one place allowed to re-open it. Price it: a base-image ABI
  change makes `host.js` and the baked image revalidate in lock-step at the deploy
  edge.
- ⭐ The structural match is better than the investigation credited. The unified
  `FS_WAIT` at `kernel.js:3864` — file descriptors, plus the input ring, plus a
  timeout, plus signal interruption — **is** `poll_oneoff` in a different spelling.
  Most of `wasip1` is the filesystem, and gucOS already has a full POSIX-shaped
  filesystem behind those RPCs.
- ⭐ **Stock `wasm32-unknown-unknown` on stable already IS the free "stubbed std"
  rung.** The standard library is present there and inert: the unbacked calls
  error, the backed ones work. `todos/RUST.md` §5 records that a stable module for
  this target runs on gucOS today. So "compile the world early, light up the calls
  in priority order" costs **nothing** to start. Weigh (b) against that baseline,
  not against zero.

### (c) Upstream a tier-3 target

Take `wasm32-unknown-gucos` into rustc as a tier-3 target.

- It removes the fork and the rebase, because the target lives upstream.
- It adds a review cycle this estate does not control, and a maintainer obligation.
- It is only worth considering after (a) has been shown to work, so it is a
  successor to (a) and not an alternative to it.

## The evidence — the census, with its null result attached

Source: the P0 census, 2026-07-29
(`~/git/meta/gucos/notes/rust-p0-codex-wasm-census.md`). Reproduction scripts are
preserved at `~/git/meta/gucos/notes/rust-probe-scripts/`.

**The graph is 838 crates, not 1334.** 1334 is the package count of
`codex-rs/Cargo.lock`. It is not a build graph. The `codex-exec` graph for
`wasm32-wasip1` holds **838** distinct crate names.

| Class, target `wasm32-wasip1` | Count |
|---|---|
| The library compiled for wasip1 | **543** |
| The crate ran only on the host, as a build script or a proc macro | 76 |
| The crate **failed** | **22** |
| The build never reached the crate | 197 |
| Total | 838 |

- **543 of 838 already compile. That is 65 percent.** `serde_json`, `url`, `uuid`,
  `getrandom`, `http`, `regex`, `clap`, `chrono` and `reqwest` are in that set.
- The 76 host-side crates are not a problem. A build script always compiles for the
  host.
- The 197 unreached crates are not a set of unknown problems. 83 of them are codex's
  own crates, which are the target of a port. The rest sit behind `tokio` and
  `socket2`.
- **Only 4 of the 22 failures are true structural blockers today**: `socket2` (no
  sockets), `tokio` (threads), `aws-lc-sys` (no wasm arm anywhere in the crate) and
  `v8` (a C++ JavaScript engine).

⚠️ **9 of the 22 failures are UNMEASURED. Do not record them as unbuildable.** The
machine that ran the census has **no C compiler that can target wasm**. Apple clang
21.0.0 answers `No available targets are compatible with triple
"wasm32-unknown-wasip1"`. Every failure with a C or C++ build script came from the
instrument, not from the crate. Three of those crates carry direct evidence that
they expect a wasm build: `libsqlite3-sys` ships `sqlite3/wasm32-wasi-vfs.c`,
`zstd-sys` ships a `wasm-shim/`, and `tree-sitter` reads `CARGO_FEATURE_WASM`.

**`ring` is REFUTED.** The earlier claim was that `ring` does not build for wasm.
`ring-0.17.14/build.rs:594-599` says "Allow cross-compiling without a target sysroot
for these targets" and tests `target.arch == WASM32`, and `Cargo.toml:180` declares
the feature `wasm32_unknown_unknown_js`. `ring` expects a wasm build. It failed here
because of the missing C compiler.

**`tokio` has a wasm arm.** The error is a feature check, not an absent port: the
graph resolves `tokio` with `full`, and the wasm arm permits `sync`, `macros`,
`io-util`, `rt` and `time`. The work is a reduction of the feature set, not a fork
of `tokio`. The open question is a different one — whether codex's own code runs on
the reduced set.

**Claim 6 is NOT MEASURED.** The census used the two standard triples only. It never
built a custom target specification, so it is not a test of "a novel
`target_os = "gucos"` matches nothing". Treat that claim as open. It is an input to
option (a) above.

## 🔴 The blocker the design pass missed

**codex has almost no feature-flag surface. A subsystem cannot be cut with a flag.**

- 132 workspace manifests exist.
- **2** of them declare a `[features]` section: `code-mode/Cargo.toml` and
  `v8-poc/Cargo.toml`.
- `exec/Cargo.toml` and `core/Cargo.toml` declare none.

Every optional-looking subsystem is therefore an **unconditional** dependency. The
whole estimate leaned on "cut the subsystem" to shed the JavaScript sandbox (`v8`),
the state store (`libsqlite3-sys`), the terminal emulation (`serial2`), the git
integration (`gix-fs`) and the crash telemetry (`sentry-contexts`, `uname`,
`openssl-sys`). None of those leaves with a cargo flag. Removing one means editing
manifests and deleting call sites.

**That work has no estimate anywhere. Produce one in this ticket.** It is a cost of
the application half, and the ruling must hold it.

## Plan

1. **Close the null result first.** Install a C toolchain that targets wasm, and
   repeat the census run. This is the cheapest step, and it settles 9 of the 22
   failures, `ring` among them. A ruling made on an instrument fault is a guess.
2. Measure the 83 codex-owned crates that the census never reached. They are the
   real port.
3. Cost the manifest surgery of the section above.
4. Price the recurring cost of each of the three options: the nightly dependency,
   the rebase cadence, the size of the shim, and the ABI change at the deploy edge.
5. Write the ruling.

## Acceptance

- A written ruling lands in `todos/`. It names ONE option, and it gives the reason.
- The ruling carries the numbers above, **with the null result attached**. A number
  quoted without its population warning is not evidence.
- The ruling states the recurring cost of the chosen option in words a future
  reader can hold the estate to: nightly or stable, rebase or no rebase, one import
  namespace or two.
- The ruling scopes C2, and C2 is filed as its own ticket.
- If the ruling is (b), it states what changes at the deploy edge, because a second
  import namespace is a base-image ABI change.
- `node todos/queue.js check` passes.

## What this ticket does NOT settle

It does not decide the application. **D1 — port `codex exec`, or write a native
gucOS client on the same wire protocol — is not filed**, and it waits on this ruling
**and** on `todos/0417`. A decision taken without both inputs is a guess.

`todos/RUST.md` §1 records one application fact that no ruling changes: a ChatGPT
sign-in needs a local TCP listener for its redirect, gucOS has no listener of any
kind, and so the design is **API-key-only**.
