# #509 — the ^C bash-tool message stops claiming a kill it did not do

Adjacent to #503 (same honesty class, the interrupt path instead of the
timeout path). Both platform paths of `run_command` in `os/gcode/gcode.c`
said, after a ^C that SIGKILLed the direct sh:

    [command killed: interrupted by user (^C)]

`kill(pid, SIGKILL)` reaches only the direct `/bin/sh`; in the #412(c)
survivor edge a pipe-holding descendant survives. New wording, mirroring
#503's, true in every reachable case:

    [command interrupted by user (^C): shell killed; processes it spawned
     may still be running]

## The four verification questions (answers, with the evidence)

**1. Is `intkilled` reachable in a path where the whole job really died?
YES — the kickoff's stronger hypothesis ("the string is wrong every time
it appears") is REFUTED; the ticket body's "usually true" is correct.**
In the ordinary tty ^C the fg-pgroup SIGINT reaches gcode AND the job.
gcode spends the drain loop parked in `read` (gucOS: the krpc park EINTRs
when a signal lands — the comment block above `bash_on_alarm` says so and
#412's t6 leg measures it; native: `poll` is not restarted by Darwin's
SA_RESTART, verified empirically by the new smoke leg returning promptly).
So the common ordinary-^C order is: signal lands on the parked read →
EINTR → `g_interrupted` set → the branch fires → `intkilled = 1` — while
the job ALSO died of its own SIGINT. The whole-job-died case and the
survivor-edge case both reach the same string, which is why the fix
wording is hedged ("may still be running") — every clause is true in both
cases. The other race order (EOF beats the EINTR) exits at `n == 0` with
`intkilled` still 0; see (2).

**2. Does the ordinary ^C path (EOF wins the race) report an interrupt at
all? No marker — and I argue that is NOT an honesty gap, so no ticket.**
When the job dies of the fg-pgroup SIGINT before gcode's read EINTRs, the
loop exits via EOF and the tool_result carries the output plus
`[exit 130]` (128+SIGINT) with no ^C marker. Nothing false is claimed:
exit 130 is the standard, truthful POSIX report of death-by-SIGINT, the
same thing any shell would report. The turn still ends
`status: interrupted` (#412), any remaining batched tools get the
explicit `[interrupted by user (^C) — tool not executed]` substitution,
and no POST goes out until the user — who performed the ^C — sends the
next message. An omission whose fact is carried by the exit code is not
the fabrication class this ticket is about. Deliberately not widened, not
filed.

**3. Is `killpg` the more honest fix? No — #503's rejection carries over
unchanged.** Both spawn sites put the sh in gcode's own process group
(gucOS: `posix_spawn` with a null attr; native: `fork` with no
`setpgid`), so `killpg` would SIGKILL gcode itself. Giving the child its
own pgroup would remove it from the tty's foreground pgroup, so the
ordinary ^C's SIGINT would no longer reach the job at all — breaking the
#412 design the interrupt path is built on. The interrupt path uses the
identical process layout as the timeout path; nothing about the reasoning
is timeout-specific.

**4. Does an existing test pin the current string? NO.** The only
"interrupted by user" assertion in the estate
(`test_gcode_step2_e2e.js:227`) matches `toolu_412b`'s SUBSTITUTED result
— the `[interrupted by user (^C) — tool not executed]` string from the
tool-dispatch loop (gcode.c ~:1783), a different site this ticket does
not touch. The run_command ^C string had no positive control at all, so
changing it turns nothing red — which is exactly why the new e2e was
required, and why it was committed FIRST.

## Red control (by construction)

Test commit 485271b4 precedes the fix; `git diff 8001c588 485271b4 --
os/gcode/gcode.c` is EMPTY, so the red runs provably exercised unmodified
product code. Both paths driven with the t6 pattern (`kill -INT` at gcode
alone; sh runs `sleep 30` as its own child — the survivor):

- **In-OS red** (`test_gcode_intr_honesty_e2e.js`): 2 FAIL — the
  persisted tool_result reads `[exit 137]\n\n[command killed: interrupted
  by user (^C)]`. The 137 (128+SIGKILL) proves our kill landed on the sh;
  the prompt return (≤10 s, not 30) proves the sleep child was NOT
  drained — i.e. it survived, while the message claimed the command was
  killed. Positive control: the probe round's `[exit 0]` + `PROBE-OK` in
  POST body 2. Instrument is the SESSION LOG, not POST bodies — #412
  sends no tool_results POST after a ^C.
- **Native red** (new `smoke.mjs` leg): same 2 FAIL on the same
  assertions. Bonus finding: this is the first coverage the native
  interrupt path has ever had, and it fired correctly (returned promptly,
  exit 0) — Darwin's `signal()`-installed SA_RESTART does not restart
  `poll`, so the EINTR branch is live natively.

Green after the one-commit fix (574a7fd4): smoke.mjs 104/104 checks PASS
(the count guard in `test_gcode_native.js` derives the denominator from
source, so the 6 new checks raise it automatically); the kernel e2e 9/9.

## Filed separately (scope held)

**#510** — verifying (1) exposed the interrupt twin of #503's finding
(b): `g_interrupted` is checked ONLY in the EINTR branches, so a chatty
child whose reads keep succeeding (gucOS: the signal is claimed at the
read RPC's import entry, then the read returns data — no EINTR; native:
the next poll returns POLLIN) never triggers the kill — a survivor-edge
^C does nothing until the 120 s cap. #503 moved the ALARM check to the
loop top but left `g_interrupted` in the pre-#503 shape. Behavior change,
not wording — filed, not folded.
