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
