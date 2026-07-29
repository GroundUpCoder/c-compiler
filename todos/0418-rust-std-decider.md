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

🔴 **The null result stays OPEN, and no probe fires to close it.** That is a
standing call, and it is deliberate. The 9 crates are all C or C++ build scripts, so
they price the **application** half and not the standard-library choice. A ruling on
the standard library therefore does not need them. **Make the ruling robust to
either answer, and say which answer it assumed.** Carry the null result forward to
D1 as an open input.

### 🔴 `ring` — an OPEN DISPUTE, settled by neither side

Two design passes read `ring` and reached **opposite** answers. Record the dispute.
Do **not** inherit either verdict as a fact.

- **Pass one says refuted.** `ring-0.17.14/build.rs:594-599` says "Allow
  cross-compiling without a target sysroot for these targets" and tests
  `target.arch == WASM32`, and `Cargo.toml:180` declares the feature
  `wasm32_unknown_unknown_js`. On that reading `ring` expects a wasm build, and it
  failed here only because of the missing C compiler.
- **Pass two says blocked.** It read `ring` **and** `aws-lc-rs` in the tree and
  found "no wasm story" for either.

**Record the asymmetry of the evidence.** Pass one cites two specific locations:
`build.rs:594-599`, which tests `target.arch == WASM32`, and `Cargo.toml:180`, which
declares the feature. Pass two cites a general impression and gives no location. That
asymmetry is a fact about the evidence, and it belongs on the record. ⚠️ **It is not
a licence to settle the dispute.**

🔴 **`ring` is a MEMBER of the unmeasured class below, not an independent open
question.** It failed the census for the one reason every crate in that class failed:
this machine has no C compiler that can target wasm. The same standing call therefore
covers it — **no probe fires**. A later reader must not treat `ring` as a loose end
that some cheap check could close.

**Settle it by measurement, not by reading.** One build of `ring` for the wasm
triple, with a C compiler that can target wasm, answers it. A source read can refute
a claim that a crate is a **blocker**. A source read cannot establish that a crate
**builds**. So until that build runs, ⭐ **`ring` is neither a blocker nor cleared.**

The operative half is already settled and needs no dispute: the true-blocker list
above holds `socket2`, `tokio`, `aws-lc-sys` and `v8`, and `ring` is correctly
absent from it.

### `tokio` — a wasm arm exists, but it does not mean what it sounds like

The error is a feature check, not an absent port. The graph resolves `tokio` with
`full`, and the wasm arm permits `sync`, `macros`, `io-util`, `rt` and `time`.

⚠️ **"A feature reduction, not a fork" is TRUE in general and materially misleading
for THIS tree.** A second pass found three facts that weaken it:

- codex **hand-builds** a multi-thread runtime. It does not take a default.
- `rt-multi-thread` is an **explicit** feature in **five** crates.
- **Two `block_in_place` call sites hard-panic** on a `current_thread` runtime.

gucOS is single-threaded per process, so `current_thread` is the only runtime
available. Each of those three facts is hand work in codex's own crates, and the
last one is a run-time panic, not a compile error. Keep the general statement, and
keep this qualification beside it.

**Claim 6 is NOT MEASURED.** The census used the two standard triples only. It never
built a custom target specification, so it is not a test of "a novel
`target_os = "gucos"` matches nothing". Treat that claim as open. It is an input to
option (a) above.

## 🔴 The blocker the design pass missed — corroborated twice, priced never

**codex has almost no feature-flag surface. A subsystem cannot be cut with a flag.**

Two passes reached this independently, and the second stated it more strongly.

- 132 workspace manifests exist.
- **2** of them declare a `[features]` section: `code-mode/Cargo.toml` and
  `v8-poc/Cargo.toml`.
- `exec/Cargo.toml` and `core/Cargo.toml` declare none.
- The workspace declares **ZERO optional dependencies**.

🔴 **So the premise that "a cargo feature keeps `reqwest` out of the wasm build" is
REFUTED. There is no feature to flip.** The original design leaned on that premise,
and it does not hold. Every "keep X out" is hand-authored Cargo surgery inside a
**maintained fork**, and a maintained fork is a recurring cost, not a one-time edit.

Every optional-looking subsystem is an **unconditional** dependency. The estimate
leaned on "cut the subsystem" to shed the JavaScript sandbox (`v8`), the state store
(`libsqlite3-sys`), the terminal emulation (`serial2`), the git integration
(`gix-fs`) and the crash telemetry (`sentry-contexts`, `uname`, `openssl-sys`). None
of those leaves with a flag. Removing one means editing manifests and deleting call
sites.

**This work is UNPRICED, and the ticket says so on purpose.** No estimate for it
exists anywhere. Produce one here, and mark it clearly as the first estimate rather
than a carried one.

## 🔴 The nightly contradiction, which this ticket must resolve

Two carried claims disagree, and the ruling has to pick.

- **"Stable `rustc 1.96.1` is sufficient."** True, and measured — on
  `wasm32-unknown-unknown`, with `#![no_std]` and crate type `cdylib`. That is
  `todos/0413`'s path, and `core` and `alloc` ship precompiled for that target.
- **The custom target specification path is nightly-only.** It needs
  `-Zbuild-std=core,alloc`, which is unstable. **No nightly toolchain is installed
  on this machine.** That is option (a) above, and it is a **different path** from
  the one the probe measured.

🔴 **Do not let "stable is sufficient" stand unqualified. State WHICH path the
program takes, and therefore whether nightly is required.** If the ruling picks a
path that needs nightly, it also buys a **pinned nightly toolchain plus a documented
procedure for bumping it** — a permanent maintenance discipline that the original
investigation never mentions. Price that discipline in the ruling, beside the fork
and the rebase.

## Scope facts the census does not yet carry

The crate map of the original investigation is out of date. Three facts change the
size of the application half, and the ruling must record them even though they
belong to D1.

**(a) WebSockets are the default, and they cannot be configured away.**
`supports_websockets = true` is hardcoded for the built-in OpenAI provider, and
`disable_websockets` is a private atomic latch, **not** a configuration key. The
original plan assumed a configuration flag would select the HTTP and
server-sent-event path. It will not. gucOS has no WebSocket transport, so this is a
code change in codex, not a setting.

**(b) The 838-crate census may UNDERSTATE the port.** An in-process application
server of roughly 64,000 lines now rides the exec path, and the crate map predates
it. Flag this explicitly whenever the 838 figure is quoted.

**(c) The sandbox model is platform-blind.** `should_run_in_sandbox()` does not test
the platform, and it self-re-executes a filesystem-helper subprocess for each file
operation on an unknown operating system. The fix is to default to
`danger-full-access`: **the browser tab IS the sandbox**, and a second sandbox
inside it buys nothing and costs a process per file.

## Plan

1. **Answer the nightly question first.** It is the cheapest input, it is decided by
   reading, and it separates option (a) from the other two on a cost the estate
   carries forever.
2. Price the recurring cost of each of the three options: the nightly dependency and
   its bump procedure, the rebase cadence of a forked standard library, the size of
   the shim, and the ABI change at the deploy edge.
3. Cost the manifest surgery, which is unpriced today.
4. Record the `ring` dispute and the D1 scope facts as open inputs, and state which
   answer the ruling assumed for each.
5. Write the ruling.

⚠️ **Do not fire a probe.** Neither the census re-run nor a measurement of the 83
codex-owned crates happens under this ticket. Both are D1 inputs. This ticket rules
on the standard library, and it rules with the open items named.

## Acceptance

- A written ruling lands in `todos/`. It names ONE option, and it gives the reason.
- The ruling carries the numbers above, **with the null result attached**. A number
  quoted without its population warning is not evidence.
- The ruling states the recurring cost of the chosen option in words a future
  reader can hold the estate to: nightly or stable, rebase or no rebase, one import
  namespace or two.
- The ruling states **whether the chosen path needs a nightly compiler**. If it
  does, it also names the pinned version and the procedure for bumping it.
- The ruling names every open input it did not settle — the `ring` dispute, the 9
  unmeasured crates, and the three D1 scope facts — and states the answer it assumed
  for each.
- The ruling gives the first estimate for the manifest surgery, and marks it as a
  first estimate.
- The ruling records both positions on port versus native, and settles neither.
- The ruling scopes C2, and C2 is filed as its own ticket.
- If the ruling is (b), it states what changes at the deploy edge, because a second
  import namespace is a base-image ABI change.
- `node todos/queue.js check` passes.

## What this ticket does NOT settle

It does not decide the application. **D1 — port `codex exec`, or write a native
gucOS client on the same wire protocol — is not filed**, and it waits on this ruling
**and** on `todos/0417`. A decision taken without both inputs is a guess.

### 🔴 Port versus native is OPEN. Record both positions, and settle neither here.

Two positions exist, and they are not the same kind of thing. Write both into the
ruling, and mark which is which.

- **A coordinator leans toward the native client.** That is a lean. It is a
  judgement about scope, and it is worth recording because it shows where the
  estate's attention sits.
- **A second design pass explicitly REFUSES to pre-judge.** Its words: it is not
  recommending native — it is recommending that the decision be made on the numbers
  of the census, and not on the sizing of the investigation document, which is now
  refuted.

🔴 **A coordinator lean is not a measurement. Do not record "native is the lean" as
settled**, and do not let a lean stand in for the census when D1 is written. The
refusal to pre-judge is itself the ruling on this question, and D1 inherits it.

`todos/RUST.md` §1 records one application decision that no ruling changes: the plan
is **API-key-only**, because `codex login` is out of scope for the headless
`codex exec` form.

⚠️ **Do not restate that as "a sign-in is structurally impossible".** An earlier
draft did, and its mechanism was false. A listener-free device-code flow exists in
the tree at `login/src/device_code_auth.rs`, and `TcpListener` appears in no file
under `login/src/`. The scope decision stands. The impossibility claim does not.
