# todos/RUST-D1-RULING.md — D1: codex on gucOS, the ruling (ticket #192)

- **Status**: ruled 2026-07-31 (ticket `#192`, unit D1 of `todos/RUST.md` §4).
- **Question**: port `codex exec`, or write a native gucOS client on the same
  wire protocol.
- **Inputs**: `todos/done/0418` §Result, `todos/done/0417`, `todos/done/0442`,
  ticket `#190` (0445) and its report
  `~/git/meta/gucos/notes/rust-codex-feasibility-2.md`, ticket `#191` (0446),
  the codex source at `2e1607ee2f`, `todos/RUST.md` §1 and §3.
- **Style note**: this document uses ASD-STE100 simplified technical English.

## 1. The ruling, in short

The inputs are not sufficient for a final selection of one arm. Two
measurements are missing, and this document names them exactly (§7). This
outcome is the one that the ticket permits only with those names attached.

But the ruling does not stop there. It rules on everything that the 0445
numbers decide today:

1. **A port is not blocked at the compile level.** The 0445 report closed
   class D. All 102 codex crates now have a verdict, and the platform coupling
   is small and concentrated (§2).
2. **The wire protocol is one protocol, and it is not versioned.** A second
   implementation must track it by hand. A port tracks it with a rebase (§3).
3. **The port has a real transport seam.** One trait with two methods
   (`HttpTransport`) carries all HTTP in codex. One gucOS implementation of
   that trait serves a port (§3).
4. **Both arms need the same two prerequisites**: the `#191` HTTP fix and a
   proven Rust HTTP-plus-SSE path. This work cannot lose. The ruling funds it
   now (§8).
5. **The selection rule is fixed now** (§7). The follow-on tickets measure the
   two missing quantities. The selection then follows from the rule, not from
   a new debate.

No code changed in this lane. The gucOS base image did not change, and no
image bump occurred.

## 2. What 0445 measured, and what it changes

The 2026-07-29 census left 197 crates unmeasured, 83 of them codex's own. The
ticket body for `#192` carried the sentence "nobody has measured whether
codex's own crates compile for this target." **That sentence is now stale.**
The 0445 probe (ticket `#190`, closed 2026-07-31) measured all of them:

| Verdict (of the 102 codex crates in the graph) | Count |
|---|---|
| PASS — compiles for `wasm32-wasip1` | 27 |
| FAIL, sibling-only (no intrinsic platform coupling) | 32 |
| FAIL, intrinsic needs (own code names a cut crate or module) | 36 |
| FAIL, mixed/other | 6 |
| unmeasured | **0** |

The load-bearing readings from that table (report §4–§6):

- **41 of 102 codex crates have no intrinsic platform coupling at all.**
  `codex-exec` itself has none. `codex-core`'s intrinsic surface is four
  items: `rmcp` ×28, `tokio::process` ×5, `tokio::fs` ×3,
  `tokio_tungstenite` ×2.
- **tokio compiles for wasip1** (v1.52.3, on `io-util, macros, rt, sync,
  time`) after 62 manifests stop demanding the six native-only features.
  The compile question is closed. The runtime question is open (§7, M1).
- **The manifest surgery is priced**: 62 tokio feature rewrites, 68
  third-party dependency cuts in 39 manifests, 3 source scaffolds of ~35
  lines. The five subsystems the census feared (state, v8, git, telemetry,
  pty) are cheap and concentrated. The expensive surgery is the transport
  periphery: `rmcp` 664 call-site lines in 90 files, websockets 189 in 46,
  `axum` 143 in 23, `tonic` in one crate.
- **The TLS stack leaves the graph by architecture, not by work.** Before the
  cut, one crate (`codex-utils-rustls-provider`) blocked 89 of the 102. gucOS
  puts TLS in the host (`todos/done/0417` fds; the 0442 shim absents
  `sock_*`), so rustls, ring and aws-lc are not port work items.

What 0445 did **not** measure, stated as the report states it (§9): the 9
asm-FFI crates (no wasm C compiler on the box), every runtime property
(size, startup, single-thread behavior), and the upstream drift (528 commits
past `2e1607ee2f`). These nulls stay nulls in this ruling. §7 funds the two
that decide the arm.

## 3. The wire protocol, derived from source

The ticket ordered a derivation from source, not an acceptance of the phrase
"the same wire protocol." Derived at codex `2e1607ee2f` (checkout verified
pristine at that SHA on 2026-07-31):

- **There is exactly one wire protocol: the OpenAI Responses API.** The
  alternative `chat` wire API was **removed** upstream. The config parser
  now rejects it with an error
  (`model-provider-info/src/lib.rs:50`: "`wire_api = \"chat\"` is no longer
  supported").
- **The shape**: HTTP POST to `{base_url}/responses`, streamed as
  server-sent events. The request struct is `ResponsesApiRequest` with 15
  fields (`codex-api/src/common.rs:216`). The item model is `ResponseItem`
  with 16 variants (`protocol/src/models.rs:801`, a 3551-line file). The SSE
  parser consumes 13 event kinds (`codex-api/src/sse/responses.rs:330-459`).
- **The protocol is not versioned.** No version field exists in the request
  or the events. codex extends it (the `response.metadata` event,
  `client_metadata`). Upstream moved 528 commits in 16 days. A native client
  tracks this surface by hand. A port receives it with an upstream rebase.
- **The transport seam is real and small.** All HTTP goes through the trait
  `HttpTransport` — two methods, `execute` and `stream`
  (`http-client/src/transport.rs:25-34`). Every endpoint client is generic
  over it (`ResponsesClient<T: HttpTransport>`,
  `codex-api/src/endpoint/responses.rs:26`). A port replaces the reqwest
  implementation with one gucOS implementation over the fd HTTP ABI. It does
  not fork reqwest.
- **A WebSocket transport is not required.** `supports_websockets` is a
  provider config key with default false
  (`model-provider-info/src/lib.rs:136-140`); the built-in OpenAI provider
  sets it true (`:362`) but a custom provider entry runs pure HTTP, and an
  automatic HTTP fallback exists (`core/src/client.rs:508-527`,
  `force_http_fallback`). All three cites re-verified at `2e1607ee2f`.

## 4. The ASSUMED premises, checked

The ticket lists four ASSUMED premises. Each one was checked, and each result
is recorded here, per the ticket's acceptance.

1. **"The 0442 shim covers what codex calls."** HOLDS, as scoped, at the
   compile level. The shipped split (`todos/done/0442` §Result) is: 36 real
   calls, 2 honest no-ops, 3 served with `ENOTSUP`, 5 absent with a loud
   `LinkError` (`sock_*`, `proc_raise`). tokio's wasip1 runtime rides
   `poll_oneoff`, which is served over `FS_WAIT`. `std::net` is absent by
   design; the transport replacement (§3) is the answer, not a shim gap. The
   runtime proof does not exist yet — that is measurement M1 (§7), and this
   premise stays conditional until M1 runs.
2. **"codex's transport can reach the gucOS HTTP ABI from Rust."** FAILS
   today, loudly reported: `gucos-sys/src/http.rs` still binds the retired
   pre-0417 ABI. Re-verified at gucos-rust `21ce816`: `__http_read` and
   `__http_close` are declared (`http.rs:22-23`) but no longer exist in the
   host; `__http_open` has the old arity 5 (`http.rs:14`); `__http_status`
   links but its semantics changed silently. Ticket `#191` is the fix, and
   it is a prerequisite of both arms.
3. **"The same wire protocol is a settled, documented surface."** PARTIAL.
   The protocol is one, real, and enumerable (§3). But it is not versioned,
   not frozen, and codex extends it. "Settled" is false as stated. The
   correct statement: the surface is derivable from source and must be
   tracked over time.
4. **"Inherited counts, paths and symbols hold at the head ruled against."**
   RE-DERIVED. The codex checkout sits at `2e1607ee2f`, pristine (verified
   by `rev-parse` and `status` on 2026-07-31 — the same SHA both censuses
   measured; the toolchain pin 1.95.0 applies inside the repo). The 0445
   re-derivation was a calibration run with zero delta. The file cites in §3
   were each re-read at that SHA. The `#192` body's class-D sentence is
   stale (§2) — reported, not silently patched.

## 5. The two arms, costed

### Arm P — port `codex exec`

**Keep**: `codex-exec`, `codex-core`, the protocol crates, the CLI glue —
the 41 crates with no intrinsic coupling, plus the crates whose needs are
served by replacement (transport) or by cut (subsystems).
**Cut** (measured price, §2): the state store, v8 code-mode, git, telemetry,
pty, the proxy, the app server, websockets, tonic config, aws.
**Replace**: reqwest with a gucOS `HttpTransport` implementation (§3);
`tokio::process` (12 crates name it; `codex-core` ×5) with spawn over the
`"c"` ABI; the runtime construction with `current_thread` plus the two
`block_in_place` sites (`todos/done/0418` §6.7 — re-counted, exactly 2).

- **HTTP**: through `#191` (0446) and the D2 transport ticket (§8). This
  ruling does not assume a working binding; none exists today (§4.2).
- **Risks, in order**: (1) the tokio single-thread runtime has no runtime
  evidence — M1; (2) binary size and startup are unmeasured — M1; (3) the
  asm-FFI crates (`tree-sitter` for apply-patch and shell-command, sqlite,
  zstd) are nulls — M2; (4) the fork tracks an upstream that moved 528
  commits in 16 days — recurring cost, estimated 1–3 lane-days per sync in
  `todos/done/0418` §8, bounded by the cut surface; (5) MCP: `rmcp` is the
  single largest surgery (664 lines, 90 files) — a v1 port scope question,
  recorded open, not decided here.
- **The six invariants** (`RUST.md` §3): (1) one ABI — holds; the port adds
  no namespace; std uses `wasi_snapshot_preview1`, everything gucOS-specific
  uses `"c"`. (2) one libc — holds; wasi-libc on the wasip1 rung, per 0442.
  (3) one heap — holds; wasi-libc owns malloc, the allocator delegates.
  (4) one producer — holds with a note: the fork lives in a sibling
  repository (the `gucos-rust` precedent); this tree consumes `.wasm`
  artifacts only. (5) no Rust in the base image — holds; codex ships as an
  opt-in gucman package. (6) loud failure — holds; a missing import fails at
  instantiation with its name.

### Arm N — write a native client

**Write**: a gucOS program that speaks the Responses API (§3) and runs an
agent loop with gucOS tools.

- The wire surface is small, and this lane measured it: one endpoint, a
  15-field request, a needed subset of 16 item variants, 13 SSE event kinds.
- **The real scope is not the wire. It is the behavior.** The agent loop,
  the prompts, the tool orchestration, apply-patch, context compaction and
  AGENTS.md handling live in `codex-core` and its siblings. No ticket has
  measured that scope (0445 §10 item 5), and it is not enumerable by a
  census — it is a re-implementation whose parity cost grows with every
  upstream behavior change. The 528-commit drift prices that treadmill.
- **HTTP**: the same `#191` + D2 path (a Rust client), or the existing
  libcurl veneer (a C client). Both ride the 0417 fds.
- **The six invariants**: all six hold trivially — a native client is an
  ordinary gucOS program in a package. No invariant separates the arms.

### What separates the arms, on today's numbers

The port reuses the behavior core at a measured, bounded surgery cost and
receives upstream improvements by rebase. The native client re-implements
the behavior core at an unmeasured cost and then tracks all upstream
behavior change by hand. On the measured numbers — 41/102 clean crates, a
four-item intrinsic surface in `codex-core`, a priced cut set, a two-method
transport seam — the port arm is ahead **if it runs**. Whether it runs, at
what size, and at what startup cost, is exactly what no report measures.
That is why §7 exists.

## 6. Third options, recorded (plan step 5)

- **T1 — protocol-crate reuse.** A native Rust client that depends on
  codex's own `protocol`, `codex-client` and the HTTP half of `codex-api`
  (the crates that carry the wire types and the SSE parser), but not on
  `codex-core`. It gets the wire tracking by `cargo update` instead of by
  hand, and writes only the gucOS agent loop. **PARKED with a trigger**: T1
  becomes the preferred native shape if M1 fails on the runtime ground.
- **T2 — codex as a host-side service**, bridged into the OS. **REJECTED**:
  every gucOS binary is a wasm module inside the OS (`todos/OS.md` north
  star). A host-side agent breaks that goal and adds a second privilege
  domain. Not parked; a change here re-litigates the north star, not this
  ruling.
- **T3 — a C native client over the libcurl veneer.** Recorded as a variant
  of arm N. It shares arm N's unbounded behavior scope and adds a hand-kept
  C mirror of a Rust type surface. It stays available, but nothing
  recommends it over T1 while the Rust rungs work.

## 7. The missing measurements, named, and the selection rule, fixed

The two measurements that decide the arm (from 0445 §10, sharpened):

- **M1 — runtime evidence (ticket D3).** Link a minimal port slice — the
  protocol crates, `codex-client`/`codex-api` over the D2 transport, a
  `current_thread` tokio runtime, one streamed Responses turn against a
  recorded fixture — and RUN it on the 0442 shim. Record: does the runtime
  drive the stream loop; the wasm size; the cold load; the warm start under
  the `#188` module cache.
- **M2 — the wasm C toolchain experiment (ticket D4).** 0445 §8, run as
  written: can `clang-simplified/wasm` build the asm-FFI crates
  (`tree-sitter` first — apply-patch and shell-command need it; then
  `libsqlite3-sys`, `zstd-sys`, `ring`). This decides whether four port
  needs are costs or non-costs.

**The selection rule** (ticket D5 applies it; no new debate):

1. M1 runs the streamed turn, and M2 gives `tree-sitter` a working build or
   a priced fallback ⇒ **select the port (arm P)**.
2. M1 fails on the runtime ground after its enumerable fixes (the two
   `block_in_place` sites, feature trims) are exhausted ⇒ **select the
   native client, shape T1**.
3. M1 runs but the size or startup exceeds three times the `cpython-clang`
   package on the same measures (the comparator: warm Safari p50 132 ms,
   ticket `#188`) ⇒ **stop and discuss with jku**. The 3× line is chosen,
   not derived; it is recorded here so that it can be challenged.
4. Any other ambiguity ⇒ surface and discuss, per the standing rules.

## 8. The follow-on tickets, filed by this ruling

| Ticket | Unit | What | Edges |
|---|---|---|---|
| `#292` | D2 | gucos-rust: a codex `HttpTransport` implementation over the fd HTTP ABI, with a streamed SSE proof | blocked-by `#191` |
| `#293` | D3 | M1 — the port runtime spike: link and run a minimal codex slice on the 0442 shim; record size and startup | blocked-by `#292` |
| `#294` | D4 | M2 — the wasm C toolchain experiment over the 9 asm-FFI crates | independent |
| `#295` | D5 | Apply the §7 selection rule and select the arm | blocked-by `#293`, `#294` |

Each edge above was verified by a re-read of the created ticket, not from the
create echo. All four are P1 (the D1 program is feature work; `#191` keeps its
own priority).

`#191` (0446) stays P1 and becomes the root of the D2 chain. The
"no two heavy builds share the box" constraint travels in each ticket body —
the 0444 latency lane measures wall-clock on this machine.

## 9. Reopen triggers — what would change this ruling

- **The `#191` trigger, carried from the ticket**: if the 0446 fix lands and
  the Rust HTTP surface costs materially more than this ruling assumes (one
  trait implementation over the fd ABI), reopen.
- **The drift trigger**: implementation must start from a re-measured
  upstream tip. If the re-measure at that tip breaks a §2 number that this
  ruling leans on (the clean-crate count, the intrinsic-surface sizes, the
  seam of §3), reopen.
- **The transport trigger**: if the API-key-only pure-HTTP mode stops
  sufficing (upstream makes WebSockets mandatory on custom providers),
  reopen — the `chat` removal (§3) proves upstream deletes wire modes.
- **The shim trigger**: if D3 finds a preview1 call codex needs that the
  0442 shim does not serve, the shim ticket reopens, not this ruling —
  unless the gap is architectural (a `sock_*`-class capability), which
  reopens this ruling.
- **M1/M2 by construction** (§7): their results select the arm; a failed
  measurement is a result, not a reopening.
