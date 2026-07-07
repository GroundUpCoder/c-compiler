# Lingering-items sweep — host output path, first-run test, vi-regex verdict

Session goal: burn down HANDOFF's "lingering small items" in effort order,
stop at the first genuinely hard one. Three landed, one reclassified.

## 1. runModule 'error' listener leak (`9ecb0a1`)

The exit-on-EPIPE handler (`prog | head` → exit 141) was defined inside
runModule and `.on()`'d per call with default writers — N runs in one
process stacked N listeners. Hoisted to module scope, installed
idempotently per stream (`listeners().indexOf` guard, not a boolean flag,
because stdout/stderr install independently depending on which writer
defaulted). `tests/host/test_epipe_listeners.js` fails pre-fix (5
listeners after 5 runs), passes post-fix, and asserts custom-writer runs
install nothing.

## 2. First-run path test (`1326537`)

The regression class from `logs/2026-07-06/first-boot-ux-and-seeding-perf.md`
#1 (printed URL 404s) had no coverage because os-boots.mjs navigates to a
hardcoded URL. `tests/serve/test_first_run.js` parses serve.js stdout like
a human: URL must end `/os/os.html`, 200 text/html, COOP/COEP present,
worker scripts + kernel.js/host.js/compiler.js servable, missing path
404s. Ephemeral port via `serve.js . 0`. New fast runner:
**`node tests/host/run.js`** (host-level Node suite; the place for future
Node-output-path tests).

## 3. Stdout truncation pair (`a27218a`)

Both CONFORMANCE-REMAINING "Node output path" data-loss items, fixed
together as the doc prescribed:

- **Drain before exit**: CLI exits through `flushAndExit` — a zero-length
  write's callback fires only after everything queued before it flushed.
  Blocks as long as the pipe consumer takes (native-stdio semantics);
  EPIPE during the drain rides the existing handler.
- **Copy out of wasm memory**: default Node writers `Buffer.from` the
  chunk. stream.write queues by reference; memory.grow detaches the view.

The doc's prediction ("fixing that one WILL surface this one") was
empirically exact: with only the drain fix, the test sees corruption at
byte 131080 — right past the pipe buffer, where queuing starts.

**Test-harness gotcha worth remembering**: the first version of the
slow-consumer test attached `child.on('close')` *after* its 400ms sleep.
Pre-fix, the child exits and tears its streams down during the sleep, the
listener never fires, the awaited promise leaks, the event loop runs dry
— and Node exits **0** with no output, i.e. the failing configuration
looked like a pass. A test that can fall off the event loop fails open.
Attach lifecycle listeners at spawn time, always.

## 4. FEATURE_VI_REGEX_SEARCH — reclassified HARD, not done

HANDOFF's ~1-2h estimate assumed "we DO have regex (musl regcomp)".
Verified against `libc-ext.js`: we have POSIX `regcomp/regexec/regfree/
regerror` only. vi.c's `/search` (`char_search`) needs the **GNU** API —
`re_compile_pattern`, `re_search`, `re_syntax_options`, `not_bol/not_eol`
— all absent; and `:s///` calls `regexec(..., REG_STARTEND)`, also absent
(vi.c is the only busybox user of it). So the flip needs either a GNU
regex compat shim in libc (backward-scan re_search, syntax-option
mapping, REG_STARTEND emulation) or hand-patching both vi.c search paths
onto POSIX — hours plus permanent divergence from upstream, for a feature
nobody has missed yet. Left off; details recorded in HANDOFF.

## Not attempted (the hard tier)

Console SAB ring overflow (needs a real SPSC protocol + browser-side
verification), mkimage.js, bare `$(trap)`, AF_INET relay.

Suites at end of session: unit 700 ✓, blockfs ✓, kernel ✓, host ✓,
browser os-boots (real Chromium) ✓.
