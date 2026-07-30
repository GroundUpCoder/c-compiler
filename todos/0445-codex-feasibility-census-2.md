# 0445 — codex feasibility: close the census nulls against the landed toolchain

- **Status**: open
- **Design**: `todos/RUST.md` §4 (unit D1) and §1; the census
  `~/git/meta/gucos/notes/rust-p0-codex-wasm-census.md` §11 is this ticket's
  authority for what remains unmeasured.
- **Provenance**: jku asked on 2026-07-30 whether a stable path could be queued
  for the codex feasibility analysis, even before the codex port itself (D1) is
  fileable. This ticket is that path.

## 🔴 READ FIRST — what this ticket is NOT

**This is not the codex port, and it must not become one.** D1 (port `codex exec`
versus write a native client on the same wire protocol) stays **unfiled** until
its two inputs land: the `todos/0418` ruling (landed 2026-07-30) and `todos/0417`
(open). `todos/RUST.md` §4 says a decision taken without both is a guess, and it
inherits the refusal to pre-judge port-versus-native
(`todos/done/0418-rust-std-decider.md` §"Result" item 9). **Do not pre-judge it
here.** This ticket produces MEASUREMENT, so that when D1 is filed the decision
rests on numbers instead of an estimate.

**Write no code into this repository.** The deliverable is a document plus the
scripts that produced it. Nothing in `os/`, `kernel.js`, `host.js`, `tools/` or
`packages/` changes.

## Goal

A 2026-07-29 census measured the `codex-exec` crate graph and left a quarter of it
unmeasured. Close the nulls it named, against the toolchain this program has
actually landed, and state what the port costs.

The census partitioned 838 crates in the `codex-exec` graph for
`wasm32-wasip1`:

| Class | Count | Meaning |
|---|---|---|
| A | 543 | the crate library compiled for wasip1 |
| B | 76 | ran host-side only (build script or proc-macro) |
| C | **22** | the build reached it and it **failed** |
| D | **197** | the build never reached it — **unmeasured** |

Class D is the hole. **83 of those 197 are codex's own workspace crates** — they
are the actual target of a port, and the probe never reached one of them.

## 🔴 The census's own step order is WRONG on this box — re-derive it

`~/git/meta/gucos/notes/rust-p0-codex-wasm-census.md` §11 lists three next steps
and calls step 1 ("install a wasm C toolchain and repeat the run") the cheapest.
**Measured 2026-07-30 on this machine: step 1 is BLOCKED, not cheap.**

- `/usr/bin/clang` is Apple clang 21.0.0 and **registers no wasm target at all**:
  `clang -print-targets` lists none, and
  `clang --target=wasm32-wasip1 -c t.c` fails with
  `unable to create target: 'No available targets are compatible with triple
  "wasm32-unknown-wasip1"'`.
- There is no other clang on the box (`/usr/local/bin/clang*`, `/opt/*/bin/clang*`
  are empty).
- 🔴 **Homebrew, MacPorts and every other package manager are forbidden on this
  machine.** Do not install one, do not check for one, do not suggest one.

⇒ **Do step 2 first.** It needs no C compiler and it holds the 83 codex-owned
crates, which is the part that decides the port. Treat step 1 as a separate,
later question and report what it would take **without** a package manager (the
estate does build wasm C — `~/git/clang-simplified/wasm` — so the honest question
is whether that toolchain can serve as cargo's `cc`, not whether to install one).

## Plan

1. **Measure the 83 codex-owned crates (class D).** Compile them against
   `wasm32-wasip1` with the failing third-party dependencies stubbed or cut, so
   that the build reaches them. Report, per crate, whether it compiles and what
   it needs from the host. This is the ticket's centre of gravity.
2. **Re-derive the whole partition at the current tips**, because both moved:
   - `~/git/codex` is at `2e1607ee2f` today; the census ran on 2026-07-29 against
     an earlier tip. **Pin the SHA you measure and put it in the report.**
   - The local toolchain is `rustc 1.96.1`; the census used `1.95.0`. Targets
     `wasm32-wasip1` and `wasm32-unknown-unknown` are both installed.
   Report the new A/B/C/D counts beside the old ones, and explain every delta.
3. **Cost the manifest surgery.** Census §9 found that codex has almost no
   feature-flag surface — 132 workspace manifests, **2** with a `[features]`
   section (`code-mode`, `v8-poc`); `exec/Cargo.toml` and `core/Cargo.toml`
   declare none. So a subsystem cannot be cut with a cargo feature; it needs
   manifest edits and call-site deletion. **Put a number on that work** for the
   subsystems the port would drop (the JavaScript sandbox, the pty, telemetry,
   git, the state store). Census §9 says this cost "has no estimate today".
4. **Re-price the four structural blockers** against the `todos/0418` ruling
   (upstream std on `wasm32-wasip1`, stable rustc, a `wasi_snapshot_preview1`
   host shim — `todos/0442`). The census named `socket2` and `tokio` (threads and
   sockets), `aws-lc-sys` (no wasm arm) and `v8` (a C++ JavaScript engine).
   **Say for each whether `todos/0442` changes its status, and how.** The census
   predates the ruling, so this is genuinely open.
5. **State what D1 would need**, without choosing between port and native. List
   the inputs a D1 decision still lacks after this ticket, so whoever files D1
   knows exactly what is measured and what is not.

## 🔴 Reuse the existing instruments — do not rewrite them

The scripts that produced the 2026-07-29 tables are preserved at
`~/git/meta/gucos/notes/rust-probe-scripts/`: `census2.py` (the partition and the
class of each failure), `cfgcensus.py` (the count of wasm arms) and `inspect.mjs`.
A copy also survives in `/tmp/rust-probe/`, which **does not survive a reboot** —
read the versioned copies. Reuse them so the new numbers are comparable with the
old ones; if you must change one, say what you changed and why a delta is still
comparable.

The repeat recipe from census §12:
```
cargo tree  -p codex-exec --target wasm32-wasip1 -e normal,build --prefix none
cargo check -p codex-exec --target wasm32-wasip1 --keep-going --message-format=json
```

## Acceptance

- A report at `~/git/meta/gucos/notes/rust-codex-feasibility-2.md` that carries,
  for `wasm32-wasip1`: the re-derived A/B/C/D partition **with the counts printed**,
  the per-crate result for the 83 codex-owned crates, a number for the manifest
  surgery of Plan step 3, and a per-blocker verdict for Plan step 4.
- 🔴 **Every count is printed and every command that produced it is quoted.** A
  table without the command that made it is not a measurement. Name the source
  and print the derived count, so a shrink between runs is visible.
- 🔴 **The `~/git/codex` SHA measured is stated in the report**, and it is the
  real tip at measurement time — not a carried one.
- 🔴 **A null is reported as a null.** "The build never reached it" and "it does
  not work" are different findings and must not be merged. The 2026-07-29 census
  got this right; keep it right.
- 🔴 **No file in `~/git/c-compiler` changes except this ticket's close-out.**
  The probe writes no code into this repository.
- The report states, in one paragraph, what D1 still lacks — and does **not**
  rule on port-versus-native.
- Prose follows ASD-STE100.

## Notes

**`todos/0417` must merge before this runs.** Not because this ticket depends on
its output — it does not; a `cargo check` census and the kernel HTTP rework are
disjoint — but because an 838-crate cargo run and a kernel gate on one machine
degrade each other. Sequence it, do not couple it.

Class D is not a set of unknown problems: of the 197, 83 are codex's own crates
and 114 are third-party, the largest group being the network stack behind `tokio`
and `socket2` (`hyper`, `h2`, `tower`, `tonic`, `rustls`, `hickory-resolver`, the
`rama-*` family). Read census §3 before you interpret any class-D number.
