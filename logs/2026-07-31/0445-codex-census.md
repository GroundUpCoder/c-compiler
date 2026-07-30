# 0445 / #190 — codex feasibility: the census nulls, closed

Report: `~/git/meta` → `gucos/notes/rust-codex-feasibility-2.md` (meta
@00c7edd8), instruments + surgery diff under
`gucos/notes/rust-probe-scripts/0445/`. This log records the *why* and the
gotchas; the numbers live in the report.

## What happened

The 2026-07-29 census partitioned the 838-crate `codex-exec` wasip1 graph and
left 197 crates unmeasured (class D), 83 of them codex's own. This probe closed
that hole: **all 83 (all 102 codex crates in the graph) now carry a compile
verdict** — 9 PASS, 32 fail only on instrument bookkeeping (no intrinsic
platform coupling), 36 with named intrinsic needs, 6 mixed.

Method: surgical unmasking. Cut the failing third-party periphery out of the
manifests (68 dep entries in 39 manifests + 62 tokio feature rewrites), then
walk the failure frontier inward layer by layer (441 codex-internal edge cuts,
19 rounds), letting each crate fail loudly at its real use sites. The errors
ARE the measurement. Everything reverted afterwards; `~/git/codex` is pristine
and still at `2e1607ee2f`.

## Decisions and gotchas worth keeping

- **The ticket's "both tips moved" premise was false on both counts.** The
  codex checkout has one reflog entry (the 2026-07-15 clone) — the census ran
  at the SAME SHA. And `rust-toolchain.toml` pins 1.95.0, so the machine's
  1.96.1 default never applies inside `codex-rs`. The re-derivation became a
  calibration run: zero delta, byte-identical partition. Always check the pin
  and the reflog before "re-deriving at the current tip".
- **tokio's failure was feature poisoning, not a missing port.** Three
  successive demanders had to be silenced: 62 codex manifests (features
  strip), the rama/rmcp/hyper-util periphery (cut), and finally `codex-otel`'s
  *normal*-dep `opentelemetry_sdk` `"testing"` feature (→ `rt-multi-thread`).
  After that, tokio v1.52.3 compiles for wasip1. `cargo tree -e features -i
  tokio` includes DEV edges by default — use `-e normal,build,features` or the
  attribution lies (wiremock was a red herring).
- **Cut at edge level against resolved nodes, not name level.** Two `reqwest`
  versions resolve in the graph; one is wasm-clean (class A), one pulls
  hyper-rustls. A name-level doom list over-cuts. Same trap: tokio sat in the
  failed set, but its failure heals when demanders leave — closure-contains-
  failed must exclude it or everything dooms.
- **`codex-utils-rustls-provider` was the sole blocker of 35 codex crates.**
  The TLS decision gates more of the codex tree than anything else. In gucOS
  the answer is architectural (0442's shim absents `sock_*`; TLS belongs to
  the host, 0417 HTTP OFDs), so the whole rustls/ring/aws-lc stack leaves the
  graph.
- **The expensive surgery is not census §9's five subsystems** (those are
  concentrated: sqlite 306 lines/27 files, v8 201/9, gix 31/1, sentry 12/1,
  pty 18/5). It is the transport periphery: `rmcp` 664 lines across 90 files,
  websockets 189/46, axum 143/23, tonic (config, 60+ errors).
- **zsh eats bare `===`** (equals-expansion → "== not found"). Quote it in
  loop echo separators.
- Cap-death lesson, applied on resume: **write the report first, commit per
  measurement.** The first turn did all 118 tool calls of measurement and no
  prose; the cap killed it with nothing durable. The scratch
  (`/tmp/rust-probe-0445/`) survived by luck. All artifacts are now committed
  to the meta repo.

## Constraints honoured

No suite, no heavy lock, no code into c-compiler (this log is the only file).
Every cargo run foreground at `-j 5` (0444's latency acceptance shares the
box; parallelism changes wall-clock only, so the A/B/C/D classification stays
comparable with the census). The 9 asm-FFI crates remain nulls — no wasm C
compiler on this box; `~/git/clang-simplified/wasm` is the candidate, untested
(report §8). Compile-only: no wasm binary was run.

Ticket: #190 (close-out in the ticket body's `## Result`). Unblocks #192.
