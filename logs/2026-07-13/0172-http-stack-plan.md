# HTTP stack + `code` utility — plan and native-first landing (0172/0173/0174)

**Date**: 2026-07-13
**Items**: todos/0172 (kernel HTTP transport), 0173 (libcurl veneer),
0174 (`/bin/code`). This commit lands the **native-first** slice of 0174
only: the design docs, vendored cJSON, `os/code/code.c`, and a green
fake-server smoke test. No kernel.js / host.js changes (parallel compositor
work is live — see below).

## The decision: libcurl API, custom RPC underneath

Question was "shim fetch → libcurl, or a bespoke fetch-shaped C API?" Answer:
both, at different layers.

- **App-facing C API = libcurl easy interface.** It's an external frozen
  standard (nothing to design, only a subset to grow monotonically), it's
  the port-enabler (git's HTTP transport, wget-ish tools compile unchanged),
  and — the clincher — it makes every consumer **host-testable**: the same C
  source builds with `clang -lcurl` against the system libcurl and runs as a
  reference oracle, exactly the tests/unit/conformance methodology. Verified
  macOS ships `curl/curl.h` in the SDK and links with plain `-lcurl`.
- **Kernel boundary = a private 0x06xx RPC family** between kernel.js and
  host.js. No wasm binary ever encodes it, so it's refactorable at will —
  which is why it doesn't need to be perfect on first landing. What DOES need
  to be right is the *semantics* (fetch-shaped, streaming body with
  backpressure, EOF≠error, C-side abort, header cap, whole-body uploads in
  v1). Those are captured in 0172's body; they're the pipe/pty semantics
  already built twice.

TLS falls out of the fetch stack for free — the single fact that keeps this
from being a mega-project. Non-HTTP protocols, proxies, TLS knobs, cookies,
and raw sockets are all out (fetch can't express them; the browser can't do
raw TCP) — documented descopes in 0173, not surprises.

## Parallel-work safety

Compositor work (0161/0168/0169, in os/compositor.js + kernel-worker.js + the
wm sections of kernel.js) is live. This slice touches ONLY new files
(vendor/cjson/, os/code/) + three new todo items + an isolated queue.json
append. The kernel transport (0172) is deliberately deferred so its
kernel.js edits don't collide; when it lands it's additive (new opcode range,
new dispatch section) and claims 0x06xx up front in KERNEL.md's layout
comment. Merge friction is confined to queue.json / KERNEL.md / tests/run.js
RULES — small and mechanical.

## `code.c` — native-first

Single-file, dual-target agentic coding assistant over the Anthropic Messages
API (streaming SSE + tool use). Line-oriented, SGR colors only (works on VT1
and over a pty). Tools: bash, read_file, write_file, edit_file (unique-string
replace), list_dir — every result hard-capped (file 48KB/2000 lines, bash
24KB/120s, whole-file-edit 4MB) so contexts can't explode. Env:
ANTHROPIC_BASE_URL / API_KEY / AUTH_TOKEN / MODEL; flags -p, --model,
--system-prompt, --max-turns, --max-tokens, --verbose, --no-color. JSON via
vendored cJSON v1.7.19. The ONE platform seam is `run_command()` (fork/exec
native; posix_spawn/__spawn for gucOS later).

## Backend: DeepSeek's Anthropic-compatible endpoint

Primary dev/test backend is `https://api.deepseek.com/anthropic` — verified
live 2026-07-13 (returns proper Anthropic error envelopes). Cheaper than the
real API for iteration; final validation pass against api.anthropic.com
before 0174 closes. Browser flavor will need
`anthropic-dangerous-direct-browser-access: true` (CORS preflight verified
allowed against both api.anthropic.com and DeepSeek). Deterministic CI never
touches the network — a scripted fake `/v1/messages` SSE server
(os/code/test/smoke.mjs) is the reference-oracle harness.

## Gotcha found while building the harness

The smoke server shares the test's node event loop, so `execFileSync`
(synchronous child) **deadlocks**: `code` POSTs, but the blocked event loop
can never run the HTTP handler, so the server never replies and the child
hangs until timeout. Symptom was orphaned `code -p` processes and a smoke run
that printed only "built …". Fix: async `execFile` so the loop stays free to
serve. `code` itself was blameless — it drives a standalone bash-launched
server correctly. Noted here because any future in-process-server test
(test_code_e2e.js, test_http_e2e.js) will hit the same trap.

## Status

- Native `code` builds clean under `-Wall -Wextra -fsanitize=address` (only
  warnings are upstream cJSON's sprintf deprecations).
- `node os/code/test/smoke.mjs`: 10/10 green — text streaming, tool-use
  round-trip (write_file executes, tool_result echoes with matching id,
  assistant tool_use in history), bash output cap + truncation marker. No
  ASan memory-safety errors; leak-clean on the -p happy path.

## Next (not in this commit)

0172 kernel transport (design → KERNEL.md section → kernel.js/host.js →
test_http.js + e2e), then 0173 veneer, then 0174's in-OS seam +
hush login-shell / /etc/profile env plumbing + test_code_e2e.js + the live
DeepSeek and final Anthropic passes.
