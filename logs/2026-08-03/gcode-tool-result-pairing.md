# #462 — gcode: pair `tool_result` on message SHAPE, never on `stop_reason`

A live gucOS gcode session (`~/git/apps/game`, `deepseek-v4-flash`) was
permanently bricked by a turn that ended `stop_reason: max_tokens`. Every send
after it returned HTTP 400 (`tool_use ids were found without tool_result blocks
immediately after: call_00_vKx8…`), gcode classifies a 4xx as permanent (#387)
and breaks the REPL — a session carrying 900 480 cache-read tokens was destroyed.

## The load-bearing mistake

`do_turn` appended the assistant message **unconditionally**, tool_use blocks
included, but appended the matching `tool_results` array **only** in the
`stop_reason == "tool_use"` branch. The else branch ran `cJSON_Delete` on
results whose tools had **already executed** in the block loop above. The API
contract is structural, not stop-reason-keyed: *any* assistant message carrying
a `tool_use` block must be followed by a user message carrying the matching
`tool_result` blocks. So every other terminal reason — `max_tokens`,
`stop_sequence`, `refusal`, an unknown reason, or a compat-shim provider that
returns `end_turn` alongside tool calls (DeepSeek is exactly that class) — left
a dangling `tool_use` and a permanently API-invalid history.

The `#412` comment four lines above the deletion already *stated* the invariant
("every tool_use needs a tool_result or the history goes API-invalid and the
session stops being resumable"). The code violated it. A true comment next to
false code is worse than no comment: it reads as known-and-handled.

**It poisoned the persisted log too.** `persist_assistant_message` is
unconditional; `persist_message(sess, umsg, "tool")` was inside the same
branch — so `--resume` replayed the hole and re-bricked instantly, and a crash
*between* those two calls corrupts an ordinary round the same way. The fixture
therefore asserts the persisted JSONL separately from the in-memory array; a
test that checked only the array would have gone green over a still-broken
`--resume`.

## What changed

1. **Pairing is keyed on shape.** `have_tool_use = cJSON_GetArraySize(tool_results) > 0`
   decides; the array is deleted only when genuinely empty. The
   continue/stop decision is now a *separate* block, so history validity does
   not depend on it.
2. **A truncated call never runs.** The old code did
   `cJSON_Parse` → NULL → substitute `{}` → **execute anyway**. That is where
   jku's confusing `error: write_file needs string 'path' and 'content'` came
   from, and for `bash` it is a half-emitted command executing. A failed parse
   now yields an explanatory `tool_result` naming `max_tokens` and the actual
   cap instead.
3. **Belt and braces on `max_tokens`.** Blocks stream in order, so a cap cut can
   only be in the last active block. Under `max_tokens` that block is refused
   even when its JSON happens to parse — the pre-fix binary really did execute
   it (the fixture's leg B is a `bash touch` sentinel that proves it). Earlier
   blocks in the same round are complete and still run.
4. **Self-heal.** A truncated round returns continue (1), so the model retries
   smaller. Capped at `TRUNC_MAX_CONTINUATIONS` (3) **consecutive**
   continuations, deliberately independent of `max_turns` (which defaults to
   unlimited, #353) and **loud** when it trips — a silent truncation storm
   eating the turn budget would be a worse failure than the brick. The streak
   is per-turn (reset in `append_user_text`), or a turn that ended on the cap
   would make the next one give up before its first round.

## The cap: measured, not assumed

The proposal said "32k". A cap the provider rejects converts a rare brick into
a 400 on *every* request — strictly worse — so the value was probed against the
providers actually in use, 2026-08-03:

| provider | model | `max_tokens` | result |
|---|---|---|---|
| api.anthropic.com | `claude-opus-4-8` (gcode's default) | 32768 / 128000 | 200 |
| api.anthropic.com | `claude-opus-4-8` | 128001 | 400 `> 128000` |
| api.anthropic.com | `claude-haiku-4-5` (lowest live cap) | 32000 / 32768 / 64000 | 200 |
| api.anthropic.com | `claude-haiku-4-5` | 128000 | 400 `> 64000` |
| api.anthropic.com | `claude-3-haiku-20240307` | any | **404 — retired** |
| api.deepseek.com/anthropic | `deepseek-v4-flash`, `-pro` | 4096 … 128000, 1000000 | 200 (no validation at all) |

The models with genuinely small caps (3-haiku 4096, 3.5-sonnet 8192) are all
retired and 404, so **64000 is the smallest output cap any live Anthropic model
accepts**. 32768 sits at half of that, and is accepted by every model probed
including the DeepSeek shim. `ANTHROPIC_MAX_TOKENS` was added alongside
`--max-tokens`, and the resolved value is **clamped** to `[256, 128000]` with a
printed note rather than passed through — 128000 being the largest value any
probed provider accepts.

## Positive control

Every new assertion except one was run against the **pre-fix** `gcode.c` first:
**21 of 22 failed**, and the one that passed is the labelled negative control
("an earlier, complete tool call in the same round still RUNS"), which must pass
on both sides to mean anything. All 42 pre-existing oracle checks stayed green
across the swap.

The fixtures live in `os/gcode/test/smoke.mjs` (the scripted-SSE harness that
drives the **real** binary through `do_turn`), so they need no suite
registration: `tests/kernel/test_gcode_native.js` derives the required check
count from the source's `check(` call sites, and a new check raises the
requirement automatically. 42 → 64 checks.
