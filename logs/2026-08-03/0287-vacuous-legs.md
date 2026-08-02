# #97 (0287) — de-vacuating three browser test legs + the browser wmctl-timeout guard

Branch `0287-vacuous-legs` @ `9d121f80` (off v223 main `45add16f`). All three
defects re-derived at tip (the ticket's line numbers were pinned at `847dc057`
and had drifted): the muted-MessageBox leg sat at `os-sounds.mjs:112`, the
boot-race legs at `os-boots.mjs:108-120` / `os-vt.mjs:35-39`, and
`grep "timed out" tests/browser/lib/` was still empty — `os-term.mjs` and
`os-minimal.mjs` each carried comments/hand-rolled scans working around the
missing guard, which is its own confirmation the gap was real.

## What changed

**(a) os-sounds muted MessageBox.** `w3 === w2` was satisfied equally by
"muting works" and "the About dialog never opened" — the only thing between
the click and the sample was `sleep(2500)`. Now the leg types
`wmctl click About && wmctl wait win "About ctldemo" && echo ABT""2-UP` and
waits the split-needle marker, so the sample happens only with the dialog
*verifiably open*. Every blind sleep in the file was replaced by a real
condition: `waitWpos` (producer-cursor advance — the positive audio legs),
`waitQuiet` (two equal cursor samples 500ms apart — the negative-leg
baseline, so a draining clip can't alias as an event beep), dialog
existence/absence waits, the `waitFileHas` store-poll idiom from
test_ctlpanel_e2e, and split-needle echoes. Two annotated no-marker settles
remain by design (quiescence sampling; the silence window — silence has no
completion event). Side effect: the file runs ~12s instead of ~25s.

**(b) boot-race legs.** Both self-documented their vacuity.
- `os-vt`: the one-shot `state !== 'booting' || vt === 1` probe is
  unconditionally true whenever ready wins. Replaced with an
  `addInitScript` that intercepts the `__osState`/`__osVt` probe properties
  before any page script runs and records every transition; the check
  replays the trace and requires 'booting' to have been OBSERVED and vt===1
  at every instant of it. Deterministic — the trace covers the whole boot
  window, no race, and a trace without 'booting' is a loud FAIL (probe
  contract broken), never an abstention.
- `os-boots`: the manual-VT-grab now fires `__osVtSwitch(1)` synchronously
  *inside* the `'booting'` assignment (os.html defines `__osVtSwitch`
  before it sets 'booting'; sessionStorage-gated so the first boot keeps
  its auto-switch leg) and records `__vtGrabAt`. The check requires
  `at === 'booting' && vt === 1` — a post-ready switch, the exact old
  vacuous degradation, now REDs even though it still ends at vt 1.

**(c) browser wmctl-timeout guard.** Ported drive.js's todos/0171 gate:
pure `wmctlTimeoutHits` scanner + `WMCTL_TIMEOUT_RE` in os-harness.mjs,
`osHelpers.waitOut` now short-circuits when a
`wmctl: wait X timed out after Nms` line hits the tty mirror and throws
naming every hit + the tty tail (instead of an opaque waitForFunction
timeout later), and `assertNoWmctlTimeout` is exported for end-of-session
scans. Every waitOut call re-scans the whole accumulated `__osOut`, so a
timeout anywhere earlier surfaces at the next sync point.

Also: unit coverage for the scanner in `test-harness.js`, and fixed that
file's stale `osUrl` expectation — it was RED on main (`osUrl` grew the
`hostkeys=off` default and the file runs in **no suite**, so nobody saw it).
Retired LIABILITIES.md L03–L06 (the entries funding exactly these gaps).

## Red-then-green (each leg demonstrated fallible)

- **os-vt**: temp-edited the interceptor to drop 'booting' records (the
  ready-won simulation) → `FAIL boot streams on VT1 … [["__osVt",1],
  ["__osState","ready"],["__osVt",2]]`. Restored → 23/23 ok.
- **os-boots**: temp-edited the grab condition `'booting'`→`'ready'` (the
  old degradation) → `FAIL manual VT choice during boot survives ready
  {"at":"ready","vt":1}` — note vt:1: the OLD check would have passed this.
  Restored → 14/14 ok.
- **os-sounds + guard**: temp-edited the muted leg to
  `wmctl click Aboutx ; wmctl wait win "About ctldemo" 4000 && …` (dialog
  never opens, the wait times out) → exit 1, `FATAL Error: wmctl wait timed
  out … wmctl: wait win timed out after 4000ms` — one run demonstrating
  both (a) (the leg cannot pass with no dialog) and (c) (an induced
  timeout becomes a named hard failure). Restored → 8/8 ok, ALL OK.

## Gate (at 9d121f80)

- `node tests/run.js --diff origin/main --dry-run` → todos + sweep.
- todos: 1/1 pass (7.1s).
- sweep: 49 passed / 0 failed across 9 filtered runs;
  `files: {total: 49, selected: 7, executed: 7, resumed: 0, carried: 42,
  recorded: 49}` — recorded == total, zero resumed (the 42 carried are this
  session's own earlier same-tip slices merging, the 0339 mechanism).
- harness unit (`node tests/browser/lib/test-harness.js`, runs in no suite):
  20/20 ok, PASS.
