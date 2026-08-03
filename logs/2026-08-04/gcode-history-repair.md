# #463 — gcode validate-and-repair at the send seam (the recovery half)

Branch `ticket-463`, off `main` at `c7b3731d` (the #462 merge).

## What this is, and why it is not #462

`#462` stops gcode **creating** an invalid history. It cannot help two
histories that already exist:

- **logs poisoned by the shipped bug** — `--resume` replays them verbatim and
  re-bricks instantly; jku's 900,480-cache-read-token session is one of them;
- **crash-torn rounds** — the assistant message and its `tool_result`s are two
  independent appended+fsync'd records (the comment above the second
  `persist_message` call spells the window out, and `#467` owns closing it), so
  a stop between them corrupts an otherwise normal round.

This ticket is the recovery half: gcode repairs a history it already has.

## The invariant, both halves

The Messages API contract is structural, and repairing only the forward half
would trade one 400 for another:

- (a) every `tool_use` in an assistant message is answered by a `tool_result`
  with the same id in the **immediately following** message;
- (b) a `tool_result` may only answer a `tool_use` in the **immediately
  preceding** message.

`repair_drop_orphans` (b) runs **before** `repair_fill_missing` (a), and that
order is load-bearing rather than incidental: a drop can empty a message, and
removing that message is exactly what turns its predecessor into an unanswered
`tool_use` for half (a) to fix. The compound fixture in `repair_self_test`
(`[assistant(tool_use A), user(tool_result GHOST)]` → 2 changes) exists to pin
that composition.

## Three decisions worth recording

### 1. The repair is deliberately NOT persisted

The JSONL is append-only, so a *dropped* orphan can never be un-written. If
insertions were recorded and drops were not, the log and memory would disagree
— strictly worse than recording nothing. The pass is deterministic and
idempotent, so every load re-derives the identical repair and the **effective**
history after a `--resume` is the same either way. Leg A asserts the on-disk log
is only appended to; leg G asserts two separate processes resuming the same
poisoned log send byte-identical histories.

### 2. The retry gate is on MUTATION, never on the status code

The ticket's 🔴 is the real risk here, so the classifier is untouched:
`permanent = code >= 400 && code < 500 && code != 408 && code != 429` still
reads exactly as it did. What changed is that a permanent non-auth 4xx first
asks "did repairing this history change anything?" — mutated ⇒ exactly one
retry, then normal classification; no-op ⇒ the pre-#463 verdict, same message,
same exit. 401/403 do not even attempt a repair: no credential was ever fixed by
rewriting the conversation.

Leg D (unknown model, clean history → 1 request, "retrying cannot succeed") and
leg H (401 with a *repairable* history → 1 request, no repair attempted) are the
two controls. Leg H matters more than it looks: it separates the auth rule from
the mutation gate, and its error body deliberately contains the tool_use id to
bait the id matcher.

### 3. Why there is a second, server-directed pass

Without it the retry would be **provably dead code**, and shipping that is worse
than either shipping the retry or dropping it. The structural pass runs before
*every* POST, so by the time a 400 arrives it has already had its say — running
it again is a guaranteed no-op, and a retry gated on a guaranteed no-op never
fires.

What is genuinely new at that moment is the **server's** reading of the same
history. `history_repair_named` matches each id **already in our history**
against the error body (`strstr`, never sentence parsing — no grammar to track
across providers, and it cannot invent an id we do not hold; ids under
`REPAIR_ID_MIN_LEN` are skipped so a degenerate id cannot match by accident) and
canonicalizes the ones the server named: the `tool_result` run must **lead** the
answer message, which Anthropic requires and the structural pass deliberately
does not rewrite for. The **real** tool output is relocated, not replaced with a
marker — leg E asserts `REAL OUTPUT` survives the retry.

It processes one id per sweep and restarts, because `repair_take_result` can
delete a message it emptied, which invalidates every index and block pointer
held across a walk. Termination is structural, not just budgeted: a processed id
lands at index 0 of its answer message, which makes `repair_is_canonical` true
for it, so it is never selected twice.

## Positive controls — the reds, shown

**e2e (`smoke.mjs`, 68 → 98 checks).** The new file was run against the
**pre-fix object** (`git show c7b3731d:os/gcode/gcode.c` in place):
**13 FAILURES**, including `dangling tool_use toolu_463dangle`,
`orphan tool_result toolu_463orphan`, and leg E's `1 requests` where the fixed
binary sends 2. The fake server accepts anything, so "it did not crash" proves
nothing — every leg asserts the **sent body** is API-valid, mirroring
`history_is_valid()` in JS (`historyFaults`). Legs C, D and H are labelled
negative controls and pass on both objects, by design.

**unit (`--self-test`).** With both repair passes stubbed to `return 0`,
**8 of the 13 `repair_case` fixtures FAIL** and the self-test reports FAIL. The
5 that still pass are exactly the ones expecting 0 changes (clean history,
skewed-but-structurally-fine, unknown-model body, short id, empty history,
string content) — which is the correct shape for a control.

`repair_case` asserts idempotence on **every** fixture rather than once on a
chosen one: after the compare it runs a second structural pass and requires 0
changes and a byte-identical re-print.

## Gotcha: ASan earned its keep

`repair_drop_orphans` recorded the dropped id **after**
`cJSON_DeleteItemFromArray` freed the block `rid` pointed into — a clean
heap-use-after-free that the fixture would still have "passed" without the
sanitizer. `build-native.sh` builds with `-fsanitize=address`; keep it that way.

## What I did not do

- **The persist window is not closed here.** That is `#467`, deliberately: it
  needs a combined log record or an append-then-rename, and this ticket's
  resume-side repair is the other half of that pair (option 2 in `#467`'s body).
  The repair heals a torn round on load; it does not stop the tear.
- **An already-empty `content` array is left alone.** `repair_drop_orphans`
  removes a message only when *this pass* emptied it (the `had` guard). An
  array that arrived empty is a different defect and rewriting it would be the
  gratuitous rewriting the acceptance criteria forbid.
- **Duplicate `tool_result`s answering one `tool_use`** are not deduplicated by
  the structural pass (the named pass does drop them when it relocates). No
  evidence a provider rejects them, and inventing a rule here would be scope I
  cannot justify.

## Gate (re-run against the registry that exists after `7f01d2f7`)

The first gate attempt was **headless** — the turn ended mid-run, the suite
runner died, orphaned `os/boot.js` children kept the heavy lock looking valid,
and `summary.json` froze at `recorded: 91 / total: 154`. Those 91 files were
measured against a registry that lane B (#167 + #431) then replaced, so they
were **discarded rather than `--resume`d**: resuming would have banked stale
coverage under the new totals.

Merged `origin/main` (`7f01d2f7`) in — clean, no conflicts. `os/image.json` went
`228` (main) → `229` (this branch); nothing to hand-resolve.

Plan re-derived on the merged tree, not carried forward:
`node tests/run.js --diff origin/main --dry-run` → **`kernel, sweep`**, selected
by `os/gcode/gcode.c`, `os/gcode/test/smoke.mjs` and `os/image.json` (each maps
to both). `host` is **not** selected — the new `tests/spawn/` rule matches no
path in this diff.

| suite | done | files | non-pass | filter |
|---|---|---|---|---|
| kernel | true | total 155, selected 155, executed 155, recorded 155, resumed 0, carried 0 | 0 | null |
| sweep | true | total 50, selected 50, executed 50, recorded 50, resumed 0, carried 0 | 0 | null |

Both totals **moved** with the registry change — kernel 154 → **155**
(`test_punes_e2e.js` newly enrolled; it is an image test and this branch bumps
`os/image.json`, so it genuinely gates the change — **pass**, 14.6 s), sweep
49 → **50** (`os-harness-unit.mjs`, ex-`lib/test-harness.js` — **pass**).

`build/test-kernel/test_gcode_native.js.log` is the leg that proves the new
checks are actually registered rather than merely present:

```
ok   smoke.mjs declares a positive check count (derived 98)
ok   oracle ran ALL 98 checks (counted 98 ok lines)
```

68 → 98 is the whole of this ticket's e2e surface, and the count is derived from
the source's `check(` sites, so it cannot silently fail to take.

### Two harness traps worth writing down

**A long gate must not outlive its turn.** `test_os_boot.js` alone ran
**634 757 ms** — the tool cap is 600 s, so the suite can never fit in one call.
The harness backgrounds it saying "you will be notified"; that notification is
not a lifeline. The working shape is to stay in-turn behind a watcher that exits
on **completion or death**, and to probe the **lock file's real holder pid**
(`$TMPDIR/cc-heavy-tests.lock`) or the artifact — never the launching command
name, because `node tests/run.js sweep` execs into `os-sweep.mjs` and sheds its
own name.

**A worktree needs BOTH `node_modules` symlinks.** With only the root one, the
first sweep attempt failed **49 of 50** files at launch: resolution fell through
the root `node_modules/playwright` (a symlink into `c-compiler-copy`, 1.61.1) and
`checkPlaywrightPin` correctly refused, because `tests/browser/package.json` pins
1.61.0 for a cached Chromium. The fix is `tests/browser/node_modules` symlinked
too — **not** `CC_NO_PLAYWRIGHT_PIN=1`, which would have run an uncached
Chromium and turned an install problem into 49 spurious product FAILs.
