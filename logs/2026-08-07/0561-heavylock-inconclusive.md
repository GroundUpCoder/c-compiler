# #561 — the dispatcher can now say "inconclusive": whole-gate lock reservation + a contended-row reason

Ticket #561 (off lane-477's residual): `tests/lib/heavy-lock.js:136` exits 3 on a held lock, and
`tests/run.js::classify()` mapped every nonzero exit to `fail` — so a heavy suite that NEVER RAN
was recorded in `build/test-run/summary.json` as `status: "fail"`, indistinguishable from a
genuine red. The fleet rule "exit 3 = lock held = inconclusive, never a red" contradicted the
artifact, in both directions.

## The acquire-timing race, measured (acceptance 1)

The ticket's direction (b) — a check-only pre-flight at dispatcher start — closes **neither** of
the two real windows:

- **Window 1, gate start → first heavy row: deterministic and minutes long.** `RUN_ORDER`
  (`tests/run.js:90`) puts kernel/sweep last, and the lock was only taken inside
  `tests/kernel/run.js:268` / `tests/browser/os-sweep.mjs:65` when THAT row spawned. Everything
  before it (unit/host/blockfs + the py batch) runs with the lock free. Measured on this change's
  own gate: see the pre-kernel `ms` figures in `build/test-run/summary.json` (minutes).
- **Window 2, kernel exit → sweep acquire: ~60–110 ms, EVERY gate.** The kernel runner released
  the lock at process exit and the sweep re-acquired at its own startup. Measured spawn→acquire
  latency under a staged holder: sweep 62/76/108 ms, kernel 48/51/53 ms (3 runs each). A
  `boot.js --wait-lock` contender polls at 1 s intervals (`heavy-lock.js` `sleepMs(1000)`), so it
  seizes this gap with roughly window/1000 probability per gate — small, but the 2026-08-04
  incident (a gate lost its whole kernel leg to a sibling's bake) is this class in the wild.

So per the kickoff's own framing: **the race is real, (b)-as-check is insufficient.**

## Direction chosen (acceptance 2): reservation + backstop — (b) strengthened, plus (a)

**(b′) The gate RESERVES the lock, it doesn't peek at it.** When the resolved suite set contains
a heavy suite, `main()` calls `acquireHeavyLock({name: 'tests/run.js gate'})` up front (after the
two exit-2 preflights — a misconfigured run must not take the machine-wide lock first, the
os-sweep ordering precedent). The two heavy runners switch `acquireHeavyLock` →
`joinHeavyLock`: under a gate they ride its reservation re-entrantly through the verified
`CC_HEAVY_LOCK_PID` marker (the exact contract their own child boots already use, pinned by
`test_heavylock_e2e.js` leg 3); hand-run there is no marker and they acquire and own exactly as
before. This closes BOTH windows — the lock is dispatcher-held from t0 to gate exit, including
the inter-suite gap — and makes the "a boot can wait behind a gate; a gate never waits behind a
boot" ruling structural instead of procedural. A contended gate exits 3 at second zero, naming
the holder, with nothing run and **no summary written** (an absent summary already means "did
not finish").

**(a) The classify backstop.** If a heavy ROW still exits 3 (mechanism regression, direct-runner
invocation semantics preserved), `classify(r, heavyLock)` records
`status: "fail"` + `reason: "heavy-lock-contended"` + a DID-NOT-RUN note, rendered as a red
`LOCK` tag and counted in the "N failed (M of those DID NOT RUN…)" line. The translation is
protocol-sound: in both heavy runners the ONLY `process.exit(3)` is heavy-lock.js's — the rest
of their exit space is 0/1 verdicts, 2 refusal/fatal, 4 cross-tree, 130 SIGINT, and a member
test exiting 3 is a failed member → runner exit 1.

**Constraint (#477) honored, and pinned:** the status stays literally `fail` — `main()`'s
`results.some(r => r.status === 'fail')` still exits 1, rule 5's literal-`pass` ship gate stays
red, and a guard leg asserts exactly that (sabotage B below re-introduced a `skip` and went red).

**Two ticket details overturned, code cited:**
- The ticket's (b) said "exit 2 the way #559/#483 do". Wrong code for this condition:
  `tests/run.js`'s own #559 comment (now :795-797) reserves exit 2 for knowable config faults and
  says "Deliberately NOT exit 3 (heavy-lock contention) … both codes carry trained meanings."
  A held lock is transient contention; the refusal is exit 3 with the `[heavy-lock]` marker,
  produced by the lock itself.
- Line drift for the record: `classify`'s return sat at :864-865 (ticket said :864 ✓);
  `main()`'s fail-only exit at :828-829 (ticket's :824 drifted via #477, same content).

## The third honesty fix, found during sabotage A

A contended row used to attach the suite's `artifact`/`files` block if one existed on disk —
i.e. a DID-NOT-RUN row dressed in an EARLIER run's record (my first sabotage log showed a
contended kernel row carrying a stale `filter: "__no_such_test__"` files block). Same defect
class as the ticket's. Fixed: `main()` skips artifact attachment when
`reason === 'heavy-lock-contended'`.

## Guards (acceptance 5)

- `tests/host/test_browser_preflight.js` (+3 legs): exit-3-heavy → contended with literal
  `fail`; exit-3-light and exit-1-heavy stay plain fails; registry carries `heavyLock` on
  exactly {kernel, sweep}.
- `tests/host/test_heavylock_gate.js` (NEW, registered in tests/host/run.js): private-TMPDIR
  lock scope, stand-in holder = the test's own pid. Leg 1 (RED control): held lock + `kernel`
  selected → gate exits 3, `[heavy-lock]` marker, names the holder, NO suite banner, summary
  file untouched. Leg 2: `--dry-run` never contends. Leg 3: a light-only gate runs to completion
  under a held lock (the reservation is scoped to runs that will take the lock). Leg 4: free
  lock → the gate reserves and the kernel runner JOINS it (0-file filter keeps it boot- and
  bake-free), releasing on exit. Legs 1 and 4 pin the two halves against each other — whichever
  half regresses, one of them reds within seconds, and no regressed state can start heavy work.

## Breakage-and-revert evidence (acceptance 8) — all under build/, all reverted

- **Sabotage A** (`build/sabotage-561-A.log`, `-A2.log`): kernel runner regressed join→acquire.
  Guard leg 4 RED (the runner refused against its own gate — holder named
  `tests/run.js gate`), and end-to-end through the dispatcher (private lock scope):
  **rc=1**, summary row `{status:"fail", reason:"heavy-lock-contended", exit:3}`, `LOCK` tag
  printed. This is the (a) path exercised live.
- **Sabotage B** (`build/sabotage-561-B.log`): classify translation softened to `status:'skip'`
  (the #477 hazard, deliberately re-introduced) → guard RED, rc=1.
- **Sabotage C** (`build/sabotage-561-C.log`): dispatcher reservation deleted → guard leg 1
  RED 3× , rc=1 — and the failure detail shows the backstop catching it: even regressed, the
  gate printed `LOCK … DID NOT RUN` and exited 1. **No state of this system yields exit 0 with
  a heavy suite unrun.**
- **Green control** (`build/sabotage-561-green.log`): both guard files rc=0 after revert.

## Invalidated committed assertions: none

Verified by grep before changing the runners: no committed test spawns `tests/kernel/run.js` or
`os-sweep.mjs` under a staged lock; `test_heavylock_e2e.js` drives `os/boot.js` and
`os-boots.mjs` (harness join) only, and strips the marker env per the red-control rule — all its
legs unaffected (kernel suite runs it in the gate).

## Bypass-scan carve-outs (deliberate, documented)

The diff adds `CC_HEAVY_LOCK_PID` / `CC_NO_HEAVY_LOCK` env DELETIONS in the two test files'
child-env staging — the CLAUDE.md red-control rule ("strip the marker from the child env or you
are testing nothing"), not an escape hatch; no new override is introduced and no existing one is
widened. `SUITES`-adjacent comment text mentions the existing hatch by name only.

## Docs updated in the same commit

CLAUDE.md heavy-lock section (gate owns the lock; contended-row rendering), the
GATE-GOES-FIRST bullet (structural within a run since #561), batching rule 2 (a contended gate
now fails at dispatcher start, not minutes in), plus the header comments in heavy-lock.js /
harness-leaks.js and both runners.

---

# #561 addendum (same lane, post-gate review by @master cont-517/518)

## Finding 2 (BLOCKING, confirmed): the guard test fabricated the enclosing gate's run-level record

`test_heavylock_gate.js` legs 3/4 ran a real dispatcher to completion with only TMPDIR scoped —
which scopes the LOCK, not `build/` (`tests/run.js:36` derives ROOT from `__dirname`; cwd cannot
redirect the summary). So mid-gate, during the host row, the test overwrote
`build/test-run/summary.json` with a one-row all-pass record (`suites:["kernel"],
filter:"__no_such_test__"`) under a fresh mtime — the exact "the gate completed" signal the fleet
judges by. A gate dying after the host row would leave a green-looking artifact: the #477
fake-green class through a side door, inside the ticket hardening against it, and a direct
contradiction of leg 1's own "absent/untouched summary = did not run" rationale. Reproduced and
preserved BEFORE repair: `build/repro-561b-residue.log` (green-gate record before → residue
after, mtime fresh). The green gate's own summary was snapshotted first to
`build/gate-561-summary-snapshot.json` (cp -p).

## Fix: `--out=DIR` on the dispatcher + auto-isolation inside gate()

Adopted the coordinator's lean (a) — a real out-dir override — **as a CLI flag, not an env
var**: argv is visible in the lock file's `argv` and every log, while an env var can leak
ambiently into an unrelated gate. Fail-safe by construction: an `--out` run leaves the canonical
path untouched, so a judge reading it sees a stale mtime — "did not finish", never a green.
`--out` redirects only the DISPATCHER's record; per-suite artifacts stay put (stated in the
flag's comment and help text).

In the guard test, `gate()` now (1) ALWAYS appends `--out=<private dir>` — a future leg cannot
forget the isolation; (2) asserts the canonical record byte-and-mtime untouched after EVERY
child — a regression of `--out` itself fails loudly (this also un-order-depends leg 1's
untouched assert); (3) snapshots the three per-suite artifacts and restores bytes+mtime
(`utimesSync`) if a child moved one — leg 4's kernel child merges a 0-file run record into
`build/test-kernel/summary.json`; the restore is asserted, and the crash-window residue
(child wrote, test died pre-restore) is fail-safe: a filtered suite artifact fails rule 5's
`filter: null` requirement, and the canonical run-level record was never touched at all.
Coverage went UP, not sideways: leg 4 now also asserts the child's record at its `--out` path
(suites `["kernel"]`, one pass row, the filter recorded).

Breakage-and-revert: `build/sabotage-561b-noout.log` — stripped the `--out` injection from
`gate()` → 3 assertions RED (`canonical … untouched` on both writing legs + the child-summary
leg), guard rc=1 (redirect capture, no pipe), reverted, green control rc=0 with canonical
records SHA-256-identical across the run.

## Finding 1 (record honesty): the Sabotage-A rc figures — annotation, originals untouched

`build/sabotage-561-A.log` literally reads `guard rc=0` and `dispatcher rc=0` while the dev log
reported rc=1. **Cause: both figures were read through a pipe** (`… | tail -N; echo rc=$?` — rc
is tail's, the exact trap the kickoff names). The verdict evidence inside A.log is the FAIL leg
line, the `LOCK` row, and the `heavylock gate: 1 FAILED` line — not the rc echoes.
**Audit of every other rc figure in the evidence:** sabotage-561-B.log, -C.log and
-green.log all captured rc via `> file 2>&1; echo rc=$?` (no pipe) — sound. `gate-561.log`'s
`GATE-EXIT rc=$?` is echoed inside the subshell before the pipe — sound by construction.
The only pipe-shaped figures are A.log's two. `-A2.log` re-captured the dispatcher rc correctly
(rc=1) but carried the stale-artifact fix in the same run — two changes at once; the rc
conclusion does not rest on it: `tests/run.js` (`anyFail = results.some(r => r.status ===
'fail')`) cannot exit 0 on a contended row, whose status is literally `fail`, and the
stale-artifact fix touches only artifact attachment, never status or exit. A.log itself is
byte-untouched; this section is the annotation.
