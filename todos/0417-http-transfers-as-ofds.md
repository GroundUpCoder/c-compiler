# 0417 — HTTP transfers become OFDs: fd-shaped, waitable, and bounded by a deadline

- **Status**: open
- **Design**: this file; `todos/KERNEL.md` (the 0x04xx and 0x06xx opcode tables).
  The precedent is `todos/done/0264` (FS_WATCH, ticket #75) — the last time a new
  kernel object became an OFD.
- **Provenance**: found by the Rust program on 2026-07-29. **This ticket stands on
  its own merits. File it and land it whatever any Rust decision says.** `/bin/curl`
  wants it today, and so does every networked C program the estate ever adds.

## The gap

The HTTP transport (`todos/0172`, `kernel.js:7108-7192`) gives a process five ops:
`HTTP_BODY`, `HTTP_OPEN`, `HTTP_STATUS`, `HTTP_READ` and `HTTP_CLOSE`. `HTTP_OPEN`
returns a **transfer id** from a private counter, held in `_httpXfers` and in
`pcb.https`. That id is not a file descriptor. Three consequences follow, and each
one is a real limit today.

**1. A transfer cannot be waited on with anything else.** `_selectScan` walks the fd
table. A transfer is not in the fd table, so `FS_SELECT` and the unified `FS_WAIT`
of `todos/0178` cannot see it. A process that wants to wait for a response **or** a
pipe **or** its input ring cannot express that wait.

**2. A process can only park on one transfer.** `HTTP_STATUS` and `HTTP_READ` both
write `pcb.waiter` (`kernel.js:7170`, `kernel.js:7182`), and a process control block
has exactly one waiter slot. Several transfers may run at once, because the kernel
owns the fetches. The process still cannot ask "wake me when **any** of them is
ready". It must poll them in turn, and each poll parks on one.

**3. The kernel applies no deadline.** `_httpStart` arms no timer. The transfer holds
an `AbortController`, and only `HTTP_CLOSE` and process teardown fire it. The park
itself is interruptible, so a signal does release it — the libcurl veneer builds its
`CURLOPT_TIMEOUT` out of exactly that (`os/curl/libcurl.c:178`, `310-316`, an
`ITIMER_REAL` alarm). But that puts the deadline in every caller, and a caller that
arms no alarm waits with no limit at all.

## The design

Make a transfer an **OFD kind**, the way `todos/0264` made a watch an OFD kind.

**`HTTP_OPEN` returns a file descriptor.** The transfer becomes an open file
description of kind `http` in the ordinary fd table. `close(2)` releases it, and the
last release aborts the fetch through the existing `AbortController`. The existing
`_ofdUnref` path already models a last-release action, so reuse it and delete
`HTTP_CLOSE`.

**Readability has an explicit rule.** An `http` fd is readable when the response
headers have arrived, when body bytes are queued, when the stream reached its end,
or when the transfer failed.

🔴 **Add an explicit `_selectScan` branch. The default arm of `_selectScan` reports
always-readable.** `todos/0264` calls this out as mandatory, and it is mandatory for
the same reason here: without the branch, every `http` fd reports ready the moment it
opens, and a caller then spins.

**The body drains through `FS_READ`.** An `http` fd reads like any other stream fd.
It gives bytes, it gives 0 at the end of the stream, and it gives `EAGAIN` when it
is dry and non-blocking. The kernel keeps the backpressure it already has: the async
reader pauses past `HTTP_BUF_CAP`, and a read that drains below the cap resumes it.

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

## The one C consumer

`os/curl/libcurl.c` is the only caller of `__http_open`, `__http_status`,
`__http_read` and `__http_close` in the tree. `/bin/curl` and `/bin/gucman` both
reach the transport through that veneer.

🔴 **Convert the veneer in the same change, and delete the id path.** Do not keep the
old ops beside the new ones. A second path that nothing exercises is the zombie
fallback this estate rejects. `CURLOPT_TIMEOUT` and `CURLOPT_CONNECTTIMEOUT` then map
onto the two kernel deadlines, and the `ITIMER_REAL` alarm in the veneer goes away.

## Plan

1. Add the `http` OFD kind. `HTTP_OPEN` allocates an fd. Delete `HTTP_CLOSE`.
2. Add the explicit `_selectScan` branch.
3. Serve `FS_READ` on an `http` fd, and keep the backpressure behaviour.
4. Make `HTTP_STATUS` non-blocking.
5. Add the two deadlines, the kernel defaults and the distinguishable error.
6. Convert `os/curl/libcurl.c`, and delete the alarm.
7. Update the `todos/KERNEL.md` opcode table and the header comment at
   `kernel.js:7108`.

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
  stream.
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
