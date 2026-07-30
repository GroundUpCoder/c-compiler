# 0417 — HTTP transfers become OFDs

The ticket was pre-corrected by a design pass, and the corrections held.
This log records the decisions and the traps met during the build, not the
design — the design is the ticket.

## Decisions taken here

- **A no-fs kernel now answers `ENOSYS` at `HTTP_OPEN`.** Before this
  change, HTTP worked on a kernel without `opts.fs`. A transfer is an fd
  now, and a no-fs kernel has no fd table. Both in-tree embedders pass
  `fs`, and standalone pages never reach the kernel. The alternative — a
  parallel handle table for one untestable flavor — is the two-paths shape
  this estate rejects. `test_http.js` leg Q pins the refusal.
- **The error text stays visible.** The old `__http_read` logged the
  transport's error string (the ticket-#78 rule). Plain `read(2)` would
  have dropped it. `RemoteFS.read` now logs `r.error` when a brokered read
  fails with one. The kernel attaches `error` only on the http error leg,
  so `EAGAIN` never logs.
- **The idle clock stops during a backpressure pause.** A paused reader
  waits on the consumer, not on the network. An idle deadline that runs
  through a pause would time out a healthy transfer whose consumer is
  slow. The pause clears the timer; the resume re-arms it.
- **The kernel defaults are 30 s (headers) and 120 s (idle).** Both are
  generous. Their job is to bound a caller that sets nothing, not to be
  tight.

## Traps met

- **A deadline abort provokes its own rejection.** `_httpExpire` sets
  `ETIMEDOUT`, then calls `ac.abort()`. The fetch promise then rejects
  with an `AbortError`. Both rejection handlers guard on
  `xfer.error !== null`, or the honest `ETIMEDOUT` would be overwritten
  with a generic `EIO`.
- **The fake worker owns ONE RPC slot.** The first draft of the
  transfer-plus-pipe leg parked pid 1 in `FS_WAIT`, then asked pid 1 to
  write the pipe. A parked page cannot carry a second RPC, so the leg
  hung. The fix: write the pipe before the wait, and use the transfer as
  the wake source for the park-then-wake half. The C e2e covers the same
  mixed wait in-process.
- **`res.write(' ')` is not "headers only".** The statusConsumed park
  probe needs headers with zero body bytes. Use `res.flushHeaders()`. A
  one-byte flush makes the fd readable and defeats the probe.

## Red control

`test_http.js` (new surface) against the pre-change kernel: 43 FAIL lines,
exit 1, bounded by a 60 s in-file watchdog. The first line names the
shape change (`HTTP_OPEN returns an fd ... got {"id":1}`). A hang is not a
possible outcome — every wait leg sits under the watchdog.

## Gate

todos 5/5 · unit 801/805 (1 xfail, 3 skipped) · host green · blockfs
15/15 · py 279/0/55 · micropython 584/0/65 · kernel 137/137 (recorded
137 of 137, filter null) · sweep 42/42 (recorded 42 of 42, filter null).
Each heavy suite ran once. The sweep dirtied the known todos/0438
screenshots; restored.
