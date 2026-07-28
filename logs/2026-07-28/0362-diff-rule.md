# 0362 — the compiler.js diff rule now selects the run.py corpus

`tests/run.js`'s `^compiler\.js$` rule selected `['unit','kernel','blockfs',
'host']` under a rationale claiming "every wasm binary". No run.py category but
`unit` was in the list, so a codegen change was ungated against the whole
real-world-C corpus — todos/0356 (caught ONLY by `micropython-upstream`, with
`unit` green) is the proven firing example. The 0318 lesson in a new costume:
prose that overstates its list is worse than a missing rule, because it reads
as a considered scope decision.

## What changed

- `^compiler\.js$` → `['unit','kernel','blockfs','host','sweep',
  ...PY_CATEGORIES]`. Every category was verified compiler-dependent before
  folding it in (the suspects: `disw`'s tests run a clang-built native binary,
  but `tests/disw/compiler/build.py` feeds it compiler.js output; `ast` is
  JS-level but two files execute compiled wasm; `sourcemap` compiles with
  `-g`). `sweep` joins on the bake-input axis: compiler.js recompiles every
  seeded binary, and the headless suites have no compositor, so a rendering
  break in the re-baked blob is browser-only — the same axis-1 argument the
  vendor block already records.
- Sibling audit (the ticket's scope 3): `^host\.js$` had the identical gap —
  "the process runtime lives here" but no run.py category and not even `unit`,
  despite `run.py`'s `HOST_JS` (16 call sites) and `run-unit.js`'s
  `runModule` executing every compiled test under it. Now
  `['unit','blockfs','kernel','sweep','host', ...PY_CATEGORIES minus
  disw/sourcemap]` — those two are the only categories that never execute
  wasm (native disassembler / own `verify.js`), and the exclusion is stated
  in the rationale string and pinned by the guard.
- `^tests/run\.js$` was `[]` ("no suite of its own") — now `['host']`: the
  new guard means an edit to the RULES table itself finally selects the suite
  that checks the table.
- `tests/run.js` exports `{SUITES, PY_CATEGORIES, RULES, IGNORE, FORCE,
  planFromDiff}` when required as a module (`require.main` guard), so the
  closure is testable without fabricating a git diff.
- `tests/host/test_diff_rules.js` (19 checks): compiler.js selects every
  py category + micropython-upstream specifically (the 0356 guard), host.js's
  inclusions AND its two exclusions, and the dispatcher-gates-itself rule. A
  vacuousness check pins `PY_CATEGORIES.length >= 18` so a refactor can't
  hollow the assertions out.
- Register: L50 (funded by this ticket, anchored on the deleted
  `NOT SELECTED YET` comment) retired in the same commit.

## Cost of the new closure

Measured on this machine, 2026-07-28 (the ticket's numbers re-measured, not
carried): see the commit message for the two-half `run.py` wall-clock split.
The fold prices at roughly the kernel suite the rule already pulled; the
sweep addition is the expensive part, and it is priced deliberately — a
compiler change really does change every binary the sweep boots.

## Residual

None filed: nothing was cut. The other whole-estate rules (`kernel.js`,
`tests/lib/`) were audited and are honest — no run.py category loads either
(run.py runs `node host.js <wasm>` standalone, no kernel, no suite-runner).
