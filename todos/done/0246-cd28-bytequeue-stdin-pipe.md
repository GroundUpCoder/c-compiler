# 0246 — CD28 — stdin/pipe byte buffers: push-per-byte + splice(0,n) O(n²) → one ByteQueue chunk deque

- **Status**: done (2026-07-17) — ONE `ByteQueue` helper in host.js; all four
  stdin/pipe array buffers routed through it (createFileSystem stdinBuf +
  pipe.buffer, BlockFS `_stdinBuffer` + in-memory pipe.buffer) plus the two
  per-byte fill loops (setStdin, the `--block-fs` CLI stdin read loop);
  32MB stdin passthrough 9.34s → 0.055s, outputs byte-identical;
  `tests/host/test_stream_bulk.js` + bulk cases in
  `tests/blockfs/test_blockfs.js`; unit/host/blockfs/kernel/sweep green
- **Design**: —

## Goal

Close code-debt scan CD28 (2026-07-17): host.js's stdin and in-memory pipe
byte buffers were plain JS arrays — `push(byte)` per byte on the fill side,
`splice(0, n)` (plus a byte-by-byte copy-out loop) on the drain side. splice
shifts the entire tail on every read, so bulk input was O(n²): a multi-MB
pipe/stdin stream burned seconds of pure array-shuffling (measured: 32MB
through `cat` via `--block-fs` took 9.3s pre-fix, 0.055s post-fix).
kernel.js's norm is already typed-array rings drained with `subarray`+`set`;
host.js should share one idiom, not four ad-hoc arrays.

## Plan

- ONE `ByteQueue` helper (host.js, above the `@cc-strip-below` sentinel so
  emitted bundles get it): a chunk deque — whole `Uint8Array` chunks in
  (always copied: callers push views over wasm memory, which the writer
  reuses and memory.grow detaches), `read(dst, n)` drains via
  `subarray`/`set` advancing a head offset, `length` mirrors Array#length so
  every `.length > 0` readiness check reads unchanged.
- Route the whole class through it:
  - createFileSystem `stdinBuf` (process.stdin chunks now append whole),
  - createFileSystem `pipe.buffer` (write pushes the wasm-memory view,
    ByteQueue copies; read drains into the dest view),
  - BlockFS `_stdinBuffer` (`setStdin` appends a chunk whole; still accepts
    the legacy array-of-byte-values shape),
  - BlockFS in-memory `pipe.buffer`,
  - the `--block-fs` CLI stdin loop (readSync chunks → `setStdin(subarray)`
    per chunk instead of a per-byte `stdinChunks` array).
- Exact semantics preserved: EOF signaling, `Math.min(count, available)`
  clamps, the blocking/ready checks, byte order.

## Acceptance

- `tests/host/test_stream_bulk.js`: 6MB through createFileSystem's pipe
  (mutually-prime chunk sizes so reads straddle chunk boundaries) + 4MB
  through a child's real piped stdin — byte-exact, then EOF.
- `tests/blockfs/test_blockfs.js`: 4MB pipe passthrough + 4MB setStdin
  drain, byte-exact; legacy setStdin array shape still works.
- Existing pipe/stdin tests unchanged and green; full unit + host + blockfs
  + kernel + browser-sweep suites green.
- Out of scope, surfaced: kernel.js's own small array `splice(0,n)` buffers
  (tty `_cooked` line buffer, sock-conn frame accumulator, kernel-pipe
  LATENT-mode `pipe.buf` — all bounded/small or being demoted); CD29 (the
  EBADF-guard dup + pipe monkey-patch shape of createFileSystem) and CD52
  (dual env syscall surfaces) are separate refactors the buffer change
  deliberately does not touch.
