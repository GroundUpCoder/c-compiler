# #513 — inline kernel-suite spawn kills self-describe (the #110 class)

Sibling of #110 (test_os_boot.js, merged 560cdd06) and #512 (driveBoot,
filed). This ticket covers the kernel-suite call sites that spawn children
DIRECTLY: a kill by the harness budget or by an external signal must read as
a harness/environment event, never as a product-shaped failure
(`status=null` in a check line) and never as an unattributed ETIMEDOUT
stack. The kill stays RED on purpose — the fix is the MESSAGE, not the
colour.

## The design decision: HOIST — tests/lib/spawn-budget.js

The ticket left "consider hoisting the wrapper into tests/lib/" open. Hoisted,
for four reasons:

1. **The sweep found the class is ~3× larger than the ticket's four files.**
   Beyond cmdalt/cc_srclib/curl/gcode_native, the same shape exists in
   `tests/kernel/lib/gucman.js` (2 sites), `test_seed_e2e.js` (2),
   `test_gucman_e2e.js` (1), `test_git_e2e.js` (3), `test_rust_e2e.js` (~10),
   `test_rust_std_e2e.js` (~8), and `test_curl_e2e.js`'s bootAsync
   (a raw `cp.spawn` + manual kill timer). Copy-pasting #110's wrapper into
   each file would mint a dozen drifting implementations; the repo's standing
   principle is build the general case.
2. **#512 (driveBoot) wants exactly this classify core** — one implementation,
   three consumers (inline sites, driveBoot, test_os_boot.js).
3. **The blast-radius risk of refactoring the just-merged test_os_boot.js is
   already fenced**: `test_os_boot_kill_honesty.js` (merged with #110) pins
   the exact banner text and the CC_OS_BOOT_TIMEOUT_MS seam end-to-end, so the
   refactor is guarded by a control that predates it. The shared messages
   keep the three phrases that control greps
   (`TIMED OUT: killed by the harness at its <N>ms budget`, the env name,
   `killed by <SIG> from outside the harness`).
4. **The async site does not port the sync recipe — so it gets its own entry
   point** (`execFileBudgeted`) rather than a shoehorn. Probed on this Node
   line (v25.8.2), the async flavours ARE separable (see below).

The helper returns `{ r, wall, budget, kill }` and the CALLER owns kill
policy: test_os_boot.js aborts the whole file (a killed bake poisons every
later leg); the inline sites fail their one check with the kill message and
skip that leg's judge. Non-kill spawn errors (ENOENT) still throw, and a
NONZERO EXIT is never classified as a kill — a product failure must stay one
(the async path rethrows it with its stack).

## Probed mechanism (async execFile — new; sync re-confirmed)

#110 probed only spawnSync. The promisified-execFile flavours, probed live:

- budget kill: rejection `{ killed: true, signal: <killSignal>, code: null }`
  — NO 'ETIMEDOUT' (that is a sync-only artifact).
- external kill: rejection `{ killed: false, signal: 'SIGKILL', code: null }`.
- nonzero exit: rejection `{ killed: false, signal: null, code: 3 }`.

So async classification keys on `e.signal && e.code == null`, then `e.killed`
splits budget vs external (`killed` is set only when the lib delivered the
kill; a maxBuffer abort carries a string code, so `code == null` excludes it).

**mkpkg.js traps SIGTERM** (`tools/mkpkg.js:234` — its lock-release handler),
verified at this tip: the cmdalt site's default-SIGTERM budget kill had
exactly #110's absorption hazard (signal deferred past a synchronous tar/gzip
stretch, spawnSync never escalates). `killSignal: 'SIGKILL'` in the helper is
therefore load-bearing there, not precautionary; mkpkg's `.mkpkg-lock`
self-heals via its dead-pid `holderAlive` steal, so a SIGKILLed mkpkg strands
nothing. compiler.js and smoke.mjs install no signal handlers (checked).

## The red control — test_spawn_budget_kill_honesty.js

End-to-end target: `test_gcode_native.js`, the one inline site whose budgeted
spawn is the file's FIRST action (a forced kill costs seconds, not a boot).
Leg 1 forces the budget kill through the new CC_SPAWN_BUDGET_MS seam
(1000ms, lands mid-clang-build); leg 2 SIGKILLs the target's smoke.mjs child
out-of-band; leg 3 drives the helper directly (real timer kill, real
out-of-band kill of the async child via the onSpawn hook, and the
passthrough contract: clean exit, nonzero exit, ENOENT). Control mechanics
are the #110 pattern: detached target, group-SIGKILL caps, clang gate.

Red on the unfixed tree (commit 9411952e, fix absent), 6 FAILED:

```
FAIL budget kill exits 1 (red, not a crash)  code=0 signal=null      # seam absent: ran ALL 111 checks
FAIL budget kill prints the TIMED OUT banner
FAIL the banner names the override seam
FAIL external kill prints the external-signal banner
     ["  FAIL oracle exits 0 (got null, signal SIGKILL)", ...]       # the historical shape, verbatim
FAIL external-kill leg: no product-shaped kill line  "oracle exits 0 (got null"
FAIL tests/lib/spawn-budget.js exists (the shared #513 implementation)
```

Leg 2's red is the positive control for the PRODUCT_SHAPE instrument: the
regex matched the live pre-fix line. Green on the fixed tree: 17/17, exit 0.

## Does a passing run change? No.

Same budgets everywhere (180s/120s/60s/480s/300s), same spawn options; the
helper only branches on error/status shapes that were never a pass, and
killSignal matters only once a kill happens. One behavioural delta beyond
messages: cc_srclib's follow-up assertion and curl's differential no longer
run on a killed child (they'd have judged garbage), and gcode_native exits
after the kill line instead of cascading three secondary FAILs.

## Siblings — filed, not folded

The non-named sites found by the sweep (listed in reason 1) are filed as a
follow-up ticket rather than folded into this light lane: the rust files
alone are ~18 adoption sites, and `test_curl_e2e.js`'s bootAsync is a raw
`cp.spawn` shape that wants a third entry point, not a mechanical adoption.
`test_stdinc_e2e.js:134` is driveBoot territory — that one belongs to #512,
not to the inline list.
