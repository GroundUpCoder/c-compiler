# CD28 — stdin/pipe byte buffers: O(n²) splice arrays → one ByteQueue chunk deque (todos/0246)

## What

host.js had four stream byte buffers implemented as plain JS arrays — fill
by `push(byte)` per byte, drain by a byte-by-byte copy loop plus
`splice(0, n)`. splice shifts the whole tail on every drain, so bulk input
was quadratic. Measured with a compiled 16K-buffer `cat` over `--block-fs`:
32MB of piped stdin took **9.34s pre-fix, 0.055s post-fix** (~170×), outputs
byte-identical (`cmp` old vs new vs input).

The fix is ONE helper, `ByteQueue` (host.js, just under `wrapLseekI64`,
well above the `@cc-strip-below` sentinel so single-file emits carry it): a
chunk deque — whole `Uint8Array` chunks appended, `read(dst, n)` copies out
via `subarray`/`set` advancing a head offset into the front chunk, dropping
consumed chunks. That's kernel.js's existing typed-array/`set` drain idiom
(there was no reusable byte-queue anywhere in the tree to import — kernel.js
inlines SAB rings per site), packaged once instead of invented a third way.

## Sites routed through it (the whole class)

- `createFileSystem` `stdinBuf`: `process.stdin.on('data')` appends the
  chunk whole; `readImpl`'s stdin branch drains with `read(buf, count)`.
- `createFileSystem` `pipe.buffer` (the JSPI pipe patch): write pushes the
  wasm-memory view (ByteQueue **always copies** — the view's backing memory
  is reused by the program and detaches on `memory.grow`), read drains into
  the destination view.
- `BlockFS._stdinBuffer`: `setStdin` now appends its argument as one chunk
  (Uint8Array/Buffer preferred; the legacy array-of-byte-values shape still
  works via `Uint8Array.from`).
- `BlockFS` in-memory `pipe.buffer` (the non-brokered pipe).
- The `--block-fs` CLI stdin loop: `readSync` chunks feed
  `setStdin(buf.subarray(0, nr))` per chunk — the per-byte `stdinChunks`
  array is gone.

Design detail that kept the diff small: `ByteQueue.length` mirrors
`Array#length`, so every readiness check (`pipe.buffer.length > 0` in both
select backends, `stdinBuf.length` in readImpl's park condition) reads
byte-identically with zero call-site changes.

## Deliberately left alone

- kernel.js's own `splice(0,n)` arrays (tty `_cooked`, sock-conn frame
  accumulator, kernel-pipe LATENT `pipe.buf`): line-sized / frame-sized /
  ring-bounded (256K, and LATENT mode is transitional by design). Out of
  CD28's host.js scope; a candidate follow-up if any shows up in a profile.
- CD29 (createFileSystem's read/write/close monkey-patch shape) and CD52
  (dual env syscall surfaces): the buffer change lives inside those
  structures but doesn't restructure them — separate items.

## Tests

- `tests/host/test_stream_bulk.js` (new, registered in tests/host/run.js):
  6MB through the JSPI pipe with mutually-prime write/read chunk sizes
  (65536/50021) so drains straddle chunk boundaries and the head offset;
  4MB through a child process's real piped stdin; pattern bytes are a
  function of global stream offset, so loss/duplication/misordering fails
  at a precise offset. EOF-after-close asserted on both.
- `tests/blockfs/test_blockfs.js`: 4MB interleaved pipe passthrough, 4MB
  chunked `setStdin` drain, legacy setStdin array shape.
- Gate (all foreground, all green): unit 757, host 12 files, blockfs 15,
  kernel 76, browser sweep 27. No codegen or image input touched — host.js
  runtime buffering only, no bake, no SameBoy interlock.
