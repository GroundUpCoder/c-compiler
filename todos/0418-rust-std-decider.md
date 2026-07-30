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

**(a) 🔴 CORRECTED 2026-07-30 — WebSockets are the default for the BUILT-IN
provider only, and they CAN be avoided with no code change. Do not carry the
earlier version of this fact.**

⚠️ **This paragraph drew the wrong conclusion until 2026-07-30.** A design pass
read the codex tree at `2e1607ee2f`. The authority is
`~/git/meta/gucos/notes/websockets-and-platform-limits.md` §1.1(a). **Read that
memo before you rule on anything that depends on this fact.**

🔴 **The correction has a NARROW scope. Two of the three original observations
are still good, and you must not discard them with the conclusion.**

- ✅ **STILL TRUE, and it stays on the record:** `disable_websockets` **really is
  a private atomic latch**, not a configuration key. That observation was never
  wrong. **The error was to treat it as the ONLY lever**, and so to conclude that
  the HTTP and server-sent-event path needs *a code change in codex, not a
  setting*. **It is the conclusion that falls, not the observation.**
- ✅ **STILL TRUE:** the built-in OpenAI provider constructor hardcodes
  `supports_websockets = true` (`model-provider-info/src/lib.rs:362`).
- ❌ **REFUTED:** "no configuration key turns them off", and therefore
  "WebSockets are a hard prerequisite for this program".

The paragraph missed a **second** lever at the provider level, and a **third** at
run time. Either one avoids WebSockets with no code change.

**Two independent paths onto plain HTTP/SSE exist, and neither one edits codex.**

1. **`supports_websockets` IS a configuration key.** It is a deserializable
   field on a model provider — `model-provider-info/src/lib.rs:138-140` declares
   it `#[serde(default)]`, so it defaults to **false**. A `config.toml`
   `[model_providers.<id>]` entry sets it, and a config test deserializes that
   exact TOML shape (`core/src/config/config_tests.rs:935-949`). The **built-in**
   OpenAI provider constructor does hardcode `true`
   (`model-provider-info/src/lib.rs:362`) — that half of the old claim is
   accurate — but a **custom provider entry** that points at the same API, with
   the field absent, runs pure HTTP. The plan of record is API-key-only
   (`todos/RUST.md:30-32`), which is exactly the mode a custom provider entry
   serves. So "no configuration key turns them off" is true of the built-in
   entry and **false of the provider mechanism**.
2. **The HTTP fallback is automatic, tested and sticky.** The latch above is
   real, and **codex flips it itself** — which is why the latch being private
   does not block anything. `force_http_fallback`
   (`core/src/client.rs:508-527`) latches the atomic;
   `try_switch_fallback_transport` (`core/src/client.rs:1826-1843`) documents
   it. A dedicated suite pins the behaviour
   (`core/tests/suite/websocket_fallback.rs`): fallback activates on an
   upgrade-refused connect (line 30) and on retry exhaustion (line 82), and it
   is **sticky across turns** (line 209). The budget is 1 prewarm plus 3 stream
   attempts, then every later turn uses HTTP (lines 246-252).

⇒ **`todos/0417` stays the real prerequisite. A WebSocket transport is NOT one.**

⚠️ **Two items in this correction are UNMEASURED. Do not record them as
settled.** (i) Whether a configuration file can override the built-in `openai`
entry in place — the custom-entry path stands without it. (ii) The fail-fast
behaviour of the dial on a gucOS with no WebSocket transport is reasoned from
the code shape (the `ENOSYS` pattern of `host.js:6009`), not measured on a port.
If path 2 is the one you rely on, the cost is the startup latency of about four
failed attempts, once per session. Path 1 costs zero.

🔴 **This correction does NOT reach the feature-flag finding below, and it must
not be read as endorsing it either.** `supports_websockets` is a **serde
configuration field**, not a cargo feature, and the feature-flag finding is about
**cutting subsystems** (`v8`, sqlite, terminal emulation), not about selecting a
transport. The two questions are independent.
⚠️ **So treat the count of 2 feature sections in 132 manifests, and the zero
optional dependencies, as UNVERIFIED — neither confirmed nor refuted.** Neither
the design pass nor this correction tested it. **Measure it if you rule on it.**
Do not let this WebSocket correction propagate into it in either direction.

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

---

## Result — the ruling (2026-07-30)

🔴 **The program takes option (b): `wasm32-wasip1`, with a host shim that serves
`wasi_snapshot_preview1` onto the kernel RPCs that already exist.**

The reason, in one paragraph. The standard library for `wasip1` is upstream,
maintained, and stable. Option (b) buys the ecosystem — 543 of 838 crates, with
the population warning attached below — for a bounded shim over existing RPCs.
Option (a) buys the same ecosystem only after a nightly compiler, a forked
standard library, a rebase on every rustc release, and the unmeasured claim 6.
Option (c) is a successor to (a), so it falls with (a). The one recurring cost of
(b) is the second import namespace, and that cost is bounded because WASI
preview 1 is a frozen snapshot.

### 1. The nightly question — answered first, by reading

**The chosen path needs NO nightly compiler.** `wasm32-wasip1` is a tier-2 target
of stable rustc. Its standard library ships precompiled through `rustup target
add wasm32-wasip1`. Lanes A1–A4 stay on stable `wasm32-unknown-unknown` with
`core` and `alloc`, as `todos/RUST.md` §5 records. Measured on this machine on
2026-07-30: `rustup toolchain list` shows `stable` (1.96.1, active) and the
pinned `1.95.0`. No nightly is installed, and this ruling requires none.

The contradiction resolves like this. "Stable `rustc 1.96.1` is sufficient" is
true for BOTH paths the program now takes: the `no_std` `"c"` path (measured,
`todos/0413`) and the `wasip1` std path (a stable target; C2 measures it end to
end). The statement is FALSE for option (a): a custom target specification needs
`-Zbuild-std`, which is unstable. Option (a) would buy a pinned nightly plus a
documented bump procedure, forever. The estate does not buy it. Because the
ruling is (b), no pinned nightly version and no bump procedure exist to name.

### 2. The recurring cost of (b) — words a future reader can hold the estate to

- **Stable, not nightly.** No pinned nightly. No bump procedure.
- **No fork, no rebase.** The standard library is upstream's. The estate carries
  zero std patches, on every rustc release, forever.
- **TWO import namespaces, not one.** This ruling exercises the one re-opening
  that `RUST.md` §3 rule 1 permits. `host.js` serves `wasi_snapshot_preview1`
  beside `"c"`, permanently. The mitigation is structural: WASI preview 1 is
  frozen upstream, so the second namespace has no upstream churn, no version
  chase, and a fixed surface of about 45 functions. A first C2 pass needs
  roughly the fd/path/clock/random/args/environ/proc_exit/poll_oneoff subset.
  For scale: the `"c"` binding is 86 imports across 13 families (`todos/0414`,
  measured). **No third namespace, ever** — every gucOS-specific capability
  (spawn, signals, tty, http, clipboard) still reaches the host through `"c"`.
- **The structural match is real.** The unified `FS_WAIT` (`kernel.js:3864`,
  re-verified at HEAD `5749c6f7`: fds ⊕ input ring ⊕ timeout ⊕ signal-EINTR)
  **is** `poll_oneoff` in a different spelling. The fd and path families
  delegate to the same 0x04xx RPCs that RemoteFS already serves.

### 3. Weighed against the right baseline

Stock `wasm32-unknown-unknown` on stable is the free rung, and it stays. The
standard library is present and inert there: 511 of 833 crates compile
(census, same warning). Lanes A1–A4 ship on that rung today. What the free rung
can never grow into is real std I/O — backing `std::sys` for that target IS
option (a), the fork. Option (b) is the only path where `std::fs`, `std::io`,
`std::env`, `std::time` and the seeded `HashMap` hasher become real through
upstream code. The census's best number (543 against 511) is measured on
exactly the (b) target.

The two rungs coexist, in one module when needed. `gucos-sys` extern blocks
name `"c"` explicitly, the std sys layer names `wasi_snapshot_preview1`, and
stable rustc compiles `gucos-sys` unchanged for the wasip1 target. A std
program therefore still reaches spawn, signals, tty and http through `"c"`.
The entry contract (host-played crt0: `main`/`memory`/`alloca`, no `_start`)
must be reconciled with wasip1's `_start` convention — that is C2 design work,
named in C2's plan, not settled here.

### 4. The deploy edge (stated because the ruling is (b))

- `host.js` adds a `wasi_snapshot_preview1` key to the ONE import object beside
  `ENV_KEY = "c"` — a `createWasiPreview1(ctx)` factory, the `createHttp`
  shape. This is an ADDITION. Existing binaries and the `"c"` contract stay
  byte-unchanged. The base image ships no Rust (`RUST.md` §3 rule 5), so no
  bake changes and the byte-identity guardrail must stay green.
- The lock-step: a `-rust` package built for wasip1 runs only under a `host.js`
  that serves the namespace. On an older host, instantiation fails LOUD with
  the missing import's module and name — rule 6 is satisfied by construction.
  Deploys ship the new `host.js` before or with the first wasip1 package. The
  JS cache lag (CF `max-age=14400`, up to 4 hours) makes "before" the safe
  order.
- `kernel.js` does not change ABI. The shim is host.js-side delegation onto
  existing RPCs. If C2 finds a missing kernel op, it goes through the normal
  ticket discipline.

### 5. The evidence, with the null result attached

The census (2026-07-29, `~/git/meta/gucos/notes/rust-p0-codex-wasm-census.md`)
partitioned the 838-crate `codex-exec` graph for `wasm32-wasip1`: **543
compiled (65 percent)**, 76 host-side, **22 failed**, 197 unreached. ⚠️ The
838 figure carries a population warning that travels WITH the number: an
in-process application server of roughly 64,000 lines now rides the exec path,
the crate map predates it, and the census **may understate** the port. Only 4
of the 22 failures are true structural blockers: `socket2`, `tokio`,
`aws-lc-sys`, `v8`. **9 of the 22 are UNMEASURED** — the census machine had no
C compiler that targets wasm — and no probe fired under this ticket to close
them. They stay open, carried to D1.

### 6. Open inputs this ruling did NOT settle, with the answer assumed for each

1. **The `ring` dispute.** Recorded as the ticket records it: pass one cites
   `build.rs:594-599` and `Cargo.toml:180` and says the blocker claim is
   refuted; pass two cites a general impression and says blocked. The evidence
   is asymmetric, and the asymmetry is not a licence to settle. **Assumed:
   neither blocker nor cleared.** The ruling holds under both answers — `ring`
   prices the application half (TLS via rustls), not the standard-library
   layer.
2. **The 9 unmeasured crates.** **Assumed: open, no answer.** The ruling holds
   under both answers: none of the 9 sits in the standard library's own path.
   All are C or C++ build scripts, so they price the application half. Carried
   to D1 unmeasured.
3. **Claim 6** (a novel `target_os = "gucos"` matches nothing). NOT MEASURED,
   and this ruling did not measure it. **Assumed: open.** It prices option (a)
   only. Even at the answer most favorable to (a) — zero crates need new arms —
   (a) still carries nightly, the fork and the rebase, so the ruling is robust
   to either answer.
4. **D1 scope fact (a), WebSockets.** Carried as corrected on 2026-07-30
   (authority: `~/git/meta/gucos/notes/websockets-and-platform-limits.md`
   §1.1(a)): the latch observation and the hardcoded built-in-provider `true`
   stay TRUE; "no configuration key turns them off" is REFUTED; `todos/0417`
   is the real prerequisite and a WebSocket transport is not. Its two
   UNMEASURED sub-items (config override of the built-in `openai` entry in
   place; fail-fast of the dial on a transportless gucOS) **stay unmeasured**.
5. **D1 scope fact (b).** The 838-may-understate warning — attached in §5
   above, and attached wherever this ruling quotes the number.
6. **D1 scope fact (c).** The sandbox model is platform-blind
   (`should_run_in_sandbox()` does not test the platform). The recorded D1
   default is `danger-full-access`: the browser tab IS the sandbox. Recorded,
   not settled — D1 input.
7. **`tokio`.** Both halves carried together: the wasm arm is a feature
   reduction, not an absent port (TRUE in general), AND it is materially
   misleading for this tree — codex hand-builds a multi-thread runtime,
   `rt-multi-thread` is explicit in five crates, and two `block_in_place`
   call sites hard-panic on `current_thread`. The two call sites were
   re-counted at codex `2e1607ee2f` on 2026-07-30: exactly 2. The last item is
   a run-time panic, not a compile error.

### 7. The feature-flag finding — measured by this ruling, and CONFIRMED

The surgery estimate below leans on this finding, so the ruling measured it
(manifest reads at codex `2e1607ee2f`, the census checkout; no build ran):

- 132 workspace manifests (`find . -name Cargo.toml -not -path './target/*'`).
- Exactly **2** declare `[features]`: `code-mode/Cargo.toml`, `v8-poc/Cargo.toml`.
- **Zero** `optional = true` in any workspace manifest.
- Zero optional `reqwest` among the 20 manifests that name it.

**CONFIRMED: no cargo feature cuts a subsystem.** The finding moves from
UNVERIFIED to MEASURED. The WebSocket correction did not propagate into this in
either direction — it was measured independently.

### 8. The manifest surgery — the FIRST estimate

Measured inputs (codex `2e1607ee2f`, greps; file counts are files that NAME the
subsystem, an upper bound on edit sites):

| Subsystem to cut | Manifests | Files |
|---|---|---|
| State store (`sqlx`, `libsqlite3-sys`) | 4 | 21 |
| Git integration (`gix`) | 2 | 40 |
| Crash telemetry (`sentry`, `uname`, `openssl-sys`) | 2 | 6 |
| Terminal emulation (`portable-pty`, `serial2`) | 2 | 29 |
| JavaScript sandbox (`code-mode`, `v8`) | 6 | 47 |
| Total | ~16 | ≤143 |

**FIRST ESTIMATE — mine, not carried; no lane has scoped this; D1 must
re-derive it.** The initial cut is **10–20 lane-days**: five subsystems at 2–4
days each, covering manifest edits, call-site deletion or stubbing, and keeping
the workspace compiling. The recurring cost is **1–3 lane-days per upstream
sync**, proportional to upstream churn inside the cut subsystems, for as long
as the fork tracks upstream. This estimate prices the APPLICATION half. It does
not move the standard-library ruling.

### 9. Port versus native — both positions recorded, neither settled

- **A coordinator leans toward the native client.** That is a LEAN — a scope
  judgement, recorded because it shows where the estate's attention sits. A
  lean is not a measurement.
- **A second design pass explicitly REFUSES to pre-judge**: decide on the
  census numbers, not on the sizing of the refuted investigation document.
  **That refusal is itself the ruling on this question, and D1 inherits it.**

`RUST.md` §1's API-key-only decision stands. It is a scope decision, not an
impossibility claim — a listener-free device-code flow exists at
`login/src/device_code_auth.rs`.

### 10. C2 — scoped by this ruling, filed as `todos/0442`

C2 is the wasip1 standard-library work this ruling authorizes:
`wasi_snapshot_preview1` served in `host.js` by delegation to existing kernel
RPCs, the wasip1 build rung in the sibling `gucos-rust` repository on stable
rustc, the entry-contract reconciliation (`_start` versus host-played crt0),
`poll_oneoff` onto `FS_WAIT`, the loud-failure leg, and the base-image
byte-identity guardrail. See the ticket for the full contract.
