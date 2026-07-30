# 0447 / #192 — D1 ruled: the staged ruling, the fixed selection rule

Ruling: `todos/RUST-D1-RULING.md`. This log records the why and the gotchas;
the numbers and the rule live in the ruling.

## What happened

The D1 question (port `codex exec` vs a native client on the same wire
protocol) got its ruling, and the ruling is STAGED: the inputs stay
insufficient for a final arm selection, the two missing measurements are
named exactly (M1 runtime/size/startup, M2 the wasm C toolchain), and the
selection rule over them is fixed NOW so that the follow-on ticket (#295)
applies arithmetic, not judgement. Everything the 0445 numbers do decide is
ruled today: the port is not compile-blocked (102/102 codex crates measured,
41 with zero intrinsic coupling), the wire protocol is the Responses API
alone (the `chat` wire API is REMOVED upstream), and codex carries all HTTP
through one two-method trait (`HttpTransport`) — the port's transport story
is one impl, not a reqwest fork. Follow-ons filed: #292 (D2 transport) →
#293 (D3/M1), #294 (D4/M2) independent, #295 (D5 selection) blocked on both.

## Why staged rather than picking the port

The acceptance forbids a ruling whose decisive claim is an estimate. 0445 is
compile-only by its own §9, and its §10 names runtime evidence as a missing
D1 input. Selecting the port today would rest the decisive claim (the
current_thread runtime drives codex's stream loop, at a tolerable size and
startup) on exactly the quantity nobody measured. The staged shape rules
everything rulable, pre-commits the decision criteria — including a declared,
challengeable 3× line against the cpython-clang comparator — and makes the
remaining work mechanical.

## Gotchas worth keeping

- **Repeated `--blocked-by` flags on `ticket create` keep only the LAST
  value.** #295 came back with one blocker where two were passed. The fix is
  `cc-meta ticket block <ref> --hard <id,id>` (comma list), and the re-read
  rule caught it exactly as advertised — never trust the create echo.
- **Ticket numbers are DB-allocated and project-wide-monotonic**: D2 came
  back as #292, not the next-looking free number. Write prose cross-refs
  only AFTER filing, then patch the bodies (`ticket update --body @file`).
- **The #192 body's class-D sentence aged out by design.** It was written
  before 0445 ran; re-derived against 0445's output it is stale (0 of 102
  unmeasured now). Reported in the ruling §2 rather than silently dropped —
  the (FB) rule: the body is what the next reader finds.
- **The `HttpTransport` seam made the port's HTTP arm concrete.** Every
  codex endpoint client is generic over a two-method trait
  (`http-client/src/transport.rs:25`, `endpoint/responses.rs:26` at
  `2e1607ee2f`). That finding shrank D2 from "replace reqwest" to "implement
  one trait over the 0417 fds" — and it is also what makes T1 (the parked
  protocol-crate-reuse native shape) cheap to describe.
- **ASSUMED premise 2 was verified at the sibling HEAD, not inherited**:
  `gucos-rust@21ce816` `http.rs` still declares `__http_read`/`__http_close`
  (retired) and the arity-5 `__http_open`. #191 stays the root of the chain.

## Constraints honoured

No cargo ran (the 0444 latency lane shares the box). No heavy suite ran. No
code changed: the only files touched are `todos/RUST-D1-RULING.md`,
`todos/RUST.md` §4, and this log. **No image bump occurred** — `os/image.json`
is untouched, as the ticket requires for a prose-only lane.

Ticket: #192 (close-out in the ticket body's `## Result`). Unblocks nothing
mechanically — #292 waits on #191, #294 is ready now.
