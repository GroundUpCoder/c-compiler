# 0083 — Event-based waits: retire the sleep-N sync class in e2e + browser suites

- **Status**: open
- **Design**: this file (spawned from `todos/done/0081`; counted there)

## Goal

0081 counted the sleep-based-synchronization sites: **~145 `sleep N`
lines** in the kernel e2e boot scripts (`sleep 4` for "wasm boot +
first paint", `sleep 2` after a key, …) and **~60 `waitForTimeout`/
fixed-delay sites** across the 15 browser tests. They are slow when the
machine is fast and flaky when it's loaded (the 0074 os-doom
"deterministic failure" class) — and they put a floor under 0082's
wall-clock win: once the bake is gone, the sleeps ARE the e2e cost.

Replace the class with observable conditions, not longer sleeps.

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
