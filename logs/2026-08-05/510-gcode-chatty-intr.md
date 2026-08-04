# #510: a chatty child defeated the ^C survivor-edge kill (g_interrupted was EINTR-gated)

Lane: ticket-510. Base: 76c5670d. Tests-first: f01c3de7 (red e2es; `git diff
76c5670d f01c3de7 -- os/gcode/gcode.c` is EMPTY — validatable by
construction). Fix: a7ba8693.

The kickoff handed a CANDIDATE (mirror #503's loop-top move for
`g_interrupted`) and demanded written confirmation or refutation against
76c5670d. Verdict: **CONFIRMED, with one measured subtlety** (answer 2's
tail) and **one adjacent residual filed separately** (answer 5's tail).

## The five answers

### 1. Is the EINTR-gating real at 76c5670d?

Yes, both paths. `os/gcode/gcode.c` at 76c5670d:

- **gucOS**: the `g_interrupted` kill lives at **line 508**, inside
  `if (n < 0) { if (errno == EINTR) { ... } }` — reachable only on an
  EINTR read. The loop-top check at **line 491** covers `g_bash_alarm`
  ONLY (the #503 move; its comment at 480–490 even *names* the chatty
  failure mode it fixed for the alarm, one flag to the left of the flag it
  left behind).
- **Native**: the `g_interrupted` kill lives at **line 588**, inside
  `if (r < 0 && errno == EINTR)` — reachable only when `poll` itself is
  interrupted. There is no loop-top interrupt check at all.

### 2. gucOS: is the signal really claimed at a safe point such that the read returns data with no EINTR?

Yes — confirmed in host.js, not assumed. `host.js:12388-12420`: with a
kernel attached, EVERY env import is wrapped and `ctx.deliverSignals()`
runs at the import's **return** — it claims the pending mask via
`spawnHooks.sigpoll()` and runs the C handlers through `__sig_dispatch`.
So for a chatty child the sequence is: read import returns data → handler
runs → `g_interrupted = 1` → C resumes with `n > 0`. `errno` is never
EINTR; the EINTR path exists only for a **parked** RPC that the kernel
interrupts (krpc-intr). A chatty child keeps the pipe readable, the read
never parks, and the line-508 branch is unreachable.

Measured subtlety from the red run (pre-fix, `GCODE_BASH_SECS=60`): the ^C
stalled the full 60s (the red), but the tool_result carried the **^C
message with [exit 137]**, not the timeout message. Mechanism: hush's
per-echo writes are slower than gcode's 4KB drain reads, so the read DOES
park intermittently; the SIGALRM at the 60s mark happened to land during
one such park → EINTR → the EINTR branch saw the *stale* `g_interrupted`
set 60 seconds earlier and took the interrupt kill. This is direct
evidence for the defect statement: the flag was set the whole time (the
handler ran at a safe point at T+0) while the kill branch stayed
unreachable for 60s. It also means the pre-fix message assertions can pass
by luck — the wall-time check is the load-bearing red.

### 3. Native: does a signal landing between polls really leave the next poll returning POLLIN?

Yes — measured, not inferred. #509's own smoke leg (silent `sleep 30`
child) passes at 76c5670d because its SIGINT lands while `poll` is
**parked** → Darwin does not restart poll → EINTR → kill. The new #510 leg
(same driving, chatty `while true; do echo spam; done`) run against the
unfixed binary blew through its 20s watchdog (`/tmp/510-native-red.log`:
`Error: #510 leg timed out`, immediately after the #509 leg's five `ok`
lines). With the pipe always readable, the SIGINT handler runs wherever
the signal lands (during `read`, buffer bookkeeping, or poll-entry before
blocking), and every subsequent `poll` returns `r > 0` with POLLIN — the
`r < 0 && errno == EINTR` branch is never entered.

### 4. Does moving the check introduce a double-kill or use-after-reap hazard?

No, explicitly. Every kill site is `kill(pid, SIGKILL); flag = 1; break;`
— the `break` makes at most ONE kill fire per `run_command` call, and the
`intkilled`/`timedout` locals (both freshly zeroed per call) guard the
message selection. `waitpid(pid, ...)` remains the single post-loop reap
on both paths, so the kill always targets an un-reaped pid — no reuse
window. Stale-flag insta-kill is also excluded: `execute_tool` is only
reached with `g_interrupted == 0` (the gate at gcode.c:1792 substitutes
"[interrupted by user (^C) — tool not executed]" for any later tool in the
same turn), and the flag is consumed at every turn boundary (1575, 1878)
and reset at turn start (1967) — so a true flag at the drain-loop top can
only mean a ^C during (or racing the entry of) THIS command, which is
exactly when killing is correct. Loop-top ordering: `g_interrupted` is
checked before `g_bash_alarm` — if both land in one safe-point batch, the
user's ^C is the truer cause for the message.

### 5. Any other flag in the same loop with the same pre-#503 shape?

No other flag. The gucOS drain loop consults exactly two
(`g_bash_alarm`, fixed by #503; `g_interrupted`, fixed here); the native
loop's timeout is not a flag at all (poll timeout + `r == 0` deadline
check, wake-driven by construction). But the verification surfaced one
adjacent RESIDUAL, filed separately per the kickoff rule, not folded in:
**native signal-before-poll race** — a signal landing in the few
instructions between the (new) loop-top check and `poll` entering is
handled *before* poll blocks, so a **silent** child's poll then parks with
no EINTR and the ^C stays latent until the next wake (data, EOF, or the
cap; poll's timeout is `remain*1000+100`, so worst case the remaining
cap). The window is microseconds per iteration and the fix is a different
mechanism entirely (pselect/self-pipe — macOS has no ppoll); pre-existing,
NOT widened by this change (the old EINTR-only shape had the identical
window), and nonexistent in gucOS (cooperative signals: no import between
the loop-top checks and the read, the wm.c flag-then-park rule). Filed as
ticket #511.

## The fix (a7ba8693)

Mirror #503 on both paths: gucOS checks `g_interrupted` at the drain-loop
top (before the alarm check), native checks it before every `poll`; both
EINTR branches now just `continue` to the loop-top checks. Semantics of
the #412(c) survivor edge unchanged — kill the direct sh AND stop reading,
message stays #509's honest wording.

## Tests (f01c3de7, red-first)

- `tests/kernel/test_gcode_intr_chatty_e2e.js` (registered in
  tests/kernel/run.js): #509's survivor-edge driving (`kill -INT` at gcode
  alone) composed with #503 round 4's chatty command. Red at 76c5670d:
  `FAIL ^C kills the chatty sh promptly ... 60s` (/tmp/510-kernel-red.log).
  Green post-fix: 10/10.
- `os/gcode/test/smoke.mjs` #510 leg (native; the check-count guard in
  test_gcode_native.js raises the denominator automatically, 104 → 111
  total oracle checks). Red at 76c5670d: watchdog timeout. Green post-fix:
  oracle PASS, 111 ok / 0 FAIL.
- Adjacent regressions re-run green post-fix: test_gcode_timeout_e2e.js
  (#503), test_gcode_intr_honesty_e2e.js (#509).
