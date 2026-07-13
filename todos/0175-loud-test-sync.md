# 0175 — Loud-symptom test sync: fail on wmctl-wait timeout + waitForServer death (0171 follow-up)

- **Status**: in progress (landing with 0171's follow-up, 2026-07-13)
- **Design**: — (principle codified in CLAUDE.md "Test-sync discipline")

## Goal

Root cause over quiet symptom. 0171 exposed that the estate's timing bugs
all hid behind a SILENT symptom: a wait that could never succeed just ran
out its clock and the script sailed on. `wmctl wait` is loud where it lives
(prints `wmctl: wait X timed out after Nms`, exits 1) — the silence was one
level up, in drivers that ignored the exit code and the stderr and burned
the full timeout. Same shape as `waitForServer` returning false and getting
discarded → a downstream `page.goto: ERR_CONNECTION_REFUSED` that reads like
a product failure but is a stale `serve.js` squatting a fixed port.

Make both loud, so a wait on an unreachable condition FAILS instead of
passing slowly (fileman_ops was 117s of mostly-dead waits before the 0171
AQ_GETTEXT fix; 27s after).

## Plan (landed)

- `tests/kernel/lib/drive.js`: `driveBoot` scans captured stdout+stderr for
  `wmctl: wait ... timed out after Nms` and throws, naming every timed-out
  condition (opt-out `allowWaitTimeout` for a deliberate negative wait; no
  e2e currently needs it — absence checks use `nowin`/`nolabel`, which
  succeed on absence, not the clock).
- `tests/browser/lib/os-harness.mjs`: `waitForServer` THROWS a clear,
  actionable error on exhaustion by default (stale-serve.js / rebake hint)
  instead of returning false to be discarded; `{ soft: true }` keeps the
  boolean for the unit test. Covers all ~28 browser callers at once (they
  all page.goto immediately after — none want to proceed past a dead
  server). Unit test asserts both the soft-boolean and the default-throw.
- `CLAUDE.md`: "Test-sync discipline — root cause over quiet symptom" —
  no fixed sleeps, waits fail loud, servers announce their own death, fix
  the diagnostic when a symptom is confusing.

## Blast radius (the point of the loud gate)

Running the full kernel suite under the new `driveBoot` gate is the HUNT:
any currently-green e2e that turns red has a silent wait-timeout the idle
box was hiding — a real bug this surfaces. Record the result here; fix or
file each red.

## Follow-ups (noted, not blocking)

- Browser sweep uses FIXED ports per file; a crashed/killed run leaves a
  squatter that fails the next run. The `waitForServer` throw now NAMES
  this, but dynamic/ephemeral ports would remove the failure mode. Bigger
  change (~28 files or a shared allocator) — separate item if it recurs.

## Acceptance

- `driveBoot` fails loud on any real `wmctl wait` timeout; the browser
  harness throws a named error when a server never comes up (unit test
  green both ways).
- Full kernel + browser suites green under the new gates (or every red the
  gate surfaces is root-caused and fixed/filed).
- The discipline is in CLAUDE.md.
