# gcode's content-block cluster: #738 (P0), #747, #748

Lane F, 2026-08-26. Base `origin/main` = `7d4f4d03`, branch
`lane/738-gcode-blocks`. Three defects found by #678 Pass B round 3 while
routing gcode against a real Anthropic endpoint for the first time. They share
one root cause that is worth naming: **the estate's standing live route for
gcode is DeepSeek (jku ruling 2026-07-31), and DeepSeek is forgiving in exactly
the three places gcode was wrong.** It accepts empty text blocks, it auto-caches
server-side without being asked, and its context window really is 128k. Every
one of these bugs is invisible on the only route we exercise.

That is the transferable lesson, not the individual fixes: *a provider that
tolerates your mistakes is not a test of your correctness.* The three defects
had been shipping for months behind a green suite.

## #738 — the P0. Every non-`tool_use` block collapsed to text

`content_block_start` recognised `tool_use` and sent everything else down a
`b->type = 't'` branch. A `thinking` block accumulates no text — its deltas are
`thinking_delta`, which the reader never looked at — so it replayed as
`{"type":"text","text":""}` and the API refused the whole request:

    400 "messages: text content blocks must be non-empty"

gcode classifies that as permanent, so the turn dies. Reproduced live 3/3 by
#678 and again here with a base-vs-fixed control on the same prompt and model.

### The design call that mattered

The ticket offered a one-line symptom fix (skip empty text blocks at the
replay). Three reasons that was not enough.

**(a) It trades one 400 for another.** `amsg` is appended unconditionally with
`content: acontent`. A round whose only block was an empty text block then
sends `content: []`, which the same API also refuses. Any test that merely
grepped the outgoing body for empty text blocks would have gone green on a
still-broken build.

**(b) Preserving thinking is the contract, not a nicety.** Thinking blocks are
replayed unchanged — signature included — while the conversation continues on
the same model, and the API rejects a *modified* block. So flattening is not a
lossy-but-valid simplification; it is a different rejected request.

**(c) The empty-block rule must NOT be generalised from text to thinking.**
This is the trap, and it is the one a reviewer should check first. `display`
defaults to `"omitted"`, so an EMPTY thinking body is the normal case. From the
live run's persisted history:

    sample thinking block:  thinking text len : 0
                            signature len     : 668

Generalising "drop empty blocks" would have silently discarded that block and
its 668-byte signature — and a dropped thinking block can trip the ordering and
signature checks on a tool-use turn. The obvious simplification is the bug.

### The general case, not a list of today's names

A fix that enumerates `thinking` and `redacted_thinking` is the same bug waiting
for the next block type. The parser now has five arms —
`'t' | 'u' | 'k' | 'r' | '?'` — and the `'?'` arm captures an unrecognised
`content_block` VERBATIM and replays it byte-for-byte, dropping it (loudly, by
name) only when a delta arrived that this build could not apply, which proves
the captured copy partial. Replaying a partial block as whole is worse than an
honest gap. `blocks_self_test()` leg 5 exercises both halves with a
`future_thing` block this build has, by construction, never heard of.

## #747 — no prompt caching at all

`grep -c cache_control gcode.c` was 0. Round N re-paid for rounds 1..N-1, so a
session's input cost grew with the SQUARE of its round count. Measured
cacheRead 0 across 7 Anthropic rounds.

The interesting part is that this could not be fixed by adding a key: `system`
was a bare JSON string, and a JSON string cannot carry `cache_control`. **The
defect was a container that could not hold the fix.** It is now a one-element
text-block array, which is why three existing `#530` legs (two of them in the
in-OS kernel e2e) went red and needed a shape-agnostic `systemText()` reader —
those legs are about the prompt TEXT, not its container.

The second breakpoint — on the last content block of the last message — MOVES
each round, and that made it a `#348` hazard. `messages` is attached to the body
BY REFERENCE and is the same object that gets persisted, so a marker left behind
would be re-sent AND written to the session log, accumulating one stale
breakpoint per round until the request blew the 4-breakpoint ceiling. It would
have failed several rounds into a long session — exactly where it costs most,
and exactly where a short test never looks. So the marker is applied, the
payload serialized, and the marker removed; a smoke leg asserts the persisted
log contains no `cache_control`, and the live run confirmed 0 occurrences.

Measured live, per round:

    round 1: in=158 out=129 cache_create=1512 cache_read=0
    round 2: in=2   out=101 cache_create=304  cache_read=1512
    round 3: in=2   out=75  cache_create=208  cache_read=1816
    round 4: in=2   out=89  cache_create=91   cache_read=2024

A second session minutes later opened at `cache_read=1512` on its round 1 — a
cross-session hit on the tools+system prefix inside the 5-minute TTL.

`GCODE_CACHE=0` restores the byte-identical pre-#747 body. It exists because
array-form `system` is canonical Messages API but is **untested against the
third-party Anthropic-compatible endpoints gcode also targets** — including the
standing route. That is an open risk, flagged rather than claimed clean.

## #748 — the context window table, and why the obvious fix was refused

`strstr(model, "claude") -> 200000` gave every Claude model 200k. Right for
Haiku 4.5, wrong for Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6, Fable 5 and
Mythos 5, all of which are 1M. gcode compacts at 85%, so on its own default
model it folded history at ~170k with 830k unused — ~5.9x early.

The ticket proposed flipping the blanket to `claude -> 1000000`. **That was
refused.** It is the same class of error — a confident guess about models the
table has never heard of — in the worse direction: over-stating a window means
never compacting until the provider hard-400s, where under-stating only folds
early. It is also wrong for `claude-opus-4-5`, `claude-opus-4-1` and
`claude-sonnet-4-5`, which are 200k and all contain `claude`.

What landed instead: exact rows for known models, then a family row of 200000
that is a **true lower bound rather than a guess** (no shipped Claude model has
ever had a smaller window), then the existing `CTX_WINDOW_DEFAULT`. Ordering is
load-bearing because matching is first-match substring — deliberately substring
so a dated id (`claude-opus-4-5-20251101`) and a provider-prefixed one
(`anthropic.claude-opus-5`) both resolve.

## Test discipline notes worth keeping

- **`startStrictServer()`** in `smoke.mjs` enforces the API's own
  non-empty-text rule. A fake that accepts a body the real provider refuses
  turns a reproduction into a no-op; the strict variant is what makes the ten
  new #738 assertions a red control (10/10 RED against base `gcode.c`).
- **Mutation ledgers, published with their misses.** 8/8 for #738, 7/7 for
  #747, 4/5 for #748. The one that did not fire (deleting the explicit
  `claude-haiku` row) is correctly not caught — the family row carries the same
  number, so no answer changes — and is recorded rather than papered over. One
  #747 mutation (wrong block *within* the last message) is caught only by the
  unit leg, because a one-block message makes first and last the same.
- **The targeted gate earned its keep**: `kernel --filter=gcode` went 5P/1F on
  the in-OS `#530` legs, a break the native smoke could not see because the
  break was in a different fake server.

---

# Addendum — the counter-pass, and what the production route was really losing

Two things landed after the first review round. Both change the story.

## The must-fix Codex found: "known delta name" is not "applicable delta"

My `'?'` arm was built on a rule I stated correctly in the comment and then
implemented wrongly. The comment says an unrecognised block is dropped when
"a delta arrived that this build could not apply". The code tested whether the
delta's NAME was in our table:

    if      (text_delta)       ...
    else if (input_json_delta) ...
    else if (thinking_delta)   ...
    else if (signature_delta)  ...
    else if (b->type == '?')   b->lost = 1;      <-- last

Those are different questions, and the gap between them is a live block type.
`server_tool_use` is a real Messages API kind this build does not model, and it
streams `input_json_delta` — exactly like `tool_use`. Matched on name it took
the second arm: the payload accumulated into `b->json`, a field the `'?'`
replay never reads; `lost` stayed clear; and the block went back as its start
object with an **empty input**. A partial block presented as whole — the single
failure the `'?'` arm exists to prevent, reintroduced by the arm's own
ordering.

The fix is to ask the right question, which means asking it FIRST:

    if (b->type == '?') b->lost = 1;   /* before any delta name */

For a block kind whose semantics we do not know, no delta is applicable however
familiar its name looks. A known name tells us about the delta, not about the
block it belongs to.

**The lesson worth keeping is not "check ordering".** It is that my correction 2
in the previous round fixed an *adjacent* path — malformed typeless blocks — and
I let its plausibility stand in for coverage of the real mechanism. Two defects
in the same arm, one fixed, and the fix made the other harder to see. The test I
had written (`future_thing` with an *unknown* delta name) confirmed the
behaviour I had implemented rather than the rule I had written down; the leg
that catches this one uses a *known* delta name on an unknown block, which is
the case the rule actually covers.

## What #738 was costing on the route the estate actually uses

The ticket says the defect is invisible on DeepSeek, because that endpoint
accepts empty text blocks so there is no 400. Measured on
`api.deepseek.com/anthropic` with `deepseek-v4-flash`, that is true and
incomplete. DeepSeek returns real thinking blocks, with bodies:

    persisted block kinds: {'text': 2, 'thinking': 3, 'tool_use': 2, 'tool_result': 2}
    3 thinking blocks, ALL signed, 270 chars of thinking body

Under the old code those three signed blocks were collapsed to
`{"type":"text","text":""}` and replayed as nothing. **The model's own reasoning
was being silently deleted from its replayed history on every round of every
DeepSeek run**, with no error, no 400, and no symptom anyone could observe.

So "no 400" was never "no harm", and #738's P0 case is stronger than the ticket
argued: it is a hard failure on the metered routes *and* a silent
context-quality loss on the standing one. A defect that only degrades quality
is exactly the kind a forgiving provider will hide indefinitely — which is the
same lesson as the top of this log, arriving by a second road.

## #747 against the production route: neutral, and that is the right answer

Same route, fixed binary. `system` as a block array is **accepted** — no 400,
no compat wall — so the risk flagged in the first round is closed by
measurement rather than argument. `GCODE_CACHE=0` also completes a full turn
there, so the escape hatch is known-live rather than known-untested.

    round 1: in=1099 out=94  cache_create=0 cache_read=0
    round 2: in=61   out=50  cache_create=0 cache_read=1152
    round 3: in=127  out=81  cache_create=0 cache_read=1152

`cache_creation` is always 0: DeepSeek auto-caches server-side and does not
report writes. The `GCODE_CACHE=0` run *also* showed `cache-read=3456`, i.e.
the reads happen whether or not gcode asks. **#747 is therefore neutral on
DeepSeek and wins on metered Anthropic routes** — which is what the ticket
predicted, and it means the change carries no regression risk on the route that
carries the traffic.
