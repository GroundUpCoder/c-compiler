# 0083 — Event-based waits: retire the sleep-N sync class in e2e + browser suites

- **Status**: open
- **Design**: this file (spawned from `todos/done/0081`; counted there)

## Goal

0081 estimated the sleep-based-synchronization sites; the 2026-07-12
test-infra audit re-counted against the live tree and found them
**~3× worse**: **~445 `sleep N` driver-sync lines** (not 145) across
the kernel e2e boot scripts (`sleep 4` for "wasm boot + first paint",
`sleep 2` after a key, …), aggregating **~573s** of pure guess-waits
(excluding sleeps typed as test *subjects*), and **~104 fixed-delay
sites** (~41s) across the browser tests. Worst offenders:
`test_wm_service_e2e.js` (111 sleep lines), `test_fileman_ops_e2e.js`
(55), `test_recycle_e2e.js` (52), `test_ctxmenu_e2e.js` (43); browser:
`os-shell.mjs` (30), `os-winmine.mjs` (10). They are slow when the
machine is fast and flaky when it's loaded (the 0074 os-doom
"deterministic failure" class) — and they put a floor under 0082's
wall-clock win: once the bake is gone, the sleeps ARE the e2e cost
(e.g. `os-recycle.mjs` is 48.5s of which ~44s is fixed delay; boot is
~4.5s).

Replace the class with observable conditions, not longer sleeps. The
shared wait helpers land in the 0146 harness extract (do that first —
this item is soft-`after` 0146) so `wmctl wait` / browser `waitFor`
are added ONCE, not per-file.

## Plan

- Inventory what each sleep actually waits for. The big buckets:
  window exists / first frame presented (wmctl-observable), repaint
  after input (surface seq/generation), process exited (waitpid via
  shell `$?`), tty output settled (__osOut marker lines).
- Design ONE wait helper per side:
  - in-OS scripts: a `wmctl wait` subcommand (e.g. wait-for-surface,
    wait-for-seq-advance, with timeout) — the kernel already tracks
    surface seq/present state, so this is mostly plumbing; marker
    `echo` lines cover the non-WM cases.
  - browser: a shared `waitFor(page, cond)` poll util already exists
    ad hoc in several files — extract, and prefer page-observable
    probes (`__osOut` markers, `__osScreen`, wmctl output) over
    timeouts.
- Convert file by file; per-file conversion is independently landable.
  Priority: the files 0082 leaves as the top wall-clock sinks, and the
  historically flaky ones (os-doom, term, wm_service).

## Acceptance

- No `sleep N`/`waitForTimeout` used as a *synchronization* primitive
  in the converted files (bounded-timeout condition polls are fine —
  the timeout is then a failure deadline, not a sync point).
- Converted files pass under load (e.g. while a parallel kernel run is
  in flight) — the contention scenario 0081 documented.
