# #110 — harness-kill honesty in test_os_boot.js (todos-0304)

A boot/bake spawn killed by the harness budget or by an external signal must
say so unmistakably, instead of surfacing as a product failure. The candidate
handed to this lane ("branch on spawnSync's ETIMEDOUT and report it") was
right about Node's signalling but wrong about which path produced the
observed failure — the verification changed the plan, so the mechanism is
recorded here in full. All probes ran live on this box (Node v25.8.2).

## The five answers

### 1. Is the fixed 300s timeout real, and what produced the bare `null`?

Yes — three sites at the `origin/main` tip (`7ddd1712`), all
`timeout: 300000`: `tests/kernel/test_os_boot.js:49` (`session`), `:491`
(the mkimage spawn), `:556` (`session2`). The reporting path that prints the
bare `null` is the check extra, e.g. line 598:

```js
check('post-bypass boot exits clean', r.status === 0,
  String(r.status) + ' ' + (r.stderr || '').slice(-300));
```

`String(null)` → `"null"`. BUT: `session`/`session2` both guard with
`if (r.error) throw r.error;` (present since the file's creation 2026-07-06;
session2 since 0082, 2026-07-10 — both predate the 2026-07-27 sighting), and
a spawnSync-TIMER kill sets `error` (see 2). So the historical
`FAIL post-bypass boot exits clean  null` **cannot have been the 300s timer**
— on that path the file throws before any check runs. The bare-null print
requires a kill with `status:null` and NO `error`, i.e. an EXTERNAL signal
(memory-pressure SIGKILL / a stray or group SIGTERM) — exactly what a
contended box produces. The ticket's mechanism claim is refuted; its symptom
and its intent stand. The fix covers both paths.

### 2. Does spawnSync distinguish the kill flavours? (probed, not assumed)

Probed on this build:

- Own timer (`timeout: 400` vs a 10s child):
  `{status:null, signal:'SIGTERM', error.code:'ETIMEDOUT'}`.
- External SIGTERM (sibling shell kills the child):
  `{status:null, signal:'SIGTERM', error:null}`.
- External SIGKILL: `{status:null, signal:'SIGKILL', error:null}`.

So yes — `error.code === 'ETIMEDOUT'` is exclusively the harness budget, and
`status === null` without `error` is exclusively an external kill.

Two deeper probed facts that changed the implementation:

- **SIGTERM absorption.** `tests/lib/harness-temp.js:69` and
  `tests/lib/heavy-lock.js:158` install `process.once/on('SIGTERM')`
  cleanup traps. A trapped signal delivered while the target's main thread is
  blocked in its own spawnSync (or a long synchronous stretch — the bake) is
  deferred to an event-loop turn a synchronous file never takes. Probed: a
  trapping child under `timeout:1000` survived to its inner spawn's full 6s
  and **exited 0**, while the caller was still handed `error:ETIMEDOUT` (with
  `status:0`!). spawnSync sends killSignal ONCE and never escalates, so the
  caller just blocks past its own timeout. Live consequence: a SIGTERMed
  mid-bake boot.js survived 118s+. Hence `killSignal:'SIGKILL'` in both the
  fix and the control (the stale heavy-lock file a SIGKILLed boot leaves
  self-heals via the dead-pid steal).
- The suite-runner is already immune (killGroup escalates SIGTERM → grace →
  SIGKILL, whole process group).

### 3. Other call sites with the same shape → filed, not folded

- **#512** (medium, P1): `driveBoot` — `tests/kernel/lib/drive.js:83` has the
  identical `throw r.error` (unattributed ETIMEDOUT), lets external-kill
  `status:null` flow to ~40 callers' arbitrary asserts, AND its
  default-SIGTERM budget kill has the absorption exposure above.
- **#513** (light, P1): the inline non-driveBoot sites —
  `test_cmdalt_e2e.js:74`, `test_cc_srclib.js:320/324/336`,
  `test_curl_e2e.js:206`, `test_gcode_native.js:38`.

Priorities mirror #110's own user-set P1 (the tracker default for bugs is P0,
but jku explicitly set this exact class to P1 on #110 — not silently
escalated).

### 4. Budget policy: kept 300s fixed + env-overridable + honest message

- **Raised only**: rejected alone — moves the cliff, still misreports on the
  day it is crossed. (The message fix is the load-bearing part; the ticket
  says the same.)
- **Adaptive** (scale by load): rejected — unpredictable budgets hide real
  hang-class product bugs, and a hung boot vs a contended box are
  INDISTINGUISHABLE at the kill. The honest message states exactly that
  instead of guessing.
- **Removed** (wall-clock report only): rejected — the next deadline up is
  the suite-runner's 900s per-file group-kill, which truncates the file's log
  mid-line with strictly worse attribution.
- **Chosen**: default stays 300s (unchanged pass behaviour); a kill prints
  budget + wall time + signal + the contention caveat; `CC_OS_BOOT_TIMEOUT_MS`
  overrides (contention relief on a deliberately busy box, and the red
  control's lever). The kill is red on purpose — a real hang must stay red;
  what this ticket fixes is the message, not the colour.
- The ticket's 0303 cross-check: boot.js joining the heavy lock (todos/0342)
  NARROWS the exposure (no second heavy suite can stack) but does not remove
  it — light suites, editor lanes and non-repo processes still contend CPU
  and memory, and the observed killer (external signal) is exactly the
  memory-pressure shape the lock cannot prevent.

### 5. Red control without waiting 300s

`tests/kernel/test_os_boot_kill_honesty.js` (registered, kernel membership
160 → 161), committed BEFORE the fix (`e378a89f`; by construction
`git diff 7ddd1712 e378a89f -- tests/kernel/test_os_boot.js` is empty):

- Leg 1 spawns test_os_boot.js with `CC_OS_BOOT_TIMEOUT_MS=1500` against the
  full-bake first session and requires the `TIMED OUT: killed by the harness
  at its 1500ms budget` banner.
- Leg 2 spawns it at the default budget, waits for the `os/boot.js` child
  (pgrep -P, 200ms poll), SIGKILLs it out-of-band, and requires the
  `killed by SIGKILL from outside the harness` banner.
- Both require exit 1 and the ABSENCE of the two pre-fix shapes (the bare
  `  FAIL <leg>  null` line, the `spawnSync node ETIMEDOUT` stack). The
  target runs detached and every control cap group-kills with SIGKILL —
  leg 1's first version killed only the target pid and its orphaned bake then
  HELD THE HEAVY LOCK and poisoned leg 2 into a spurious refusal (control
  runs propagate a target `[heavy-lock]` refusal as exit 3, the driveBoot
  convention).

Red evidence on the unfixed tree (`e378a89f` checkout, fix absent), exit 1:

```
FAIL budget seam exists (CC_OS_BOOT_TIMEOUT_MS honoured)  test_os_boot.js ignored the 1500ms budget and ran to the control's own 120s cap
FAIL an externally-killed boot aborts the file promptly  test_os_boot.js was still running 90s after its boot child was SIGKILLed (pre-fix: a bare-null FAIL, then the remaining legs cascade)
```

An earlier unfixed-tree run also captured the historical shape verbatim —
`FAIL exit N propagates through hush  null [boot] baking system image
(manifest v237)` followed by a 24-check cascade — the exact misdirection the
ticket describes, reproduced live. Green on the fixed tree: 8/8, exit 0.

**Does a passing boot change at all? No.** Same 300s default, same spawn
options; `runBudgeted` only branches on `r.error`/`status:null` shapes that
were never a pass, and `killSignal` only matters once the timer fires.
