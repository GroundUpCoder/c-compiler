# 0209 — WAST inliner ignores callee local growth; can exceed wasm's 50k-local limit (ICE)

- **Status**: done (2026-07-16) — localCap 45000 budget (budgetLocals refusal) guards the wasm 50k-local engine limit per inlined site; default-corpus decisions byte-identical (ext_regex 90103 B/282 inlined pre==post, bench sum OK); ast tests refuse-budgetLocals + budget-locals-accumulates; full gate green; log: logs/2026-07-16/p0-bug-hunt-fixes.md
- **Design**: compiler.js inlineFunctions (todos/0201), tests/ast/test_wast_inline.js, tests/bench (checksum interlock)

## Goal

The inliner budgets only real BODY nodes; each inlined site also adds
k params + ALL the callee's declared locals to the caller, unbudgeted,
and the resulting local count is never checked. A callee with a tiny
body but thousands of declared locals (tests/unit/ext_regex has a
~12.5k-local helper) inlined at a few sites blows wasm's 50,000-local
per-function limit -> V8 CompileError "local count too large" surfacing
as an ICE. Prerequisite for any future calleeCap raising (the 0201
deferred big-callee unlock).

## Plan

New `localCap` budget (default 45000, safely under the 50k engine
limit with margin for params): refuse a site whose projected caller
local count (current locals + k + callee locals) would exceed it —
`budgetLocals` refusal bucket. Default keeps every current-corpus
decision identical (nothing today is near the cap): the tests/bench
checksum + instruction-count interlock must be byte-identical.
Regression tests in tests/ast/test_wast_inline.js (refusal + the
site-by-site accumulation shape).

## Acceptance

- New ast tests fail before, pass after.
- tests/bench proxies identical (same instrs/bytes/checksum).
- ext_regex compiles with a raised calleeCap (refusal, not ICE).
- Full estate green.
