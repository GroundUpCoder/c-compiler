# 0046 — strace: per-pid syscall-RPC trace

The kernel brokers every syscall of every process, so `strace` here is
formatting, not mechanism — the item's premise held exactly. What landed:

- **kernel.js**: a per-pcb `trace` record `{ ofdId, pipe, follow, drops,
  cur }`. `_dispatchRpc` formats the request into `trace.cur`; the line
  lands when `_respond`/`_respondRaw` runs; `_deliver` adds
  `--- SIGxxx ---` arrival markers; `_exitProcess` flushes an
  `<unfinished>` line for an RPC outstanding at death, the drop count,
  and `+++ exited with N +++` / `+++ killed by SIGxxx +++`, then releases
  the kernel's write-end ref.
- **Spec growth** (OS.md's grows-by-field rule): `__spawn_spec.trace` =
  a pipe WRITE-end fd in the parent's table, host-read only under flags
  bit1 (`__SPAWN_TRACE`); bit2 (`__SPAWN_TRACE_CHILDREN`) makes
  descendants inherit the pipe (strace `-f`), with `[pid N]` prefixes on
  every line.
- **/bin/strace** (`os/strace.c`, seeded, image v47):
  `strace [-f] [-o FILE] cmd args...` — pipe, `__spawn` pre-traced with
  CLOSE fd-actions for both pipe ends, copy trace→stderr/FILE, waitpid,
  propagate status (128+sig for a signaled child; 127 on spawn failure).

## Decisions

- **The trace sink is an ordinary pipe OFD, created by the tracer.** The
  alternative (kernel-created pipe returned from spawn) would have grown
  the `__spawn` return ABI. This way the tracer's `pipe(2)` + a spec
  field reuse every tested pipe path (blocking reads, select, EOF), and
  the kernel just holds its own ref on the write end — the tracer's read
  end EOFs exactly at tracee teardown, no extra protocol.
- **Requests format EAGERLY at dispatch.** A RAW payload (`FS_WRITE`) is
  a view into the kernel-page SAB, which the response reuses — holding it
  until response time would trace corrupted args. Everything else could
  defer, but one rule is simpler than two.
- **Deferred RPCs trace at completion** (parked reads, WAIT): one whole
  line per RPC, request+result together. No `<unfinished ...>/<resumed>`
  splitting — with a single traced pid there's no interleaving to
  disambiguate, and `-f` interleaves whole lines. An RPC outstanding at
  death does print `= <unfinished>`.
- **The kernel never blocks on the trace pipe.** Past-cap lines drop and
  a `+++ N trace lines dropped (pipe full) +++` marker (force-written,
  like the exit markers — the drop notice must not itself drop) reports
  it at exit. Real strace pauses the tracee instead; we can't park a
  process that isn't in an RPC, and unbounded buffering would be a
  kernel OOM vector.
- **Old-binary compatibility by flag gate, not struct sniffing**:
  host.js reads spec offset 32 only under `__SPAWN_TRACE`, so pre-growth
  binaries (whose 32-byte spec would expose stack garbage there) can't
  enable tracing by accident. In-tree spec builders (`posix_spawn`
  header, busybox vfork shim, win32 `CreateProcess`) now set
  `trace = -1` explicitly for hygiene.
- **The decode table IS the `OP` map** (`OP_NAMES`, inverted once at
  module load): a new opcode traces by construction, KERNEL.md's opcode
  table stays the single source of truth. Args print as `k=v` in request
  field order with caps (64-char strings, 8-element arrays, 32-byte data
  previews — strace's `-s` default); results as the errno name, the bare
  value for single-numeric-key responses, or a `{k=v}` struct.
- **`-f` landed now** rather than "later if wanted": inheritance is five
  lines in `_spawnImage` and it's the difference between tracing a
  binary and tracing a shell pipeline — the agent-debugging win the item
  exists for.
- **Validation is loud**: `spec.trace` naming anything but a pipe write
  end → `EBADF`; a no-fs kernel → `ENOSYS`. No silent no-trace.

## Gotchas

- fd numbers in trace args/results are the CHILD's table (which IS the
  kernel table) — `strace`'s own pipe fds never appear because the spawn
  spec closes them in the child before the first traced RPC.
- `_traceLine` → `_pipeNotify` can re-enter `_respondRaw` for a parked
  tracer read; that tracer isn't the traced pcb, so `trace.cur` state
  can't cross-contaminate. (A traced strace tracing strace nests the
  same way, bounded by pipe depth.)
- busybox `cat` traces beautifully small: open/read/write/read-EOF/
  close/EXIT — six lines. See the acceptance run in
  `tests/kernel/test_strace_e2e.js`.

## Tests

- `tests/kernel/test_strace.js` (fake workers, no wasm): spec.trace
  validation, decode goldens (open/read raw preview/write raw
  request/errno/EXIT), deferred-trace-at-completion, SIGKILL
  `<unfinished>` + markers, EOF timing, `-f` inheritance + prefixes,
  non-follow isolation, drop policy.
- `tests/kernel/test_strace_e2e.js` (boot.js, real binary): the
  acceptance legs — `strace cat`'s fd stream, rc propagation (0/7/143),
  `--- SIGTERM ---` around a signal delivery, spawn-failure 127, `-f`
  multi-pid prefixes, `-o` with clean stderr.
