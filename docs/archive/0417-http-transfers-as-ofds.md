# 0417 — HTTP transfers become OFDs: fd-shaped, waitable, and bounded by a deadline

- **Status**: done (2026-07-30, branch `0417-http-ofd`)

## Result

Landed as one commit on `0417-http-ofd`. The transfer is an ordinary fd now.

- `HTTP_OPEN` returns `{fd}` (OFD kind `http`). The fd joins `FS_SELECT`
  and `FS_WAIT` through an explicit `_selectScan` branch. The branch tests
  the four consumables, and the status leg tests `statusConsumed`.
- `HTTP_STATUS` does not park. It answers `EAGAIN` before the headers
  arrive, and it sets `statusConsumed` when it answers.
- `FS_READ` serves the body and never parks: bytes, then 0 at EOF, the
  error when failed, `EAGAIN` when dry. A drain below `HTTP_BUF_CAP`
  resumes the paused fetch reader — the backpressure behaviour is kept.
- `HTTP_READ` (0x0604) and `HTTP_CLOSE` (0x0605) are deleted. The opcodes
  are retired and not reused. `pcb.https` and its `_exitProcess` sweep are
  deleted — the ordinary fd sweep aborts every live fetch. The `_httpXfers`
  map and `statusWaiter`/`readWaiter` are gone with them.
- Two kernel deadlines bound every transfer: headers (default 30 s,
  `headersMs` overrides) and idle (default 120 s, `idleMs` overrides,
  `idleMs < 0` disables). Expiry aborts the fetch and fails the transfer
  with `ETIMEDOUT` on the error leg. The idle clock stops during a
  backpressure pause, because that gap belongs to the consumer.
- `os/curl/libcurl.c` converted in the same commit. `CONNECTTIMEOUT` maps
  to the kernel headers deadline. `CURLOPT_TIMEOUT` runs on the veneer's
  wall clock through `__wait` timeouts. The `ITIMER_REAL`/`SIGALRM`
  apparatus is deleted.
- One added decision: `HTTP_OPEN` on a kernel without `opts.fs` answers
  `ENOSYS`. A transfer is an fd, and a no-fs kernel has no fd table. No
  in-tree embedder runs that combination; `test_http.js` pins it.
- The consumer contract (wait, consume the status once, read to `EAGAIN`,
  wait again) is documented in host.js `createHttp`, in the compiler
  prelude declarations, and in KERNEL.md.
- Liability L61 is retired. KERNEL.md's 0x06xx section is rewritten.
  `todos/W3M-INVESTIGATION.md`'s "ids are NOT fds" bullet now carries a
  correction. Image v199 (the baked `/bin/curl` and `gucman` relink the
  veneer).

Red control: the rewritten `test_http.js` against the pre-change kernel
fails with 43 explicit FAIL lines and exits 1 under a 60 s watchdog — a
visible failure, not a hang.

Gate (planner selection via `--diff`, every suite with a number, each heavy
suite run once): todos 5/5 · unit 801 passed / 1 xfail / 3 skipped of 805 ·
host green · blockfs 15/15 · run.py batch 279 passed / 0 failed / 55
skipped · micropython batch 584 passed / 0 failed / 65 skipped · kernel
137/137 (`recorded 137 of 137`, `filter: null`; includes the rewritten
`test_http.js`/`test_http_e2e.js` and the untouched-but-affected
`test_curl_e2e.js`, `test_gucman_e2e.js`, `test_gucman_quake_e2e.js`) ·
browser sweep 42/42 (`recorded 42 of 42`, `filter: null`). The sweep
dirtied three committed PNGs and one untracked screenshot (the known
todos/0438 class); restored.
- **Design**: this file; `todos/KERNEL.md` (the 0x04xx and 0x06xx opcode tables).
  The precedent is `todos/done/0264` (FS_WATCH, ticket #75) — the last time a new
  kernel object became an OFD.
  🔴 **A dedicated design pass has since checked this ticket against source and
  CORRECTED it in four places.** Its memo is `http-multiplex-design-memo.md` in the
  `meta` repo (`meta/gucos/notes/`, commit `fda48d26`, 77 file:line anchors). Every
  correction is folded into the text below, marked **[memo]** — this file remains the
  single source of truth and the lane does not need the memo to build. Read the memo
  only for the derivations behind the four calls.
- **Provenance**: found by the Rust program on 2026-07-29, and reached
  independently by a second design pass on the same day. **This ticket stands on its
  own merits. File it and land it whatever any Rust decision says.** `/bin/curl`
  wants it today, and so does every networked C program the estate ever adds.

## Standing

🔴 **This is a hard, unconditional prerequisite, and it is not contingent on
`todos/0418`.** It blocks a port of `codex exec` and a native gucOS client
**equally**, because both must multiplex one long server-sent-event stream against
other work. Neither shape can be built on the transport of today. Do not sequence
this behind a ruling. Two independent design passes reached it separately, which is
the strongest evidence this program produced.

## The gap

The HTTP transport (`todos/0172`, `kernel.js:7108-7192`) gives a process five ops:
`HTTP_BODY`, `HTTP_OPEN`, `HTTP_STATUS`, `HTTP_READ` and `HTTP_CLOSE`. `HTTP_OPEN`
returns a **transfer id** from a private counter, held in `_httpXfers` and in
`pcb.https`. That id is not a file descriptor. Three consequences follow, and each
one is a real limit today.

**1. A transfer never enters the fd table, so nothing can wait on it.** The
readiness scan `_selectScan` (`kernel.js:6766`) walks the fd table, and it knows
five OFD kinds: `tty`, `ptm`, `pipe`, `socket` and `watch`. There is no HTTP kind,
and an HTTP handle is not an fd at all. So `FS_SELECT` and the unified `FS_WAIT` of
`todos/0178` cannot see a transfer. A process that wants to wait for a response
**or** a pipe **or** its input ring cannot express that wait.

**2. At most ONE HTTP operation is in flight per process.** `HTTP_STATUS` and
`HTTP_READ` both write `pcb.waiter` (`kernel.js:7170`, `kernel.js:7182`), and a
process control block has exactly one waiter slot. Several transfers may run at
once, because the kernel owns the fetches. The process still cannot ask "wake me
when **any** of them is ready". It must poll them in turn, and each poll parks on
one.

🔴 **State the consequence plainly, because it is the whole reason this ticket
exists: an async runtime CANNOT multiplex a server-sent-event stream against
timers, against a child-process wait, or against a second request.** That is not a
performance limit. It is the shape of every agent loop, and no such loop can be
written on the transport of today.

**3. The kernel applies no deadline.** `_httpStart` arms no timer. The transfer holds
an `AbortController`, and only `HTTP_CLOSE` and process teardown fire it. But that
puts the deadline in every caller, and a caller that arms no alarm waits with no
limit at all.

### One correction to carry, because two readings of it exist

A second design pass described `__http_read` as parking "the entire process, with no
non-blocking variant". A first reading of the same code said a hung request wedges a
process forever and cannot be killed.

**Both readings are half right, and the accurate statement is this: the park is
interruptible, but it is neither pollable nor multiplexable.** `kernel.js:1457-1458`
passes the interruptible flag for both HTTP ops, `_cancelWaiter` handles both waiter
kinds (`kernel.js:7436-7438`), and the libcurl veneer builds `CURLOPT_TIMEOUT` on
exactly that with an `ITIMER_REAL` alarm (`os/curl/libcurl.c:178`, `310-316`). So a
signal **does** release the park, and a process **can** be killed.

Interruptible is not the same as pollable. A caller can be woken; a caller cannot ask
"is it ready?" and cannot wait on it beside anything else. Defects 1 and 2 above are
untouched by the correction, and they are the defects this ticket repairs.

🟢 **[memo] This correction has since been re-verified against source, independently,
and it holds.** The interruptible flag rides both hooks (`kernel.js:1457-1458`),
`krpc-intr` answers `EINTR` (`kernel.js:2743-2749`), and `_cancelWaiter` clears both
waiter kinds (`kernel.js:7436-7439`). ⇒ **The claim "a hung request is an unkillable
process" — as written at `rust-codex-queueing-handoff.md:24` — is REFUTED.** Do not
re-derive it from the same wrong intuition, and do not let it back into a ticket.

## The design

Make a transfer an **OFD kind**, the way `todos/0264` made a watch an OFD kind.

**`HTTP_OPEN` returns a file descriptor.** The transfer becomes an open file
description of kind `http` in the ordinary fd table. `close(2)` releases it, and the
last release aborts the fetch through the existing `AbortController`. The existing
`_ofdUnref` path already models a last-release action, so reuse it and delete
`HTTP_CLOSE`.

**Readability has an explicit rule.** An `http` fd is readable when at least one
**consumable** is pending:

- the response status arrived **and no `HTTP_STATUS` call has consumed it yet**;
- body bytes are queued (`xfer.bytes > 0`);
- the stream ended cleanly (`xfer.done`);
- the transfer failed (`xfer.error !== null`).

🔴 **[memo] The consumption clause on the status leg is load-bearing, and an earlier
version of this ticket omitted it.** That version said "readable when the response
headers have arrived", with no consumption clause. **Headers-arrived is a permanent
condition.** Under that rule a caller that consumed the status and is now waiting for
the first body byte finds the fd readable forever and spins: wait → read → `EAGAIN` →
wait. The fix is one bit — `HTTP_STATUS` sets `statusConsumed` on the transfer, and
the readiness leg tests `status !== null && !statusConsumed`.

The `done` and `error` legs stay permanent **on purpose**: a pipe at EOF is also
readable forever, and the reader's answer there (0 bytes, or the error) is the honest
one. Only the status leg needs the bit.

**Document the consumer contract the fswatch way** (`os/fswatch.h:16-17`): on a wake,
consume the status if you have not, then drain reads until `EAGAIN`, then re-wait. A
consumer that refuses to consume its pending status will spin, and the contract names
that as the caller's bug rather than the kernel's.

🔴 **Add an explicit `_selectScan` branch. The default arm of `_selectScan` reports
always-readable.** `todos/0264` calls this out as mandatory, and it is mandatory for
the same reason here: without the branch, every `http` fd reports ready the moment it
opens, and a caller then spins.

**The body drains through `FS_READ`,** on an `http` branch beside the watch branch
(`kernel.js:3541-3549`). It gives bytes when queued (via `_httpDrain`,
`kernel.js:7267-7279`, already clamped to the RPC payload cap), 0 at clean EOF, the
error when failed, and `EAGAIN` when dry. The kernel keeps the backpressure it
already has: the async reader pauses past `HTTP_BUF_CAP`, and a read that drains
below the cap resumes it.

🔴 **[memo] The branch NEVER PARKS. `http` fds are inherently non-blocking** — exactly
like watch fds (*"watch fds are inherently non-blocking; the contract is WAIT/select
first, then drain until EAGAIN"*, `kernel.js:3542-3544`). An earlier version of this
ticket said an http fd "reads like any other stream fd" and gives `EAGAIN` when it is
"dry **and non-blocking**", which left the question ambiguous. **It is decided here,
and there is no mode to opt into:** the kernel has no `O_NONBLOCK` machinery at all —
no `F_SETFL`, no per-OFD status flags; only `FS_FCNTL_DUPFD` exists
(`kernel.js:3804`, verified by search).

Two designs were possible — park-when-dry like a pipe (`_streamRead`,
`kernel.js:3551-3554`), or `EAGAIN`-when-dry like a watch. **The watch model wins for
a load-bearing reason: the `__wait` C surface does not name the ready fd.**
`waitMulti` returns only `why` and drops the kernel's ready lists at the import
boundary (`host.js:6756`). A woken caller therefore has to find the ready transfer by
trying, and try-read-until-`EAGAIN` is exactly that discipline. Do not implement a
parking read.

**[memo] Teardown becomes FREE, and a whole mechanism gets deleted.** `_exitProcess`
already releases every fd (`kernel.js:7460-7465`). Once a transfer IS an fd, that
loop does the work of the dedicated `pcb.https` sweep (`kernel.js:7490-7499`).
🔴 **Delete `pcb.https` and delete the sweep.** This is a net simplification the
ticket originally missed — it was described only as "`HTTP_OPEN` returns a transfer
id held in `_httpXfers` and in `pcb.https`", with no note that the second store
becomes dead. Do not leave `pcb.https` behind as an unused field.

**`HTTP_STATUS` stays, and it stops parking.** The status and the header blob are a
separate answer from the body, so they keep their own op. After the fd reports
readable, `HTTP_STATUS` answers at once. Before that, it answers `EAGAIN`. A caller
that wants to block waits on the fd, which is the point of the ticket.

**Two deadlines, not one.** A total-duration cap is the wrong shape: a legitimate
download runs for minutes, and a server-sent-event stream stays open for as long as
the model keeps talking. Use the two deadlines that describe the failure everybody
actually means.

- A **headers deadline** — the response headers must arrive within it.
- An **idle deadline** — the body stream must deliver at least one byte within it.

Both are set in the `HTTP_OPEN` request. Both have a kernel default, so a caller
that sets nothing is still bounded; a caller may raise either one, and may disable
the idle deadline explicitly for a stream that is legitimately silent. On expiry the
kernel aborts the fetch and marks the transfer failed, so a parked reader wakes with
an error and a program that watches the fd sees it become readable. **A deadline
that expires must produce a distinguishable error**, not a generic `EIO` — a caller
has to be able to tell a timeout from a refused connection.

**[memo] The code is `ETIMEDOUT`, and the plumbing already exists end to end:** errno
110 in the host table (`host.js:10856`) and in libc (`compiler.js:23879`), with
strerror text (`compiler.js:32077`). Nothing new is needed to carry it. An expired
transfer becomes readable on the error leg, so a parked waiter wakes and reads it.

## The one C consumer

`os/curl/libcurl.c` is the only caller of `__http_open`, `__http_status`,
`__http_read` and `__http_close` in the tree. `/bin/curl` and `/bin/gucman` both
reach the transport through that veneer.

🔴 **Convert the veneer in the same change, and delete the id path.** Do not keep the
old ops beside the new ones. A second path that nothing exercises is the zombie
fallback this estate rejects.

🔴 **[memo] The timeout mapping is NOT "both options onto the two kernel deadlines" —
that was wrong in an earlier version of this ticket, and building it would silently
change what `CURLOPT_TIMEOUT` means.** `CURLOPT_TIMEOUT` is a **whole-operation** cap
(`os/curl/libcurl.c:158-159`), and **neither kernel deadline expresses that**: the
headers deadline bounds only the head of the transfer, and the idle deadline bounds
only the gap between bytes. A download that streams steadily for an hour violates
`CURLOPT_TIMEOUT` and violates neither deadline.

The exact mapping is:

- `CURLOPT_CONNECTTIMEOUT` → **the kernel headers deadline**.
- `CURLOPT_TIMEOUT` → **the veneer's own wall clock**, enforced through `__wait`'s
  `timeoutMs`: the veneer waits with `remaining_ms` and treats `why = 0` as
  `CURLE_OPERATION_TIMEDOUT`.

This still deletes the entire `ITIMER_REAL`/`SIGALRM` apparatus
(`os/curl/libcurl.c:178-203`, armed at `319-347`) — and it is **more** faithful to
curl than the alarm was. The two kernel deadlines remain underneath as defaults, so a
caller that sets no curl option is still bounded.

## Plan

1. Add the `http` OFD kind. `HTTP_OPEN` allocates an fd. Delete `HTTP_CLOSE`.
   **Delete `pcb.https` and its `_exitProcess` sweep** (`kernel.js:7490-7499`); the
   fd-release loop at `kernel.js:7460-7465` already covers it.
2. Add the explicit `_selectScan` branch, **including the `statusConsumed` test on
   the status leg**. The branch is mandatory, not an optimization: the default arm
   reports unknown kinds always-readable and would wake every parked waiter forever
   (the watch branch says why, `kernel.js:6792-6795`).
3. Serve `FS_READ` on an `http` fd — **`EAGAIN` when dry, never parking** — and keep
   the backpressure behaviour.
4. Make `HTTP_STATUS` non-blocking, **and have it set `statusConsumed`**.
5. Add the two deadlines, the kernel defaults, and `ETIMEDOUT` as the distinguishable
   error.
6. Convert `os/curl/libcurl.c`: `CONNECTTIMEOUT` → the headers deadline,
   `CURLOPT_TIMEOUT` → the veneer's own wall clock via `__wait timeoutMs`, and delete
   the `ITIMER_REAL`/`SIGALRM` apparatus.
7. Update the `todos/KERNEL.md` opcode table and the header comment at
   `kernel.js:7108`.
8. Document the consumer contract (consume status → drain to `EAGAIN` → re-wait)
   where a C caller will find it, the way `os/fswatch.h:16-17` does for watches.

## Acceptance

- A C test opens **two** transfers, waits on both through ONE `FS_WAIT`, and reads
  each one as it becomes ready. This is the check that fails today.
- A C test waits on one transfer and one pipe through one `FS_WAIT`, and the pipe
  wakes it.
- A transfer whose server never answers hits the headers deadline, and the process
  returns an error and continues. It does not wedge.
- A transfer whose body stalls hits the idle deadline. A slow but live stream, which
  delivers a byte inside the idle window, does **not** hit it.
- A timeout error is distinguishable from a connection error and from a clean end of
  stream, and it arrives as `ETIMEDOUT` rather than a generic `EIO`.
- **[memo] A caller that consumes the status and then waits for the first body byte
  BLOCKS — it does not spin.** This is the `statusConsumed` check, and it is the one
  acceptance item that fails under the ticket's original readiness rule. A test that
  only opens and reads will not catch it; the test must consume the status first,
  then re-wait, and assert the wait actually parked.
- **[memo] A red control that must fail LOUDLY today, not hang.** On the pre-change
  kernel the same multi-transfer wait spins, because the id is not an fd and the scan
  never sees it. Write the control so that failure is visible as a failure.
- `close(2)` on the fd aborts the fetch. A test proves the abort.
- Backpressure still holds: a response larger than `HTTP_BUF_CAP` transfers in full,
  and the kernel never queues more than the cap.
- `/bin/curl` and `/bin/gucman` still work. The existing tests stay green with a
  NUMBER, and `CURLOPT_TIMEOUT` is honoured through the new deadline.
- The planner selects the suites (`node tests/run.js --diff`), and each one is green
  and reported with a NUMBER.

## Notes

The `todos` suite checks `todos/LIABILITIES.md`. This ticket funds register entry
`L61`, whose anchor is the header comment at `kernel.js:7108`. That comment changes
here, so re-anchor the entry or retire it in the same commit.
