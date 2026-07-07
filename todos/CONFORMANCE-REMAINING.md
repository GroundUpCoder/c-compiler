# Conformance campaign — verified-but-unfixed remainder

Leftovers from the July 2026 bug-hunt (see `logs/2026-07-05/conformance-campaign.md`).
Every item below was **confirmed** during the review (repro'd or code-verified);
they were deprioritized, not disproven. Fixed items live as green tests under
`tests/unit/conformance/` and `tests/blockfs/test_posix.js`.

## host.js — Node output path (medium, user-visible)

- ~~**Piped stdout truncated at exit**~~ — FIXED
  (`tests/host/test_stdout_flush.js`): the CLI exits through
  `flushAndExit`, which drains stdout/stderr (zero-length-write callback)
  before `process.exit`; exit code preserved, EPIPE during the drain
  still exits 141.
- ~~**Queued stdout chunks are non-copied views into wasm memory**~~ —
  FIXED (same test): runModule's default Node writers copy
  (`Buffer.from`) before `stream.write`. The predicted masking was real:
  with only the drain fix applied, the test catches corruption at the
  first post-pipe-buffer byte.
- ~~**Console SharedArrayBuffer ring has no overflow handling**~~ — FIXED
  (`tests/host/test_console_ring.js`): pty-style blocking backpressure.
  console_write writes at most the free space, then Atomics.wait()s on
  `available` until the receiver drains and notifies — a burst larger
  than the ring blocks the program like write(2) to a full pty, never
  laps the reader. Writes larger than the whole ring proceed in chunks.
  The test runs the real producer (compiled C in a worker_thread)
  against the real receiver and asserts byte-exact 1 MiB delivery
  (pattern period coprime to the ring size, so a lap can't fake
  correctness — the first pattern tried had period 256 and passed
  straight through the pre-fix overrun).
- ~~`runModule` leaks an `'error'` listener on process.stdout/stderr per
  call~~ — FIXED (`tests/host/test_epipe_listeners.js`): the exit-on-EPIPE
  handler moved to module scope with idempotent per-stream install.

## host.js — browser-only paths (code-verified)

Browser-testable via the existing Playwright harness in `tests/browser/`
(headless Chromium; real Safari via safaridriver — see its README). Fixed items
get a spike + `*-check.mjs`/`*-renders.mjs` there, same as the unit corpus.

- ~~**Audio ring write position wraps at 2^31**~~ — FIXED
  (`tests/host/test_audio_ring_wrap.js` — Node-level rather than a browser
  spike: createBrowserSDL constructs under Node with a stub canvas/ctx
  because WebGPU init is lazy, so the real `__sdl_queue_audio` is driven
  directly with the counter seeded near 2^31): writePos now stays masked
  modulo capacity (single producer → load/modify/store is race-free). The
  receiver already double-mod'ed its readPos math, so only the producer
  needed the mask.
- **S8 audio decoded with the U8 formula** (`(getInt8(x)-128)/128`): signed
  silence becomes a full-scale DC rail. Correct: `getInt8(x)/128`.
- ~~**`WGPU_WHOLE_SIZE` truncated** in `__wgpu_buffer_map_async` /
  `get_mapped_range`~~ — FIXED (`tests/browser/webgpu-wholesize-renders.mjs`):
  map_async mirrors the set_vertex/index_buffer `size < 0` special-case; the C
  wrapper resolves `(size_t)-1` via a new `__wgpu_buffer_get_size` import
  before allocating the staging copy; `WGPU_WHOLE_MAP_SIZE` added to webgpu.h.
- ~~**SDL keysym for shifted letters**~~ — **FALSE POSITIVE, dropped** (the
  campaign re-found a stray the 2026-06 SDL3 audit had already retired, see
  `todos/SDL3.md`). SDL3 keycodes are *modifier-applied* — upstream computes
  the event keycode as `SDL_GetKeyFromScancode(scancode, keyboard->modstate,
  true)` (src/events/SDL_keyboard.c), so Shift+a ⇒ SDLK_A (65) is CORRECT and
  `e.key.charCodeAt(0)` is the faithful implementation. "SDL keycodes are
  unshifted" is SDL2 semantics. Now pinned by
  `tests/browser/sdl-shifted-keysym-check.mjs` so it can't be "fixed" again.
- **Worker script not `</script>`-hardened in HTML output** (the top-level
  inline host.js is; the JSON.stringify'd worker copy isn't). Latent until a
  `</script`-containing string enters host.js or runArgs.

## compiler.js

- ~~**`__attribute__((aligned(N)))` after an array declarator crashes the
  compiler**~~ — FIXED 2026-07-07 (`tests/unit/conformance/parse_attr_aligned_arg`
  + `diag_attr_aligned_pow2`): the attribute handler called a nonexistent
  `this._constEvalInt` — and it crashed in EVERY declarator position with any
  argument, not just after arrays (busybox ALIGN1 was merely where it was
  found). Fixed to call the free `constEvalInt`; statics honor any power-of-2
  (allocateStatic), locals > 16 get an over-aligned frame (prologue masks the
  base into a dedicated local); non-power-of-2 now diagnosed like gcc/clang.
  The busybox ALIGN* workaround patch was reverted.
- **Volatile accesses vs the inliner**: `twice(mmio)` inlines to two volatile
  reads, `ignore(mmio)` to zero (C11 5.1.2.3 — access count is observable).
  Fix: EIdent/deref of volatile-qualified type must not be UNRESTRICTED
  linearity. Matters for tinyemu-class MMIO code; unobservable in the default
  host, which is why it was deferred.
- **Residual `longjmp` in non-statement position** (`x ? longjmp(b,1) : ...`,
  for-increment, return-expression) still crashes with a raw JS stack trace;
  the setjmp side has a proper diagnostic — add the longjmp counterpart.
- **setjmp contexts required by C11 7.13.1.1p5 but rejected**:
  `switch (setjmp(b))`, `while (setjmp(b) == 0)`, `else if (setjmp(b))`.
  (Plain `int r = setjmp(b);` is UB per the standard — rejecting it is fine,
  but the error message lists forms that are themselves rejected.)
- **GNU case ranges enumerate every value** (`case 0 ... 100000000:` builds a
  100M-entry table at compile time). Clamp/reject or emit range compares.
- **Missing libm entry points** (hosted C requires them): `exp2`, `fma`/`fmaf`
  (needs correctly-rounded impl — Dekker splitting), `remainder`, `remquo`,
  `scalbn`, `llround`, `llrint`, and the `*l` long-double aliases (trivial:
  long double == double here). QoI: `erf/erfc` ~1e-7 (A&S 7.1.26),
  `lgamma(1.0)` not exactly +0, `clock()` wraps at ~35.8 min.
- **wasm name section written as Latin-1** (spec requires UTF-8) — latent,
  C identifiers are ASCII in practice.
- **Pretty-printer** (`-a print`, debug only): EComma prints as `0, 0`.
- **Multichar constants** `'ab'` take the first char; gcc/clang pack bytes
  (implementation-defined, but FourCC code silently misbehaves).
- **Union bitfield static init writes the unmasked value** through
  `writeConstValueToStatic` (struct path was fixed; union path writes the
  whole unit without field masking). Edge case, found during review.

## Architecture recommendations (from the review, still open)

1. **AST invariant checker between passes** (test builds only): every
   SGoto.target present in-tree, every referenced DVar in scope, no EInitList
   on scalar slots, every lowered state has a segment. Each of the three
   worst optimizer bugs would have been a named assertion instead of a hang.
   Complements `todos/GOTO-LABELS-AST-REFACTOR.md` (which stays worth doing).
2. **Differential testing as a first-class test type** (`tests/differential/`
   vs native cc when available) — the clang-diff sweep found real bugs in
   minutes; randomized 20–50k-case hash comparisons are cheap. Subsumes the
   torture/c-testsuite plans in `MISC.md`.
3. **Extend the BlockFS fuzzer's MODEL, not its seeds**: open-fd lifetime
   (unlink/rename-over with the model tracking orphaned-but-open contents),
   sparse writes + hole reads, dup/F_DUPFD offset sharing, same-inode rename,
   near-capacity allocation. The 60-seed campaign passed while 9 real bugs
   sat in unmodeled ops.
4. **"Validator fired" = missing sema check**: every wasm-validation backstop
   hit should become a front-end diagnostic with a source location (the
   unprototyped-call ICE was this shape).
5. **No nulls across phase boundaries**: evaluators report at the failure
   point or return Result-shaped values; phase exits assert their invariants
   (the `#if` crash class).
