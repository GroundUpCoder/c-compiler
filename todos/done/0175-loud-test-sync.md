# 0175 — Loud-symptom test sync: fail on wmctl-wait timeout + waitForServer death (0171 follow-up)

- **Status**: done (2026-07-13)
- **Design**: — (principle codified in CLAUDE.md "Test-sync discipline")

## Resolution

Gates landed (commit 78d5c93) and the blast-radius hunt ran: full kernel
suite + browser sweep at HEAD under the new `driveBoot` gate. **The gate
caught 5 kernel e2es whose green was hiding dead waits** — every one a
wait on a condition that could never be satisfied, burning its full
timeout since birth:

- `test_winmine_e2e` (×2) + `test_paint_e2e`: boot barriers waited on
  CLOSED-menu items ("Advanced"/"Exit"/"Filled Rectangle") — deliberately
  not GETTEXT-resolvable since 0171. Fixed: wait on the top-level window's
  TEXT (resolves exactly when the app serves the agent socket).
- `test_gdi32_e2e`: `wait seq $SID 2` — gdidemo paints ONCE per instance
  (nothing re-invalidates it), so the "second present" never came and the
  same-boot bit-exact check compared one present with itself. Fixed: the
  second shot comes from a second boot (independent paint — stronger
  determinism claim).
- `test_user32_e2e`: `wait text EDIT:0` — CLASS:n indexes the whole tree;
  the dialog's edit is EDIT:2 (main window's two EDITs enumerate first).
- `test_fileman_ops_e2e` (×2): `wait count "File Manager" 2/1` — the main
  window is titled "File Manager - <cwd>" since 0106 and wait-count
  matches EXACTLY, so the counts never left 1/0. Fixed: `wait win`/`wait
  nowin` on the error box's exact title.

Fixing the dead clock also bought real time: gdi32 7.0→1.5s, winmine
18.8→9.4s, paint 18.7→7.1s, fileman 26.6→12.8s. The sweep re-run also
re-surfaced the known 0156 os-shell red; the same headless pixel-map
technique root-caused and FIXED it (closed with this batch — see 0156's
Resolution). Post-fix: kernel suite 63/63, browser sweep 24/24.

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
