# 0342 — the heavy-suite RAM lock is bypassed by the invocation every test file documents

- **Status**: open
- **Reported by**: the 0330 lane (clang-simplified libc re-vendor), 2026-07-28
- **Evidence**: first-hand — hit while trying to run `todos/0330`'s own named
  acceptance leg against a live kernel suite

## The mechanism

`tests/lib/heavy-lock.js` is acquired in exactly **two** places, both *suite
runners*:

```
tests/kernel/run.js:179       acquireHeavyLock({ name: 'kernel suite' })
tests/browser/os-sweep.mjs:44 acquireHeavyLock({ name: 'browser os sweep' })
```

**No individual test file takes it.** But an individual kernel e2e boots the
same full-OS process trees the lock exists to serialise — `os/boot.js` nodes at
~4 GB each — and every one of them documents being run on its own:

| count | fact |
|---|---|
| 121 | `tests/kernel/test_*.js` files |
| 119 | that document a direct `node tests/kernel/<file>` line in their own header |
| 66 | that boot a full OS (`require('./lib/drive.js')`) |
| **66** | **that do both** — i.e. every full-OS e2e tells you to run it lock-free |

`todos/0330` §Plan step 3 says `node tests/kernel/test_clang_pkgs_e2e.js`;
that file's own header says `Run: node tests/kernel/test_clang_pkgs_e2e.js`.
Both are the documented, correct-looking invocation, and both take no lock.

## Why this matters — it is the exact scenario the policy was written for

`CLAUDE.md` §"Heavy-suite RAM policy" exists because on **2026-07-25** two heavy
runners at once OOM'd a 16 GB box into a jetsam death spiral → launchservicesd
lock convoy → WindowServer watchdog kill. The stated guard is *"kernel + sweep
take an exclusive lock and fail fast (exit 3) if another heavy runner owns it."*

That guarantee holds only for the two runner entry points. Concretely, on
2026-07-28 the kernel suite was running (`pid 58291`, `argv:
["/Users/jku/git/c-compiler/tests/kernel/run.js"]`) while this lane needed
`test_clang_pkgs_e2e.js` — six full-OS install+launch legs. Running it would
have stacked the trees with **no exit 3 and no warning**; the lane only avoided
it by reading the lock file by hand. There is nothing generalisable about
"remember to check the lock manually before every single-file run."

Note the failure mode is strictly worse than the one already guarded: a lane
that hits the guard gets a clean, self-explaining `exit 3`. A lane that
bypasses it gets an OOM that kills the GUI, and the symptom points nowhere near
the cause.

## Goal

Make the guarantee a property of *booting a full OS*, not of *which entry point
you happened to type*.

## Acceptance

- **The lock moves to (or is additionally taken at) the choke point every heavy
  test already funnels through** — `tests/kernel/lib/drive.js`'s boot path — so
  a single-file run is protected without touching 66 files. `run.js`
  acquiring it first must remain correct: its own children must not deadlock
  against it (re-entrancy via an inherited env marker, or an equivalent —
  whichever, the nested case must be demonstrated, not assumed).
- **A positive control in the same log:** with the lock held by a stand-in
  holder, `node tests/kernel/<some full-OS e2e>.js` **exits 3** and names the
  holder. A guard whose failure path was never exercised is not a guard
  (the todos/0341 rule).
- **No behaviour change on the happy path**: `node tests/kernel/run.js` and a
  lone single-file run both still work, with numbers shown for each.
- `CC_NO_HEAVY_LOCK=1` keeps working as the documented isolated-host escape and
  is named in the failure message.
- If the choke point turns out to be the wrong seam, say so and put the lock
  wherever the full-OS boot actually is — the acceptance is "no full-OS boot
  runs unlocked", not "edit drive.js".

## Priority rationale

P1. Nothing is currently broken *by* it — it is a missing guard, not a
regression, so it is not P0 under the priority policy. But the hazard is live
every time two lanes overlap, the estate runs concurrent lanes as a matter of
course, and the realised cost last time was a killed GUI. Cheap and one-shot,
like `todos/0341`, whose class it shares: *the documented, natural invocation
silently escapes a protection everyone believes is in force.*
