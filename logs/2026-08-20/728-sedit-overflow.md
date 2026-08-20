# #728 — sedit style-batch heap overflow: size per line run, bound the append

Branch `lane/728-sedit-overflow`, base `36e6a26f`.

## The defect

`publish_styles` sized the batch per TOKEN (`cap = token_count + pair_count +
16`) while `append_style` wrote one entry per LINE within each token, unbounded,
`return 1` unconditionally. One token spanning N lines consumed N slots budgeted
as 1 — an unterminated `/*` collapses the file tail into one token, so ordinary
typing overflowed the heap on every keystroke, and 322 tracked `.c`/`.h` files
overflowed on open. In wasm there is no guard page: silent dlmalloc corruption,
surfacing later as an unattributable wild free.

## Shape of the fix

1. **Extraction for testability** (`e52600db`): the batch construction moved
   verbatim (bug included) from `sedit.c` statics into a pure unit
   `os/sedit/styles.c` (`sedit_styles_build`), the `gucedit_core.c` precedent —
   natively compilable with `-DGUCEDIT_STANDALONE`, so the REAL code runs under
   ASan in `test_sedit_core.js`. `sedit.c` keeps only win32 glue (EM_GETSEL,
   GEM_SETSTYLES, status line).
2. **The fix** (`53585a33`): the bound is now counted in the unit it is written
   in — a sizing pass sums `line_runs()` per token (+2 caret boxes), clamped to
   `GUCEDIT_MAX_STYLES` (the consumer refuses larger batches; count stays legal
   because runs are disjoint and ≥1 byte, so count ≤ text_len). `append_style`
   takes the cap; its `int` return is now meaningful — 0 at the bound instead
   of writing past it (honest shape, PRINCIPLES.md). `publish_styles` shows
   "Highlighting truncated: style limit reached" when styles were dropped;
   truncation is impossible below the ABI cap because the sizing is exact.
   Also bounded the caret-mate peek: `text[caret-1]` had no upper bound and no
   NULL-text guard (same unbounded-access class, same function; 1-byte OOB
   read reachable via publish-after-stale-selection).

## RED (banked before the fix)

At `e52600db`, `node tests/kernel/test_sedit_core.js` → exit 1:
`AddressSanitizer: heap-buffer-overflow ... WRITE of size 20` in
`append_style ← sedit_styles_build`, buffer `allocated by ... sedit_styles_build`
(the per-token malloc). The sqlite3.h case REDs independently (case 1
temporarily `#if 0`'d, uncommitted): same overflow signature reached via the
repo header. All 30 pre-existing probe legs pass under ASan before the crash.

## Tests + oracles (mutation-proven, per the #729 precedent)

New probe legs use TWO independent oracles: `gucedit_check_batch` — the
CONSUMER's own validator (LF-crossing, overlap, sort, size/count coherence) —
and an exact `count == Σ line_runs(token)` reference computed by a separate
loop in the test. Cases: unterminated `/*` over 500 lines; `vendor/sqlite/
sqlite3.h` (passed in by the driver); caret delimiter-mate boxes; an
over-`GUCEDIT_MAX_STYLES` buffer asserting `truncated==1 && count==MAX`.
The driver also stops masking signal-killed probes (`r.status||0` read a
SIGABRT as pass — the null-status trap).

Mutation ledger (each applied to the fixed `styles.c`, run, restored):

| # | Mutation | Kill |
|---|---|---|
| M1 | sizing reverted to per-token (bound check kept) | assertion RED: both "one entry per line run" legs + truncation leg — the count oracle catches sizing drift WITHOUT ASan |
| M2 | bound check disabled (`if(0&&*count==cap)`) | ASan heap-buffer-overflow + SIGABRT on the over-limit leg — the cap check is what stands between sizing drift and corruption |
| M3 | truncation report forced 0 | RED "over-limit batch truncates honestly" |
| M4 | caret-box block disabled (`if(0&&...)`) | RED caret leg |
| M5 | per-line splitting removed (`q=e`) | RED both validator legs (LF-crossing → INVALID) + truncation leg |
| M6 | overlap dedup pass deleted | RED caret leg (validator overlap check) |

Disclosure: the FIRST attempt at M1/M2/M3 "reddened" via `-Werror` compile
failures (unused symbol after mutation), which is not a kill; caught by
inspecting the logs, redone compile-clean above. A mutation that reddens for
the wrong reason is as vacuous as one that stays green.

## Recorded coverage gap

The `else if(truncated) status_text(...)` glue line in `sedit.c` is not
executable by the native probe (win32 shell) and an in-OS e2e would need a
>1M-line-run file — disproportionate. The mechanism (`*truncated` honesty) is
mutation-pinned (M3); the one status-line call is thin glue of the same shape
as the two adjacent, long-standing status calls.

## Scope check

Audited for the same per-token-vs-per-line assumption: `sedit.c:35` was the
ONLY producer-side batch allocation; `document.c`/`c_lex.c` allocations are
exact-sized or realloc-grown; the gucedit win32 path (`user32.c`,
`gucedit_core.c`) is consumer-side and validates. #729 (vacuous tests — incl.
legs in files touched here) and #730 (Ctrl+G) deliberately left alone; the
driver's signal-masking fix was necessary for THIS test's RED to be visible,
not a #729 fix (those legs remain as they were).

## Gate status at handoff

`node tests/run.js --diff origin/main --dry-run` → kernel + sweep (both
heavy). Not run: heavy lock held by the coordinator's #723 gate. Run free:
`test_sedit_core.js` GREEN (117 ok, exit 0, ~1.1s with ASan),
`test_gucedit.js` GREEN (includes compiling `os/sedit/bin.json` to wasm),
direct `node compiler.js os/sedit/bin.json` GREEN. Image bumped to v275
(sedit is baked).
