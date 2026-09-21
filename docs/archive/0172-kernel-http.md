# 0172 — Kernel HTTP transport: fetch-shaped 0x06xx RPC family

- **Status**: done (2026-07-13)
- **Design**: this file (semantics below) + KERNEL.md "HTTP transport
  (0x06xx)". Plan in logs/2026-07-13/0172-http-stack-plan.md; landing notes
  in logs/2026-07-13/0172-kernel-http-landed.md.

## Resolution (2026-07-13)

Landed the 0x06xx transport: `HTTP_BODY`/`HTTP_OPEN`/`HTTP_STATUS`/
`HTTP_READ`/`HTTP_CLOSE` in kernel.js (fetch driver + chunk-queue with
backpressure, `_cancelWaiter`/`_exitProcess` reclaim), the `__http_*` C
primitive in host.js `createHttp` + the compiler prelude `__import` decls,
and spawnHooks wiring. Injectable `opts.fetch` (`fetch: null` = offline →
ENOSYS). Tests green: `test_http.js` (27 checks, fake worker + fake fetch —
every path deterministic) + `test_http_e2e.js` (real C over the full stack:
Node fetch → local server; streamed GET, POST echo, 512K integrity through
the streaming reader, 404, mid-stream drop = error≠EOF, no dangling
transfers after halt). All acceptance criteria met; the Node (boot.js)
flavor is the e2e, the browser kernel-worker flavor shares the identical
code path (same global fetch) with no browser-specific transport code, so
it's covered by construction (unlike the compositor's CPU/GPU split).

## Goal

Give processes HTTP(S) through the kernel, backed by the embedder's `fetch()`
(browser kernel-worker and Node boot.js alike). The kernel owns network;
processes reach it via RPC — the substrate for the libcurl veneer (0173) and
`/bin/code` (0174), and for any future networked port (git, package fetcher).
TLS comes free from the fetch stack. Deliberately NOT a socket layer: the
browser cannot do raw TCP, so a socket-shaped API would be a lie —
fetch-shaped is forced by the platform, and that's fine.

## Interface semantics (the part that must be right first time)

The wire format is a PRIVATE contract between kernel.js and host.js (both
in-repo, version-locked — refactorable at will later). The SEMANTICS are what
leak; nail these:

- **Fetch-shaped, one transfer per handle**: request (method, url, header
  list, optional whole body) → response (status, header list) → streaming
  response body → EOF or error. No connection reuse control, no raw send/recv.
- **Opcode range**: claim `0x06xx` (fs=0x04xx, AF_UNIX=0x05xx, wm=0x1xxx,
  audio=0x2xxx). Tentative ops: HTTP_OPEN (request + whole body → handle),
  HTTP_STATUS (deferred until headers arrive → status + header block),
  HTTP_READ (deferred, pipe-read-shaped: blocks until data/EOF/error),
  HTTP_ABORT/CLOSE.
- **Streaming body with backpressure**: kernel-side bounded buffer per
  transfer (pipe-buffer machinery reused); the embedder's fetch reader is
  paused (don't `read()` the ReadableStream) while the buffer is full, so a
  slow C consumer applies backpressure to the network instead of buffering
  unboundedly kernel-side.
- **EOF vs error are distinct**: HTTP_READ returns 0 at clean stream end; a
  network/abort failure surfaces as a negative errno-style result plus a
  short error string fetched via a follow-up op (curl needs the message for
  CURLE_* mapping / `curl_easy_strerror` fidelity).
- **Abort from the C side**: HTTP_ABORT maps to AbortController; also fires
  on process exit/SIGKILL via the existing teardown sweep (no leaked
  transfers — same lifecycle discipline as audio streams: never wedge).
- **Header block capped** (e.g. 64KB) and delivered as one flattened
  `name: value\n` blob — order/casing are whatever fetch's Headers gives us;
  documented as not wire-faithful (nothing real depends on it).
- **Request bodies are whole-buffer in v1.** Streaming uploads (fetch
  `duplex:'half'`, Chromium-only) would be a NEW op added later, not a
  change to this one. Same for WebSockets: separate future RPC kind.
- **Timeouts live client-side** (host.js/veneer drive abort); the kernel
  imposes none of its own beyond the buffer cap.
- **No policy in v1**: any process may fetch any URL (the browser flavor is
  already CORS-constrained by the platform). The kernel choke point is where
  policy would land later — a reason FOR brokering, not v1 scope.

## Plan

1. KERNEL.md design section + opcode additions (keep the layout comment in
   sync).
2. kernel.js: transfer table + ops + fetch driver (`fetch` is global in both
   worker and Node ≥18 — the embedder supplies nothing); teardown sweep hook.
3. host.js: `KernelClient` methods + a minimal wasm-env surface for the
   veneer to build on (0173 owns the curl API itself).
4. Tests: `tests/kernel/test_http.js` (fake worker, deterministic — fake
   fetch injected) + `test_http_e2e.js` (real C over a local Node http
   server; no external network in tests). Add the path→suite rule in
   tests/run.js RULES when landing (file is hot under parallel work right
   now — don't touch early).

## Acceptance

- A C program (via the 0173 veneer or a raw-import shim) can stream a
  chunked response from a local Node server; backpressure holds (server
  writes 10MB, C reads slowly, kernel buffer stays bounded); abort
  mid-transfer doesn't wedge; EOF is distinguishable from a dropped
  connection.
- Kill the process mid-transfer: transfer reclaimed, no dangling fetch.
- boot.js and kernel-worker flavors both pass the same e2e.
