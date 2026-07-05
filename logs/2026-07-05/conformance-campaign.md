# Conformance campaign: full bug-hunt + fix of compiler.js and host.js

2026-07-05T08:58:00+09:00

## Why

A structured review of the two core files (compiler.js 27k lines, host.js 8k)
to find real bugs, not style issues. Method: parallel section-by-section review
with the rule that **every finding must be verified by a runnable repro**
(compile → run → diff against native clang for defined-C behavior, ILP32-aware
to avoid data-model false positives), plus a pure differential-testing sweep
and extended BlockFS fuzzing. ~55 confirmed bugs. Then fixed test-first: commit
the failing corpus, then fix down the list.

## Decisions worth remembering

- **Test-first corpus as a permanent fixture.** `tests/unit/conformance/` —
  one dir per bug, clang-verified `expected.stdout`, `// BUG: / C11: / EXPECT:`
  headers. `diag_*` dirs assert required diagnostics via
  `expected.compiler.exitcode` only (error text is the fix's choice).
- **One constant-conversion routine.** Three evaluators (PP, sema
  constEvalItem, codegen constEvalExpr) had drifted; the largest bug family
  (~14 miscompiles) was width/domain confusion (JS 32-bit shifts, BigInt
  integer division on float-typed items, unrounded (float) casts, _Bool
  truncate-before-test). Now `ConstEval.convert` implements C11 6.3.1 once;
  FloatItem carries f32 rounding at every step. **New folding code must route
  through it.**
- **Float→int constant folding declines out-of-range** instead of saturating:
  folding would erase `--trapping-float-conversions` runtime semantics. Static
  initializers (no runtime to defer to) opt into saturation explicitly
  (`saturatingTruncToInt`), matching wasm `trunc_sat`.
- **Enum constants follow the gcc extension** (values in `(INT_MAX, UINT_MAX]`
  get type `unsigned int`; outside 32 bits is an error). Strict C11 wants a
  diagnostic at INT_MAX, but the repo's own `unsigned_consteval` golden
  documents the extension — the real bug was the silent wrap to negative.
- **Tag definitions create distinct types per scope** (C11 6.7.2.3p5); the
  TU-global name cache is for *references* only. This immediately exposed a
  real header bug (sys/stat.h redefining struct timespec inside struct stat).
- **Dead-branch folding must keep jump targets.** `caseBag`'s switch barrier
  is exactly "externally-owned cases"; goto labels need a full scan. The old
  behavior produced an infinite dispatch-loop hang — the worst failure mode.
- **setjmp lowering: retry scaffold via plain gotos, not a synthesized loop**
  (a loop would capture enclosing break/continue). Statements after the
  setjmp-if re-enter after each longjmp via jumped/caught flags + backward
  goto; the simple try/catch shape is kept when nothing follows.
- **BlockFS open-refcounts are in-memory / per-instance.** POSIX
  unlink-while-open now works within one instance; cross-instance
  unlink-while-open is a documented limitation (no cross-instance fd state
  exists). On-disk format unchanged — fsck untouched.
- **Runner hangs are now impossible:** tests/run-unit.js has a per-test
  timeout (30s default, `--timeout=MS`, per-test `timeoutMs` in config.json)
  with worker replacement. This is what makes it safe to keep the
  goto-into-dead-loop test (previously an infinite hang) in the corpus.

## Gotchas hit

- Git normalized the CRLF test file's line endings at commit — the test would
  have become vacuous on fresh checkout. `.gitattributes` `-text` pins it.
- The `unsigned_consteval` golden and the strict-C11 enum diagnostic were in
  direct conflict; resolved by matching gcc/clang practice (above).
- **"Slow build" that wasn't:** micropython runtime checks hung for the full
  10-minute timeout while the compile itself takes ~6s. The vendored minimal
  port's `mp_hal_stdin_rx_chr` ignored `read()==0`, so piped stdin EOF spun
  the REPL at 100% CPU. Fixed (EOF → Ctrl-D → pyexec exit, ~50ms sessions).
  Lesson: verify a guest terminates on stdin EOF before piping into
  EOF-waiting consumers (`grep`/`wc`); `| head -N` masks the hang.
- Subagent worktrees that end their turn waiting on background jobs never
  report; their work had to be extracted as patches (`git diff <base> -- file`)
  and re-verified on the merged tree.

## Tests / verification

Suite: 634→694 passed, 0 failed (58 unit conformance tests + 9 BlockFS POSIX
cases all green). BlockFS: full suite + `test_fuzz.js --long` 40/40 on the
merged tree; an extended 60-seed × 3000-op × dual-instance campaign also
passed *before* the fixes — every real BlockFS bug was in ops outside the
fuzzer's model (unlink-while-open, rename-over-open, holes, dup, huge sizes),
so the model, not the seed count, is where fuzz investment should go.
Vendors: lua (pcall/error = setjmp), sqlite, doom, micropython (nlr, 8/8 test
type), hello. All on main, pushed (bfea279..d87a468).

## Open questions / next

See `todos/CONFORMANCE-REMAINING.md` for the verified-but-unfixed remainder
(browser-path bugs, stdout drain-on-exit, console ring backpressure, volatile
inlining, residual-longjmp diagnostic, missing libm entry points) and the
architecture recommendations that came out of the review.
