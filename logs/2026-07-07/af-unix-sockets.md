# AF_UNIX sockets — the pipe machinery, twice (todos/0008)

The OS gets its first socket family. `socket`/`bind`/`listen`/`accept`/
`connect`/`send`/`recv`/`socketpair`/`shutdown` over AF_UNIX between real
spawned processes, with S_IFSOCK rendezvous nodes in BlockFS and
poll/select integration. This unlocks IPC for the 0007 WM protocol without
any relay infrastructure — which is why it went first in Phase 4.

## The design bet, and that it paid

OS.md predicted AF_UNIX would be "trivial — pipes with names in BlockFS".
That held almost embarrassingly well, and the *why* is 0009's fd/data-plane
amendment: since the kernel owns fd tables and OFDs, a socket is just
another OFD kind, and everything an fd can do (inherit, dup, fd_actions,
FS_READ/FS_WRITE/FS_CLOSE/FS_SELECT, refcounted teardown on exit/SIGKILL)
was already generic. The whole data plane is:

- A connection = a PAIR of pipe-shaped directions (`{buf, cap, rOpen,
  wOpen, readWaiters, writeWaiters}` — the exact pipe fields). A connected
  socket OFD holds crossed `rx`/`tx` pointers into the pair.
- The pipe branch bodies of FS_READ/FS_WRITE moved verbatim into
  `_streamRead`/`_streamWrite`; pipes and sockets now call the same
  helpers. Deferred socket waiters register under the pipe op names, so
  `_pipeNotify`, `_cancelWaiter`, and krpc-intr EINTR serve both kinds
  with zero new machinery.

What was genuinely new is only the control plane (0x05xx opcodes):

- **Rendezvous**: bind mknods a real S_IFSOCK inode (the generic v4 mknod
  the /dev nodes already use — NO on-disk format change, fsck untouched)
  and registers the resolved path in a kernel map. connect resolves through
  the fs first — so unlink→ENOENT, non-socket→ECONNREFUSED, and symlinked
  socket paths work for free — then requires a LISTENING OFD.
- **connect never blocks** (v1): within-backlog connections queue with
  usable buffers (client writes land before accept); over-backlog is
  ECONNREFUSED with the socket left fresh for retry. A parked accept is
  served directly by the arriving connect.
- **shutdown is connection-global** where close is per-reference: SHUT_WR
  kills the tx direction's writer side, SHUT_RD the rx reader side.

## Bugs the tests caught before landing

1. **Write-after-SHUT_WR returned success.** `_streamWrite` only checked
   `rOpen` (reader gone) — the pipe world's only close reason. Sockets add
   a second: your OWN write side shut down. Fix: EPIPE on `!wOpen` too,
   both in the immediate path and in `_pipeNotify`'s parked-writer branch
   (a dup-holder can shutdown while a writer is parked).
2. **The test killed pid 1 with SIGPIPE.** init wrote into a dead peer with
   SIGPIPE at DFL → terminate → system halt mid-test. Not a kernel bug —
   that's exactly the `yes | head` semantics working — but a good reminder
   that EPIPE tests must IGN/handle SIGPIPE first.
3. **"Hang" that was POSIX being right**: a spawned child inherits the
   listener fd, so the parent's close doesn't tear the listener down
   (refs>0) and queued clients see no EOF. Real spawners close inherited
   fds via actions; the test now does the same. Kept as a comment in the
   test since it *will* bite someone again.

Also fixed while here: `BlockFS.open()` on an S_IFSOCK node now returns
ENXIO (POSIX) instead of treating it as an empty regular file
(`tests/blockfs/test_posix.js` case 10).

## libc surface

`<sys/socket.h>` + `<sys/un.h>` are new bundled headers. The wrappers
marshal `sockaddr_un` down to plain paths for the `__sock_*` imports (the
only address family there is), validate family/type libc-side
(EAFNOSUPPORT/EPROTONOSUPPORT — no RPC for doomed calls), and map
send/recv onto write/read. poll and select needed nothing: poll already
rode `__select_impl`, and FS_SELECT just learned socket readiness
(listener ready ⇔ pending connection; conn ready ⇔ data or peer-gone;
write-ready ⇔ tx not full). Errno additions: ENOTSOCK, EDESTADDRREQ,
EPROTOTYPE, EPROTONOSUPPORT, EAFNOSUPPORT, EISCONN (+ host errnoMap
socket block). The env entries live in `toWasmEnv` dispatching via
`this.sock*`, so RemoteFS (kernel RPCs) and plain BlockFS (ENOSYS) share
one surface — the same seam every other brokered syscall uses; the plain
Node-fs CLI env got linking stubs.

## v1 non-goals (recorded in KERNEL.md so nobody trips)

SOCK_DGRAM/SEQPACKET, abstract namespace, SCM_RIGHTS fd passing,
O_NONBLOCK socket I/O, MSG_PEEK, blocking-until-accept connect. AF_INET is
its own future item (needs a WebSocket/WebTransport relay).

## Verification

- `tests/kernel/test_sockets.js` — 65 protocol-level checks over the SAB
  protocol with fake workers (state errors, rendezvous lifecycle incl.
  rebind-after-unlink + listener-close fan-out, backlog, deferred accept,
  EINTR, shutdown matrix, socketpair, dup refcounts, SIGKILL-while-parked,
  OFD/rendezvous leak baselines).
- `tests/kernel/test_sockets_e2e.js` — real C client/server through the
  wasm libc: server's select-on-listener + parked accept woken by the
  client's connect, poll on the connection, ping/PONG both directions,
  EOF on close, socketpair + stat S_ISSOCK in init. Stage results ride
  exit-code bitmasks (server=255, client=7) so interleaved stdout can't
  garble the verdict.
- Full suites green: unit 697, blockfs (incl. new socket-node case),
  kernel all files.
