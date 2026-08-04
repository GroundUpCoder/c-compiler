# #486 — Hung-app contain: force-quit an ignored close request

The GAMEDEV-EPIC foundation item (OS.md "Contain", jku promotion to front of
P0): a process that never drains its input ring ignores the window close
button forever, and nothing in the kernel escaped that — the user's only
remedy was killing the whole OS.

## What landed (kernel.js only; no image bump — kernel.js ships static, todos/0140)

`Kernel.prototype.wmCloseRequest(sid)` is now the ONE choke for user close
requests — the chrome close box and WMP `CLOSE_REQ` (wm.c taskbar Close,
`wmctl close`) both route through it. It delivers `WMEV.QUIT` exactly as
before and arms a one-shot per-surface watchdog (`surface.closeWd`) that
polls the input ring's rpos:

- **Consumed within the grace period → disarm.** The criterion is
  *consumption*, not exiting: an app that pumps the event and decides to
  stay open is responding (the Windows rule — pumping = alive). The default
  grace is `WM_HUNG_GRACE_MS` = 5s; `Kernel({hungGraceMs})` is the
  embedder-tunable analog of Windows' HungAppTimeout (tests use 300ms).
- **Unconsumed at the deadline → force quit.** Reason first —
  `"<title>" (pid N) is not responding — force quit` through `_log`
  (boot.js: stderr; browser: boot-log) — then the SIGKILL path
  (`_deliver(pcb, SIG.KILL)`), whose `_exitProcess` already reclaims
  surfaces/fds/ring, so a hung app cannot block its own teardown.
- **Second close during grace, first QUIT still unconsumed → immediate
  force quit** (the ticket's Windows-style escalation). Consumption is
  re-checked synchronously at the click, so a responsive app that already
  pumped the first QUIT gets a fresh request instead.
- **Full ring at request time (`EAGAIN`) arms anyway** — cap records
  sitting undrained is the strongest not-responding signal there is. The
  poll retries delivery on the same grace clock (the clock starts at the
  user's click), and the caller still sees `EAGAIN` (wire contract
  unchanged).

Deliberately excluded: the grab-dismiss `WMEV.QUIT` (`_wmGrabConsume`).
Dismissing a popup is UI housekeeping, not a request to quit — a
momentarily-busy owner must not be force-quit because a click landed
outside its menu.

## The aliasing trap (why the watchdog POLLS instead of one deadline check)

rpos/wpos live in `[0, 2*cap)` and a live consumer laps that space (5s of
mousemotion outruns a 256-slot ring), so a single check at the deadline can
alias and mis-read a responsive app as hung. The poll (250ms, or grace/4
when shorter) keeps `need` = records-left-to-consume and subtracts the
per-poll rpos delta; a drained-dry ring (`rpos == wpos`, wpos only moves on
the kernel thread) is alias-proof evidence of consumption on its own.
Watchdog timers are `unref()`d where available so an armed watchdog never
pins a Node embedder's event loop.

## Tests (tests/kernel/test_wm.js — no registry change; #485 owns run.js)

Four new leg groups on the deterministic fake-worker harness
(`hungGraceMs: 300`): wedged app closed via the real chrome path →
zombie + surfaces reclaimed + worker terminated + reason string; polite app
that drains → never touched, no log line; second-close escalation →
immediate; flooded cap-8 ring → `EAGAIN` and still force-quit at the
deadline. Red control (kernel.js reverted): the four hung-app checks FAIL
and the file dies `FATAL TypeError: kernel.wmCloseRequest is not a
function`, exit 1 — recorded in advance, reproduced exactly.

Gotcha found by the red control itself: my post-leg reaps were blocking
`WAIT`s, which HUNG the file when the regression left the child alive.
They're `WNOHANG` now (each zombie is guaranteed by the checks above it) —
the 0171 fail-loud discipline applied to the test's own plumbing.
