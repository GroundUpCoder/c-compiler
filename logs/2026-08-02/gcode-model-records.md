# gcode: truthful returned-model display, self-contained records, per-round pricing (#348 + #313)

One lane, four commits, `os/gcode/gcode.c` + `os/gcode/test/smoke.mjs`. Commit
order was re-sequenced by jku's direct instruction (2026-08-02): the one-row
price fix and the user-visible model line land FIRST, each independently
mergeable, so they survive even if the record/pricing half had run out of road.

## #313 — dated Sonnet 5 intro rate (commit 1)

`price_usage` priced `claude-sonnet-5` at the $3/$15 sticker; the live intro
rate — re-verified against the Anthropic pricing reference at fix time, per the
ticket's own acceptance — is $2/$10 through 2026-08-31. Took the ticket's
**option 2** (dated effective-until rate) deliberately: today is 29 days from
the rollover, so a one-constant fix would be wrong in the opposite direction
almost immediately, and intro pricing is a recurring Anthropic pattern the
table wants to express. The pick is factored as `price_usage_at(model, u,
"YYYY-MM-DD")` so the self-test pins BOTH sides of the rollover with fixed
dates instead of going stale on 2026-09-01. Unknown-model behavior (return
-1.0, omit the line) and the cache multipliers are untouched.

## #348 display slice (commit 2)

The terminal never showed `message_start.model` — both `report_usage` calls got
`cfg->model`, the requested alias. `ctx` dies inside `do_turn` while the
summary prints from `agent_loop`, so the returned model is carried on
`session.response_model` (the seam per-round pricing needed anyway). The turn
summary prints the RETURNED model, `(requested <alias>)` only when different,
and falls back to the requested name when the stream never carried
`message_start`. The self-test's `cfg.model` was `"fixture-model"` — equal to
the fixture's returned model **by construction**, so the divergence this line
exists for was never exercised; it is now `"requested-alias"`.

## #348 record contract (commit 3)

**The trap:** `do_turn` attaches `messages` to the request body **by
reference** (`cJSON_AddItemReferenceToObject`), so metadata keys added to the
in-memory assistant message would ship to the provider on the next round.
Metadata therefore attaches only inside `persist_api_round` /
`persist_assistant_message` — record-side, fed from the `stream_ctx`. The
assistant record is now self-contained (model, request_model,
provider_message_id, stop_reason, normalized usage, raw_usage, turn identity,
content); smoke.mjs asserts every history assistant message in a real
multi-round request body carries ONLY `role`+`content`.

Linking is by identity on EXISTING record types — `turn_id`
(`<session_id>-<turn_index>`, matching turn_start/turn_end) plus a 1-based
`round` — no new record type, no reorder, so the record-sequence golden stands.

**Decisions recorded:**
- `LOG_SCHEMA_VERSION` stays 1. Fields are additive; the resume reader ignores
  unknown fields and tolerates absent ones, so old logs resume under the new
  binary and new logs are readable by old readers. A bump would have forced a
  migration story for zero compatibility benefit.
- **Declined** a raw `provider_metadata` dump of the whole `message_start`
  message: every field gcode consumes is individually persisted, `raw_usage`
  already carries unknown future counters through the round-trip (asserted in
  the self-test against the JSONL, not just the parse), and a full dump would
  duplicate content blobs into every round record.

## #348 per-round pricing (commit 4)

The scalar `usage_add` destroyed per-round model attribution before pricing
ran; swapping the display string alone would have priced the whole turn's
aggregate at the LAST round's model — satisfying the ticket's display bullet
while wrong in a new way. Real fix: per-model buckets (`mlist`) on both the
turn and the session, ADDITIVE next to the scalar totals (resume and its
golden depend on the scalars). `format_cost_line` prices each bucket with its
own model; a part-known turn appends an explicit partial marker
(`$0.000100  (1 round unpriced: mystery-model-x)`) — a bare understated total
reads authoritative, the exact failure mode #313 fixed. All-unknown keeps
omitting the line. Resume rebuilds buckets from `api_round` records with the
fallback chain response_model → request_model → session_meta model →
requested. `turn_end`/`session_end` gain a `models` array (ordered actual-model
set); the turn line adds `rounds: N` (when >1) and `stop: X` (when abnormal).
A model-less stream books its round under the requested name — same fallback
as the display; that is deliberately "identity we asked for" rather than
"unknown", since there is no better identity to price by.

## Evidence

- Native oracle: 22 → 28 checks (payload purity, divergent/equal/model-less
  model line, mixed-model partial marker + round count), all green.
- Self-test: rollover both sides, four format_model_line cases, three
  cost-line cases, JSONL round-trip of the self-contained assistant record,
  bucket reconstruction on resume.
- In-OS: `tests/kernel/run.js --filter=code` — test_code_e2e,
  test_gcode_step2_e2e, test_gcode_native all pass against the real baked
  image.
