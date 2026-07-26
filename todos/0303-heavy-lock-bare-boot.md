# 0303 — heavy-lock guards only RUNNERS: a bare `os/boot.js` takes no lock and stacks on a lock-holder

- **Status**: open
- **Priority**: P1
- **Difficulty**: light
- **Provenance**: observed LIVE by the cont-77 coordinator on 2026-07-27 while two gucOS lanes
  were gating concurrently. This is not a code-reading inference — it was caught in the act, with
  the machine at **105 MB unused RAM**.

## The observation (reproduced from the live process table, not inferred)

`tests/lib/heavy-lock.js` was correct and working: the host lock was genuinely held —

```
/var/folders/.../T/cc-heavy-tests.lock
{"pid":38714,"name":"browser os sweep","argv":[".../reg-reload-merge/tests/browser/os-sweep.mjs"]}
```

…while a **second lane simultaneously ran a full-OS boot that had taken no lock at all**:

```
node /Users/jku/worktree/c-compiler/minimal-install-gate/os/boot.js --image=/var/.../os2.img …
   RSS 1,753,008 KB   (~1.75 GB)
plus chrome-headless-shell at 2,030,912 KB (~2.03 GB)
PhysMem: 15G used, 105M unused, 3248M compressor
```

Only two entry points acquire the lock — `tests/kernel/run.js` and `tests/browser/os-sweep.mjs`.
**A bare `node os/boot.js` invocation acquires nothing.**

## Why this is the interesting shape, not just a missing call

`heavy-lock.js`'s own header comment identifies the exact process this misses:

> *"the kernel suite fans out several concurrent full-OS boots (**each an `os/boot.js` node at
> ~2-3 GB**)"* … *"What nothing bounded until now was TWO heavy runners at once … Their process
> trees stack and exhaust RAM."*

So the file **names `os/boot.js` as the unit of memory cost**, then scopes its mutual exclusion to
**runners**. Every bound it describes (`memoryCappedJobs`, the serial sweep, 0045's
one-kernel-per-origin lock) is *intra-runner*. A boot launched **outside** any runner — by a lane
reproducing a failure by hand, by a debug one-liner, by a coordinator spot-check — is
unguarded, and it is the single largest RAM consumer on the box.

This is the **(C) archetype in its most dangerous form**: the comment is **TRUE**, it is
**detailed**, it cites the real crash, and it is *precisely* the reason nobody re-examined the
lock's coverage. The documentation of the 2026-07-25 jetsam death spiral is what made the
remaining hole look impossible.

The line *"Light suites (unit/host/blockfs/ext/bench) never take it"* is also true and also
fine — but the coordinator handoff has been carrying **"Light suites do NOT take the lock — that
is a GAP, not permission"** as prose for several rounds. **That is a gap that never entered
`todos/`** — exactly the class `0286` was just merged to kill. Filing it is the point.

## Plan

- Take the lock **where the memory is actually spent**: in `os/boot.js` itself (or a thin shared
  entry helper), so *any* boot participates regardless of who launched it. Prefer this over adding
  the call to each caller — enumerating callers is the assumption that rots (**lesson F: defuse an
  assumption in code, do not annotate it**).
- Runner-launched boots must **not** deadlock against the lock their own runner already holds:
  re-entrancy (inherited via env var / holder-pid match) is the crux of this ticket, not an
  afterthought. A naive lock in `boot.js` would deadlock the kernel suite instantly.
- Decide the policy for a bare boot: **block-and-wait** is likely right for an interactive
  reproduce (fail-fast exit 3 is right for a *runner*, which has a lane to retry it), but justify
  the choice rather than copying the runner's.
- **Acceptance:** a bare `node os/boot.js` started while the sweep holds the lock must not run
  concurrently — demonstrate it RED (concurrent today) then GREEN. `tests/kernel/run.js` must
  still pass with its internal fan-out unimpaired (that is the re-entrancy proof).
- Add a `todos/LIABILITIES.md` entry anchored in `heavy-lock.js` citing this ticket, so the
  coverage claim is registered rather than living in prose.
