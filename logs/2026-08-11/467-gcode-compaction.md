# #467 — gcode compacts at the context ceiling

Lane-467, base `ae13d907`. The ruled design (night decider, 2026-08-03):
**COMPACT** — summarize-and-drop the oldest rounds, in-process, loudly — never
warn-and-refuse. Everything below is the implementation's *why*.

## The shape

- **Accounting** (`sess->last_prompt_tokens`): the assembled prompt of round N
  is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  from that round's usage. This is the hazard the kickoff flagged as the
  silent-dead-compactor trap: on a cached conversation `input_tokens` alone is
  tiny (the #462 incident logged 900,480 cache-read tokens against a small
  input count). The smoke leg A deliberately delivers 15,800 of its 16,300
  tokens as `cache_read` so a wrong-field regression goes red, not vacuous.
  Resume rebuilds the same number from the replayed `api_round` records, so a
  resumed near-ceiling session compacts *before* its first POST.
- **Ceiling**: window − `max_tokens` (the output reservation), floored at half
  the window. The window comes from a substring table (`claude` → 200k,
  `deepseek` → 128k) with an **unknown-model default of 128k that is a live
  ceiling, never "off"** — the pricing table's omit-the-line fallback is honest
  for a $ figure and a vacuous green for a compactor (kickoff hazard 4; gcode
  is live-tested against a non-Anthropic base URL). Override:
  `--context-tokens` / `GCODE_CONTEXT_TOKENS`. Thresholds: warn 75%, compact
  85% (`GCODE_WARN_PCT` / `GCODE_COMPACT_PCT`, the `GCODE_BASH_SECS` env-knob
  precedent), fold target 50%.
- **The fold is mechanical, not a summarize API call.** Rejected the
  Claude-Code-style model-generated summary deliberately: an in-process fold
  works against every provider, cannot itself fail or 400, is deterministic
  (byte-testable), and is available at the exact moment the provider is
  rejecting our requests. Cost: the summary is an outline (user asks,
  assistant text heads, tool calls + result first lines), not prose — the
  recent rounds stay verbatim, which is where the working context lives. "In-
  process" is also the ticket's own word for the ruling.
- **Cut discipline**: fold `messages[1..k)` into one user-role summary message
  spliced at index 1. `k` is valid only where `messages[k-1]` carries no
  `tool_use` (the #462/#463 pair invariant — a split pair manufactures the
  dangling-id 400 this family exists to prevent), keeps the first user message
  and at least the last two messages verbatim, and must include at least one
  non-summary message (re-folding only the previous summary is churn — this is
  what makes repeated `/compact` terminate). A prior summary merges body-first
  (marker header dropped), so summaries never nest and the marker count stays
  exactly 1. AUTO mode picks the smallest sufficient fold and no-ops when the
  estimate already fits (fold-level idempotence); MANUAL takes the largest
  valid fold; REJECTED (post-400) skips the early-out because the provider
  just proved the estimate wrong.
- **Token estimates** are serialized-bytes × tokens-per-byte, self-calibrated
  from the provider's own last usage number (fallback 0.25 t/B when no signal
  exists). No client-side tokenizer, per the ticket.
- **Persistence**: a `compact` JSONL record (folded count + the summary
  message + est before/after) that `session_resume` replays as the identical
  splice. This deliberately diverges from #463's unpersisted repair: a repair
  re-derives deterministically from the log alone; a compaction depends on
  usage-driven choices a re-reader may not reproduce, and the ticket requires
  the compacted history to be what a resume loads. Old gcode reading a new log
  ignores the record and gets the full (valid, merely big) history — additive
  schema, `LOG_SCHEMA_VERSION` stays 1. A mismatched record (hand-edited log)
  is skipped loudly.
- **The 400 recovery** sits *after* the #463 repair path in the same
  `permanent && !401/403` branch: only when the error body matches a
  context-length phrasing (`prompt is too long`, `exceed context limit`,
  `context_length`, …, matched case-insensitively against ids we do NOT parse
  out), and only when the fold actually removed messages, does it return `-4`.
  The `-4` retry shares `agent_loop`'s once-per-turn budget with the #463
  repair on purpose — one free retry per turn of any kind, loop-proof. The
  permanent classifier itself is untouched (kickoff hazard 2): the
  unknown-model 400 control asserts the pre-#467 verdict verbatim.
- **`/compact`** beside `/clear` (unchanged): the manual largest-fold,
  announced; "nothing to compact" when only the summary is left.

## Hazards, adjudicated

1. Stale ticket line numbers — confirmed stale; the structural claims held.
2. #463's repair path — landed *behind* it, gated on "did the fold mutate",
   sharing its retry budget. The classifier warning is honored; leg D asserts.
3. Token-accounting trap — the three-field sum, red-tested via cache_read
   dominance in smoke leg A.
4. Unknown-model window — live 128k default, self-tested
   (`context_window_for("totally-unknown") == 128000 != 0`).
5. Usage lags a round — the firm threshold sits at 85% to absorb ordinary
   growth; a single round that jumps the ceiling is netted by the 400
   recovery. Stated in the `context_guard` comment.
6. Versioning — `packages/gcode.json` `version` 0.2 → 0.3 (behavior change for
   installed users; #595 monotonicity satisfied), `sourcesVersion` 246 → 255
   (the sources-companion lineage rides image-version numbers; content
   changed, so the equal-version silent republish would have left `gucman
   upgrade` blind). **No `os/image.json` bump**: gcode.c reaches images only
   through the package fold — the only image.json gcode entry is the baked
   `GCODE.md`, untouched; the shipped image is minimal (no gcode payload), and
   the fat test fixture re-bakes on input mtimes, not version. Resealed
   `--packages=all` after the edit; verified the new binary's marker strings
   inside the sealed image (`grep -ac` = 3, positive-controlled).
7. Test surface — the e2e legs live in `os/gcode/test/smoke.mjs` (the native
   oracle; `tests/kernel/test_gcode_native.js` derives its check count from
   the source, so the 27 new checks enroll automatically — no registry edit).
   No new in-OS e2e: compaction has no platform seam (the seam inventory —
   spawn, signals, pty — is what the kernel gcode e2es exist for; the wasm
   build runs the identical code and the sealed-image grep proves it ships).

## Positive control (the acceptance's non-vacuity leg)

The leg-C script (resume a tool-round history, provider answers
`400 "prompt is too long: 22000 tokens > 18000 maximum"`, then 200) run
against both binaries, 2026-08-11:

- `ae13d907` (pre-change): **requests=1, recovered=false, permanent=true** —
  the REPL exits; the brick.
- lane-467: **requests=2, recovered=true, permanent=false**.

Leg D (unknown-model 400, same history shape): 1 request, permanent, no
compaction — on both binaries.

## What was deliberately not done

- No summarize-by-model call (rationale above; revisit if the mechanical
  outline proves too lossy in dogfood rounds — the seam is
  `compact_summary_text`).
- No baked GCODE.md edit: compaction is client mechanics, not model-facing
  orientation, and touching it would have pulled an image.json bump into a
  package-only change.
- The warn/compact percentages are env knobs, not flags — the ticket asks
  "configurable alongside max_tokens/max_turns"; the window (the axis that
  varies by provider) got the real flag, the percentages got the
  `GCODE_BASH_SECS`-pattern envs.
- `wmctl`/in-OS e2e legs: nothing here touches the kernel surface.
