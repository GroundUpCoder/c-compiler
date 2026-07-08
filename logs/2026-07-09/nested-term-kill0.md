# Nested terms + kill(pid, 0) — a 0039 follow-up from a user report

Right after 0039 closed, the operator recalled an old failure: open a
GUI terminal, run `term &` from inside it, kill the parent — "the child
sticks around but I think it gets stuck." Neither sweep round had
driven that lifecycle. This session chased it.

## What the lifecycle actually does today (verified headless)

- **Parent killed** (close box, SIGTERM, or SIGKILL — all converge):
  term1 dies → its pty master closes → the kernel SIGHUPs the pty's
  foreground pgroup (POSIX; kernel.js `_ofdUnref` ptm branch) → the
  inner hush **resends SIGHUP to all its jobs and exits** (hush.c's
  documented, bash-consistent teardown) → the nested term dies too.
  Both windows reclaimed, no ghosts. Closing a terminal kills the
  session it hosted — Linux-desktop-default semantics.
- **Parent hush EXITS** (typed `exit`): plain exit does NOT HUP
  background jobs, so the child term **survives its parent** — that is
  the "sticks around" the report remembered, and it is correct POSIX
  behavior. The orphan is reparented to init (kernel.js reparenting),
  keeps executing typed input (verified: injected `mkdir` ran), and its
  close box reclaims it cleanly. **The remembered wedge did not
  reproduce** — whatever caused it is gone.

Regression-pinned in `test_term_e2e.js` session C (both variants +
orphan responsiveness + orphan close).

## The real bug the chase surfaced: kill(pid, 0) was broken — twice

Probing the orphan's liveness with hush's `kill -0 PID` reported a
provably-live process (it was executing input!) as dead. POSIX kill(2):
sig 0 = error checking only, no signal sent — the standard existence
probe. It was rejected at TWO layers:

1. **kernel.js** `kill()`: `sig > 0` guard → EINVAL. Fixed: sig 0
   routes and error-checks (ESRCH on unknown pid / empty pgroup,
   success on a live target), delivers nothing; `_killPgid` counts
   without delivering. An old test_kernel.js golden ENCODED the
   rejection ('bad signal -> EINVAL' on sig 0) — replaced with probe
   legs + true bad-signal legs (999, negative). Tests first: f9a9997,
   fix: 40df750.
2. **libc** `kill()` (compiler.js): gated through `__sig_ok` (`s > 0`),
   so sig 0 got client-side EINVAL and the kernel fix was unreachable
   from C. Fixed in kill() ONLY — signal()/sigaction()/raise() keep
   rejecting 0, where it is genuinely invalid; a self-directed probe
   succeeds without delivering. Tests first (the red orphan-alive leg,
   7d9553d), fix: 0be0d6a.

## Gotcha reaffirmed (it bit this session)

A **libc change is a baked-binaries change**: the first in-OS retest
after the libc fix still failed because the v28 blob (old libc inside
/bin/coreutils' kill) was reused. `os/image.json` → **v29**, mkimage
rebake, then green. Same rule as seeded sources — if you touch
compiler.js's libc, bump the image.

## Suites at close

unit 698✓/0✗/3 skip (the two movable libc goldens did not move),
blockfs✓, kernel✓ (incl. the new probe + nested-term legs), browser
sweep serial on the v29 image ✓.
