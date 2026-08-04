# #503 — the bash-tool cap bounds wall time and stops lying about the kill

Ticket: #503 (P0, light), from the #488 Pass B dogfood. Branch `ticket-503`.

## The two defects (as shipped, `os/gcode/gcode.c` gucOS path)

1. **The cap did not bound.** On SIGALRM the drain loop did `kill(pid,
   SIGKILL); timedout = 1; continue;` — kill the direct `/bin/sh`, then keep
   draining to EOF. Any pipe-holding descendant (hush runs commands as its own
   children; they inherit the write end and survive the sh kill) held the read
   open past the cap: `sleep 200` measured 203 s under a 120 s cap, `sleep
   300 &` never returned (the alarm is one-shot, `it_interval = 0` — nothing
   ever fired again).
2. **It reported a kill that did not happen.** `[exit -1]` + `[command killed:
   exceeded 120s timeout]` went to the model while the command ran to
   completion. API-honesty violation by name: a model told an `rm -rf` died
   will re-run it concurrently with the survivor.

## The candidate fix was right — and incomplete

The kickoff's candidate (mirror the #412(c) ^C branch: kill AND `break`) is
correct as far as it goes, but an EINTR-branch-only check has a third failure
mode the ticket's table doesn't exercise: **a chatty child whose reads keep
succeeding never EINTRs**, so the alarm flag would never be checked at all and
the loop stays unbounded even with `break` in the EINTR branch (`while true;
do echo spam; done` — the output-cap path deliberately "keeps draining so the
child can exit", forever). The red control confirmed this: the chatty round
hung past a 90 s budget on the parent commit.

So the check moved to the **top of the loop**: `if (g_bash_alarm && !timedout)
{ kill(pid, SIGKILL); timedout = 1; break; }` before every `read`. Gap-free by
the codebase's own cooperative-signal rule (the wm.c flag-then-park precedent
in CLAUDE.md/todos/0178): handlers run only at import returns, and there is no
import between the check and the read — the flag can only change at the read
itself, where EINTR semantics apply (the parked read EINTRs when the signal
lands, kernel krpc-intr, measured in todos/0044).

## The kickoff's four verification questions

- **Can `waitpid` on a SIGKILLed sh block?** No. SIGKILL is non-cooperative in
  gucOS (kernel.js: "SIGKILL still works"), and the #412(c) branch has relied
  on exactly this sequence since it landed ("waitpid on the SIGKILLed sh
  cannot block" — measured then). In the orphan-holder shape the sh is already
  a zombie at the alarm; `kill` on it is a no-op and `waitpid` reaps at once.
  The green run's 9.1 s for three capped rounds is the direct measurement.
- **Does breaking lose output the model should have seen?** Everything the
  command printed *before* the cap was already read by earlier iterations (the
  e2e asserts `spam` is present in the chatty round's tool_result). What can
  be lost is bytes written after the last read and before the kill — the same
  trade the ^C branch made deliberately, and the deadline is the deadline. A
  bounded post-kill drain would need a non-blocking read against a brokered
  pipe fd and buys nothing the model can act on; declined.
- **Is killpg the more honest fix?** No, and it isn't available at the right
  shape. The spawned sh shares gcode's pgroup (no SETPGROUP attr), so
  `killpg` would kill gcode itself; giving the sh its own pgroup would detach
  it from the tty foreground pgroup and break the #412 ^C design (the
  fg-pgroup SIGINT reaching the child IS the normal kill path). Killing the
  whole descendant tree would need pgroup restructuring or a /proc walk —
  genuinely more machinery, and the honest alternative is cheaper: **tell the
  truth in the message**. Which is the real fix for defect 2:
- **Is "killed" the honest report at all?** No. The message is now
  `[command timed out after Ns: shell killed; processes it spawned may still
  be running]` — every clause true at the moment it prints. The e2e asserts
  the caveat's presence and the old fabricated claim's absence.

The alarm needs no re-arming: after the flag is set, the next loop-top check
breaks; the only wait after that is `waitpid` on the dead sh.

## Native path

Already bounded (poll deadline + kill + break). Changes: the same honest
message (its `[command killed: exceeded 120s timeout]` had the identical
descendant-survival lie), the shared `bash_cap_secs()` seam, and the
`/* timeout: kill the group */` comment corrected — it killed only the direct
sh and never did anything group-shaped.

## Testability seam

`GCODE_BASH_SECS` (env, positive seconds, default `CAP_BASH_SECS` = 120),
documented in the header's config block. Same code path — only the constant
moves — so the e2e measures 3 s caps instead of 120 s ones. Without it the
regression test costs 4+ minutes per run forever and the red control is
unbounded.

## Evidence

Red control (parent commit `a4e512fe`'s test against pre-fix `gcode.c`, run
2026-08-05, ~4 m 57 s wall):

- `sleep 30` → `[exit 0]` after its full 30 s (env cap ignored; no timeout
  report of any kind — under the real cap this is the 203 s/120 s shape).
- `sleep 30 &` → `[exit 0]` after ~30 s (returned only because the orphan
  died; `sleep 300 &` is the never-returns shape).
- `while true; do echo spam; done` → hung past the 90 s expect budget (the
  EINTR-only check never ran). Positive controls: `PROBE-OK`/`[exit 0]`
  round-tripped before the hang.

Green (`ec14d593`): `test_gcode_timeout_e2e.js` 17/17 ok, 9107 ms wall for
the three capped rounds (3 s cap each), `[exit -1]` + the honest message in
each timeout round's tool_result, `spam` (pre-cap output) delivered, probe
round `[exit 0]` intact. Native oracle 98/98 (`test_gcode_native.js`),
sibling ^C e2e (`test_gcode_intr_flush_e2e.js`) all ok.

## Deliberately not changed

- The ^C message (`[command killed: interrupted by user (^C)]`) has the same
  descendant-survival caveat gap in principle; left alone — separate wording
  question on a shipped #412 surface, not this ticket's defect.
- No image.json version bump: lane practice for gcode.c changes (#462, #463
  precedent) is that the ship bump happens at deploy, not per merge.
- `[exit -1]` stays as the no-exit-status sentinel; with the kill now real and
  the trailer honest, it no longer asserts anything false.
