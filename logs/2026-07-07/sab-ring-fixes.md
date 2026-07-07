# SAB ring fixes: console overflow (blocking) + audio writePos 2^31 wrap

Two CONFORMANCE-REMAINING items in host.js's SharedArrayBuffer rings,
fixed test-first (failing tests committed separately, then the fix).
Affects the standalone-page/emulator path (tinyemu-style `console_write`,
SDL audio) — the `os/` terminal goes through the kernel tty and was never
exposed to either bug.

## Console ring: overrun → permanent desync (now: pty-style blocking)

**The bug.** The `console_write` import copied bytes into the ring
unconditionally and `Atomics.add`'d `available` — never checking free
space. The receiver (`createConsoleReceiver`, 16 ms flush interval) keeps
its `readPos` as a **local JS variable**, so the producer couldn't check
progress even in principle. A burst > 64 KiB inside one flush window
(easy: ~4 MB/s output, or any rate in a background tab where timer
throttling stretches the interval to ≥1 s) overwrote unread bytes,
pushed `available` past capacity, and left `readPos`/`writePos` in
disagreement **forever** — every later flush reads from the wrong offset;
sliced ANSI sequences corrupt xterm until reload.

**The fix — blocking, chosen deliberately over drop-with-counter.**
POSIX-faithful: a full ring blocks the writer exactly like `write(2)` to
a full pty. The producer writes at most `capacity - available`, then
`Atomics.wait`s on `available` until the receiver drains and
`Atomics.notify`s (new, after its `Atomics.sub`). Writes larger than the
whole ring proceed in chunks, nudging `notifyConsole` per chunk so the
page can drain concurrently. The wait is bounded (100 ms, re-check loop)
so a lost notify degrades to a poll instead of a wedge; semantically it
still blocks until space. Consequence accepted with eyes open: a program
spewing console output in a background-throttled tab now *pauses* on the
full ring — which is what a real stopped pty does — instead of producing
garbage.

No layout change was needed: `available` was already the single SPSC
synchronization cell (producer adds after copy-in, consumer subtracts
after copy-out); the missing pieces were only the free-space check, the
wait, and the notify. The receiver's local `readPos` stays valid because
the producer can no longer advance past it.

Threading contract, now documented at `createSharedConsoleBuffer`: the
producer must live off the receiver's thread. It does — `console_write`
runs in the process worker (where `Atomics.wait` is legal, same as the
stdin ring's futex), the receiver on the page's main thread (which
couldn't wait anyway).

**Test** (`tests/host/test_console_ring.js`): real producer — compiled C
calling `console_write` via `runModule` in a `worker_threads` worker
(`--allow-undefined` resolves it as a host import, the tinyemu pattern) —
against the real receiver on the main thread. 1 MiB in small writes plus
one 200 KB single write (> the whole ring, exercises the chunked loop);
asserts byte-exact delivery and samples `available` at 1 ms asserting it
never exceeds capacity. 30 s watchdog so a deadlocked protocol fails
instead of hanging.

**Gotcha worth remembering:** the first pattern tried, `(g*131+7)&0xff`,
has period 256 — which **divides** the 64 KiB ring size, so every
producer lap rewrote each slot with the *same* byte and the pre-fix
overrun passed the byte-exact check. Ring-corruption tests need a pattern
period **coprime to the ring size** (251 here). The `available > capacity`
invariant check caught it anyway — belt and suspenders that earned their
keep on day one.

## Audio ring: writePos wraps negative at 2^31 (now: masked cursor)

`__sdl_queue_audio` advanced `control[0]` with an unbounded `Atomics.add`
on an Int32Array. After 2^31 cumulative bytes (~1.5–3 h of 44.1 kHz
stereo S16) the counter wraps negative; `writePos % cap` goes negative
and `ringData.set(..., negativeOffset)` throws RangeError, killing the
run. Repro compressed to milliseconds by seeding the counter near 2^31 —
honest, since that state is reachable one accepted chunk at a time.

Fix: store the cursor masked — `Atomics.store(control, 0,
(writePos + accepted) % cap)`. Single producer, so load/modify/store is
race-free. The receiver needed nothing: its
`((writePos - queuedBytes) % cap + cap) % cap` already handles any
in-range cursor (`queuedBytes ≤ cap` is enforced by the producer's
free-space check, which this path always had — unlike the console ring).

**Test** (`tests/host/test_audio_ring_wrap.js`): `createBrowserSDL`
constructs cleanly under Node with a stub canvas/ctx (WebGPU init is
lazy — `createCanvasGPU` touches nothing until first use), so the test
drives the **real** producer directly instead of needing a Playwright
spike. Asserts: no throw across the 2^31 boundary, cursor stays in
`[0, cap)`, and bytes land exactly where the receiver's readPos math
looks — including a write spanning the ring boundary.

## Verification

- `tests/host/run.js` — both new tests green (and proven to fail pre-fix:
  console = corruption + `available` ≈ 9× capacity; audio = the exact
  RangeError from the field report).
- Full sweep: unit, blockfs, kernel suites + browser `os-boots.mjs`.

Cross-refs: `todos/CONFORMANCE-REMAINING.md` (both items struck through),
`logs/2026-07-07/lingering-items-sweep.md` (the sibling Node output-path
fixes from earlier the same day).
