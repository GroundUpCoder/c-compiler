# Interval timers: alarm/setitimer(ITIMER_REAL) → SIGALRM (todos/0044)

Landed: `alarm()`, `ualarm()`, `setitimer`/`getitimer(ITIMER_REAL)`
delivering SIGALRM through the existing cooperative signal path. As the
queue item predicted, this is pure bookkeeping on machinery that already
exists — the kernel half is ~60 lines and delivery is one `_deliver`
call.

## Shape: one timer, one signal bit, existing plumbing

The kernel owns ONE real-time timer per process (`pcb.itimer`: an
`expiresAt`, an `intervalMs`, a live `setTimeout`). Expiry posts SIGALRM
via `_deliver`, so everything downstream is inherited for free:
disposition mirror (IGN drops, CAUGHT sets the SIGPEND bit, DFL
terminates as WIFSIGNALED(SIGALRM)), signal blocking, EINTR out of
blocked reads, the pending-while-STOPPED → deliver-after-SIGCONT
behavior. The acceptance criterion "no handler installed terminates the
process" required zero code — it falls out of the mirror.

Two new opcodes (`SETITIMER` 0x000B / `GETITIMER` 0x000C) with a
**milliseconds wire ABI**; the libc owns timeval↔ms conversion. Decisions
that mattered:

- **Nonzero sub-ms rounds UP**, never down: an armed
  `it_value = {0, 1}` must not convert to 0 ms, because 0 means
  *disarm* in the setitimer ABI. Same rule kernel-side —
  `_itimerRemaining` reads `max(1, expiresAt - now)` so an
  armed-but-about-to-fire timer never reports the disarmed shape.
  (And in `ualarm`, divide-then-round rather than `(usecs+999)/1000` —
  the latter wraps unsigned for usecs near UINT_MAX and would silently
  disarm instead of arming ~71 minutes.)
- **`it_interval` reloads from "now"** at each expiry, not from the
  theoretical deadline. setTimeout latency therefore never accumulates
  into a backlog of SIGALRMs — which is honest, because one SIGPEND bit
  is all the SAB can represent anyway (POSIX allows coalescing).
- **Re-arm BEFORE delivering** in `_itimerFire`: a handler that calls
  `getitimer` sees the reloaded value, and if delivery terminates the
  process (DFL), `_exitProcess` clears the fresh timer along with
  everything else. Timers die with the process and are not inherited
  across spawn (POSIX).
- **`ITIMER_VIRTUAL`/`ITIMER_PROF` → EINVAL**, documented: workers run
  on their own OS threads, so there is no per-process CPU accounting to
  back them — same "synthetic/absent by design, fail loud" posture as
  0043's utime/stime.
- **No kernel = ENOSYS stubs** (`createNullSpawn`): `setitimer` fails
  loud; `alarm()` returns 0 and the timer simply never fires, because
  POSIX gives alarm no error return.
- Delivery stays cooperative (safe points, the settled 0001 caveat):
  a pure-compute loop observes SIGALRM only at its next safe point.
  Recorded in KERNEL.md's new "Interval timers" section.

## Testing

- `test_kernel.js` grew a SAB-protocol section: EINVAL flavors,
  arm/read-remaining/one-shot-disarm, interval reload, cancel returns
  old values, exit clears the timer (a stale setTimeout would post bits
  on a zombie page), DFL termination as termsig 14. Real setTimeout
  drives expiry, so the legs use generous margins (arm 50 ms, observe
  at 150 ms) — booleans only, no exact deadlines to flake.
- New `tests/kernel/test_itimer_e2e.js`: real C under a live kernel —
  the classic timeout idiom (`alarm(1)` EINTRs a blocked pipe read; the
  fs is brokered specifically so that read parks as a deferred FS_READ
  the signal can interrupt), repeating `it_interval` woken by `pause()`,
  getitimer sanity, disarm/cancel/replace semantics, `ualarm`, and a
  spawned no-handler child dying WIFSIGNALED(SIGALRM).

Suites: kernel (all files), blockfs 12/12, unit 699/0/3 — green. Image
bumped v32 → v33 (libc change rebakes every baked binary per the 0040
convention) and `os-system.img` rebaked; full 10-file browser sweep
re-run for the rebake — 9 green first pass, os-doom's "wmctl close →
desktop restored" leg flaked once (window lingered past the 30s wait)
and passed clean on solo re-run, same flake class as os-boots's vi leg.
