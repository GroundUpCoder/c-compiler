# gcode Step 2: usage, durable sessions, and resume

Implemented on branch `gcode-step2` from the locked `2990b95` rename base in the dedicated `/Users/jku/git/wt-gcode-step2` worktree.

## What changed

- Merges Anthropic `message_start.message.usage` and `message_delta.usage`, retaining four normalized counters and a verbatim merged `raw_usage` object.
- Accumulates usage by API round, human turn, and session. Turn/session reports go to stderr so streamed model text remains stdout-only.
- Writes fsync-delimited, mode-0600 JSONL session logs with session metadata, replayable content-block messages, API rounds, turn boundaries, and session endings.
- Uses the native/XDG/home state roots and the gucOS `/root` fallback with the same schema on both targets. Persistence is default and failure is fatal; `--no-persist` is explicit.
- Adds `--resume ID|PATH`, `-c`/`--continue`, metadata mismatch warnings, crash-fragment handling, and context/usage/index reconstruction without replaying tools.
- `/clear` ends the old session, resets context and totals, and creates a new session log.
- Adds SIGINT-aware API cancellation so an active turn is durably marked `interrupted`.

## Deterministic verification

`os/gcode/test-step2.sh` builds with native clang without ASan and runs an embedded canned-SSE test. It checks normalized/cache usage, preservation of an unknown raw usage field, record ordering and sequence numbers, 0600 file mode, final-fragment handling, and resume reconstruction of messages, totals, and turn index.

Also compile-checked the gucOS conditional source path with clang `-D__MTOTS__`; image build/runtime verification is intentionally deferred to the later image lane.

## Close-out: merge + image v117 + in-image runtime verification (main lane)

Merged clean into main (`a1f9409`, zero overlap with the M1 menu files). The
deferred image lane surfaced the gap in the clang `-D__MTOTS__` compile check
above: macOS headers supply `gmtime_r`/`getline`/`CURLOPT_XFERINFOFUNCTION`/
`CURLE_ABORTED_BY_CALLBACK`, the real gucOS toolchain does not — so the v117
bake failed on exactly those four symbols. Fixes, both minimal:

- `os/curl/include/curl/curl.h` grew the two standard-valued constants
  (`CURLE_ABORTED_BY_CALLBACK = 42`, `CURLOPT_XFERINFOFUNCTION = 20219`); the
  veneer's documented contract already covers them — setopt classifies 20219
  as a function pointer and returns `CURLE_UNKNOWN_OPTION` (gcode ignores the
  return; progress-callback abort is a known veneer non-feature, so an in-OS
  SIGINT can't cancel a transfer mid-flight — it still marks the turn
  interrupted at the next safe point).
- `gcode.c` grew ONE `#ifdef __MTOTS__` block: `gmtime_r` wrapping the libc's
  static-buffer `gmtime` (single-threaded processes, safe) and a local
  `getline`. Native path byte-unchanged; `test-step2.sh` re-verified green.

Runtime verification IN the image (`tests/kernel/test_gcode_step2_e2e.js`,
registered in the kernel suite): in-image `--self-test` PASS; a real `-p` run
against the fake SSE server (which grew optional per-response usage counters,
real-API shape) prints turn/session usage to stderr and writes a 0600 JSONL
under `/root/.local/state/gcode/sessions`; `-c` and `--resume PATH` in fresh
processes report `resumed (2|4 messages)` with session totals accumulating
11/7 → 32/12 → 63/16, and the server's body dump proves the replayed history
reached the API. Gate: kernel 83/83, image v117 sealed, compiler.js untouched.
