# Kernel HTTP transport landed (0172)

**Date**: 2026-07-13
**Item**: todos/0172 (done). Follows the plan in
logs/2026-07-13/0172-http-stack-plan.md. Unblocks 0173 (libcurl veneer) and
0174's in-OS leg.

## What landed

A fetch-backed HTTP transport for processes — the `0x06xx` RPC family:
`HTTP_BODY` (stage request body), `HTTP_OPEN` (start fetch, return id at
once), `HTTP_STATUS` (park for headers), `HTTP_READ` (deferred body drain),
`HTTP_CLOSE` (abort+free).

- **kernel.js**: opcodes + `_httpRpc` and a small async driver
  (`_httpStart`/`_httpPump`/`_httpDrain`/`_httpServeStatus`/`_httpServeRead`/
  `_httpDestroy`). Body queues as a **chunk list** (`xfer.chunks`/`bytes`),
  not a flat byte array — the 512K e2e would be brutal per-byte. Backpressure:
  the fetch reader pauses past `HTTP_BUF_CAP` (256K) and resumes when a read
  drains below it, reusing the pipe machinery's park convention
  (`_cancelWaiter` learns `httpstatus`/`httpread`). Teardown reclaim in
  `_exitProcess` next to fds/surfaces/audio. `opts.fetch` is injectable
  (`'fetch' in opts` gate so `fetch: null` explicitly disables → ENOSYS;
  omitted uses the global).
- **host.js**: `createHttp(ctx, hooks)` exposes `__http_open/status/read/close`
  over the spawnHooks (`httpBody`/`httpOpen`/`httpStatus`/`httpRead`/
  `httpClose`), staging the body in page-sized chunks. Fail-loud ENOSYS with
  no kernel (the two-transports-one-fs precedent).
- **compiler.js**: `__import` prelude decls for the four `__http_*` imports
  (next to the clipboard ones), so C links them like any host import.

## Design calls worth remembering

- **Private wire, pinned semantics.** The RPC format is a kernel.js↔host.js
  contract (refactorable); what's load-bearing is the *behavior* — fetch
  shape, streaming backpressure, EOF≠error, C-side abort, header cap. All in
  KERNEL.md's new "HTTP transport" section + the 0172 body. Non-socket by
  necessity (no raw TCP in a browser); TLS free from the fetch stack.
- **Additive to kernel.js.** New opcode range, new dispatch prefix, new
  methods, two lines in `_cancelWaiter`/`_exitProcess`, one spawnHooks block.
  Nothing in the compositor/wm/fs paths moved — landed safely alongside the
  parallel compositor work (which had gone quiet).

## Two bugs found while testing

1. **Fake fetch returned the Response directly**, real fetch returns a
   Promise. Matched the COMPILE hook's `Promise.resolve(this._fetch(...))`
   tolerance rather than forcing every caller (and tests) to wrap.
2. **`reader.cancel()` rejects on an already-errored stream** (the mid-stream
   `/drop` case) — an async rejection a sync `try/catch` can't catch, so it
   escaped as an unhandled rejection and crashed the e2e. Fixed by
   `.catch`-swallowing the cancel promise in `_httpDestroy`. This is the kind
   of thing only a real-stack e2e surfaces — the deterministic unit test with
   a fake reader never hit it.

## Tests

- `tests/kernel/test_http.js` — 27 checks, fake worker + injected fake fetch:
  deferred status (gated promise), streaming + reassembly, POST body verbatim
  + parsed header pairs, **backpressure** (reader plateaus near cap, kernel
  buffer bounded, full drain + integrity), mid-stream error≠EOF, connect
  error, sync-throw, teardown reclaim (kill mid-transfer → reader cancelled +
  no dangling xfer), EBADF, `fetch:null`→ENOSYS.
- `tests/kernel/test_http_e2e.js` — real C in a worker_thread over Node's
  global fetch to a local `http.Server`: streamed GET, POST echo, 512K body
  integrity through the real streaming reader, 404 (perform succeeds), a
  socket-destroy mid-stream (→ rc -3, not EOF), zero dangling transfers after
  halt.
- Both registered in `tests/kernel/run.js`'s manifest (the runner uses an
  explicit list, not a glob). `tests/run.js` RULES already map every touched
  path — no UNMAPPED, no new rule needed. Regression: kernel + conformance
  slices green.

## Next

0173 (libcurl veneer) sits directly on the `__http_*` primitive — the C
program in `test_http_e2e.js` (open → status → read-loop → close) IS the
shape `curl_easy_perform` maps onto. Then 0174's in-OS seam.
