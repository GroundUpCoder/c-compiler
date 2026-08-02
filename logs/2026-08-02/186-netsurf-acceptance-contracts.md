# #186 — acceptance contracts for the netsurf 0424 + 0426 tickets

## The migration wrinkle (why this log exists)

#186 was filed 2026-07-30, the day of the queue cutover, and its Plan and
Acceptance name `todos/0424-*.md`, `todos/0426-*.md` and `node
todos/queue.js check` — none of which exist any more. The file queue was
retired that same day; 0424 and 0426 migrated 1:1 into cc tickets **#177**
and **#178** (their done siblings 0420–0423, 0425, 0427 are all in
`todos/done/`, those two are not). `queue.js` is gone; its successor is the
`todos` suite in `tests/run.js`.

So the contracts landed where the tickets now live — appended to the
**tracker bodies** of #177 and #178 via `cc-meta ticket update`, marked
"(written by #186, 2026-08-02)" — and this committed log is the repo-side
record the retired `.md` files would have been.

## What was written

- **#177 (0424, JS exceptions → console):** a `## Acceptance` with 4 arms,
  derived from its existing Plan, each checkable by a command or a captured
  artifact. It states which surface the ticket buys: the CONSOLE channel
  (`browser_window_console_log`), which in gucOS reaches the TTY through the
  0421 seam; NSLOG (the log surface) is explicitly unchanged.
- **#178 (0426, restyle shapes):** a `## Plan` (7 steps: a bounded libcss
  spike with a GO/NO-GO gate, then either the selector-index + reveal
  implementation with tests, cost re-measurement and patch record, or a
  NO-GO branch that records the ruling in the `HTML_CHAIN_MAX` anchor
  comment), and a `## Acceptance` with 6 arms traced to those steps.
  Neither shape is silently dropped: the NO-GO branch is the recorded form
  of dropping them, and it must name both — so no separate `## Not in
  scope` heading was needed.

## Arm status against the current tree (main @0114f5e6) — #186 arm 4

10 arms written, each verified and labelled in place:

- **7 FALSE today / not yet runnable** (the work the tickets owe):
  177-1 (grep count is 0 — nothing in dukky.c calls
  `browser_window_console_log`), 177-2 (no test asserts an uncaught
  exception; `test_netsurf_console_e2e.js` excludes them by name), 177-3
  (both stale "nothing emits BW_CS_SCRIPT_ERROR" claims present), 178-1,
  178-2 (no `sibling`/`reveal` legs in `test_netsurf_pointer_e2e.js`),
  178-4 (cannot run before the change), 178-5.
- **3 TRUE today**, labelled with the discharging ticket so they read as
  pins, not work owed: 177-4 and 178-6 (`node tests/netsurf/run.js` run
  fresh: 2/2 passed — discharged by todos/done/0423; each arm states it
  binds only after the lane's own vendored edit), and 178-3 (the six
  existing pointer legs — discharged by todos/done/0419 + 0420, listed as
  a regression pin).

Per the kickoff: the netsurf e2e estate drives `file://` throughout and
ticket #369 (HTTP coverage) is still open — 177's contract says so
explicitly and requires no HTTP-dependent arm.

## #186 arm 3 (do-not-touch proof, adapted)

0349/0385/0386 are tracker tickets now, not files. No `ticket update` was
issued against any ticket other than #177 and #178, and the working-tree
diff for this lane touches only `CLAUDE.md` (that is #415's edit) and
`logs/` — no `todos/` path changed at all.

## #186 arm 5 (adapted)

`node todos/queue.js check` no longer exists; the equivalent gate is the
`todos` suite, run via `node tests/run.js --diff origin/main` — result in
the lane close-out.
