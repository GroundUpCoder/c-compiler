# 0288 — advapi32 hive: reload-merge dirty values at flush (three live consumers today — 0162's deferral premise is false)

- **Status**: open
- **Design**: this file + `todos/WIN32.md:477-480` (the fix is named there).
  `todos/0162` is the *parked SQLite redesign* and stays parked — this is the cheap
  correctness fix it was blocking.

## Goal

Stop silent registry data loss in a completely ordinary flow: **open winmine and notepad, close
them in either order — the second exiter reverts the first's registry writes wholesale.**

Verified against current code at `847dc057`:

- `os/win32/advapi32.c:82-85` — `hive_load()` reads `$HOME/.win32reg` **once per process**
  (`g_loaded`) and registers `atexit(hive_flush)`.
- `hive_flush()` **rewrites the whole file** with no reload-merge. Per-process
  whole-file last-writer-wins.
- Writes since the last flush are lost on `SIGKILL`.

## Why this was not scheduled (the part worth keeping)

`todos/0162` exists, which makes this look handled. Its status line reads:

> deferred (parked design option, **no current consumer**; defer until a live cross-process
> registry consumer exists)

**There are three**, all seeded and reachable from the Desktop/Start menu, all writing this same
hive: `vendor/winmine/main.c`, `vendor/notepad/settings.c`, `vendor/calc/winmain.c`.

So this is a *documented* deferral resting on a factual claim that the OS has since falsified by
growing more win32 apps — with the extra twist that **the ticket's existence makes it look
handled**. Separately, *"there's no current consumer"* is verbatim one of the reasons
`CLAUDE.md`'s CORE PRINCIPLE names as **not valid** for cutting scope.

## Plan

- Implement the fix `WIN32.md:480` already names: **reload-merge dirty values at flush** —
  re-read the hive at flush time and merge this process's dirty values over it, instead of
  rewriting wholesale from a snapshot taken at process start.
- Decide and record what happens on a genuine conflict (same key, same name, both dirty).
  Last-writer-wins *per value* is defensible; last-writer-wins *per file* is the bug.
- **Also fix the premise, not just the code:** correct `0162`'s status line so it no longer
  asserts "no current consumer". Leaving that sentence in place recreates the exact trap even
  after this item ships. (`0162` itself remains parked — the SQLite question is untouched.)

## Non-goal

The registry **service** / SQLite backend of `0162`. Not needed for this, and explicitly not
in scope.

## Acceptance

- A two-process test: app A writes value X, app B writes value Y, both exit (in **both**
  orders) — **X and Y both survive**. This is the test that fails today.
- Existing settings round-trips unchanged (notepad font, winmine board, calc layout persist
  across relaunch).
- `0162`'s status line no longer claims there is no consumer.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
