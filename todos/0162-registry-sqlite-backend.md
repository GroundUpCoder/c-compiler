# 0162 — registry backend: consider SQLite (shared, consistent hive)

- **Status**: deferred (parked design option, no current consumer; defer until a live cross-process registry consumer exists)
- **Design**: this file (spun out of the registry batched-flush fix,
  `logs/2026-07-12/registry-batched-flush.md`)

## Context

`os/win32/advapi32.c` is the win32 registry: a text hive at `$HOME/.win32reg`,
loaded **once per process** (`g_loaded`), mutated in an in-memory linked list,
written back on flush (batched to `RegCloseKey`/`atexit` as of the fix above).
That fix removed the performance problem (notepad close ~800ms → ~45ms). What it
did **not** change is a deeper, latent limitation:

- **No cross-process consistency.** `hive_load()` never re-reads, so two running
  apps have divergent registry views; the file is only a handoff between process
  *lifetimes*. Fine for settings-on-exit apps (notepad/calc/winmine); wrong if
  anything ever needs a live shared registry.
- **Flat namespace, no enumeration, no types beyond what settings apps need.**
  `RegEnumKey`/`RegDeleteKey` are stubs-on-demand.

This is enough for today's users. 0162 asks: **do we want a real registry?** If
so, SQLite is the natural engine here.

## Why SQLite (and why not the alternatives)

- **SQLite is already vendored** (`vendor/sqlite`, full CRUD/CTE/FK test suite) —
  synchronous C, rides the existing OPFS-over-syscalls path with no async
  bridge. One transaction batches a settings burst into one commit; WAL gives
  `.LOG`-style crash recovery; file locking gives **real** cross-process
  consistency (multiple processes on one `.db`), which is the thing the current
  design can't do.
- **Not IndexedDB.** Async-only; the consumer is synchronous C over blocking
  syscalls. Would need a sync-over-async `Atomics.wait` bridge — the one foreign,
  async storage stack in an otherwise synchronous OPFS world. Rejected.
- **Not "just make the FS faster" (a kernel FS speedup).** Constant-factor only;
  doesn't address consistency or namespace.
- **Real-Windows reference:** the Config Manager keeps a memory-cached hive tree
  + write-ahead `.LOG` + lazy flush, kernel-owned and shared by all processes.
  SQLite-as-a-service is the closest tractable analog.

## Sketch (if pursued)

- A registry **service** (own process) over the existing agent-socket IPC (the
  `WM_AGENT_DIR` / `wmp` pattern `wmctl`↔`wm` already uses), OR a kernel syscall
  KV. All Reg* calls in advapi32.c become IPC to the one owner → single
  consistent view, one flusher.
- Backing store: one SQLite db, e.g. `values(keypath TEXT, name TEXT, type INT,
  data BLOB, PRIMARY KEY(keypath,name))` + a `keys(keypath)` table for empty
  keys; enumeration becomes a real indexed query. VFS wired to BlockFS.
- Keep advapi32.c's public API identical (the apps don't change).

## Cost / recommendation

Non-trivial: a service process + IPC + a SQLite VFS over BlockFS + fixing
`hive_load` to stop caching. **Do not do this for performance** — the batched
flush already solved that. Only worth it if we decide gucOS wants a genuinely
shared/queryable registry (e.g. a control panel that edits settings live for
running apps, `reg`-style tooling, or many-keyed subsystems). Until then the
text hive is "exactly enough." Parking here as a considered option.

## Acceptance (only if adopted)

- One consistent registry across processes (a value set by app A is visible to a
  concurrently-running app B), verified by a two-process e2e.
- Existing settings round-trip unchanged (notepad font, winmine board, calc
  layout persist across relaunch); Reg* API surface unchanged for apps.
- Enumeration (`RegEnumKeyEx`/`RegEnumValue`) backed by real queries.
- Crash-safe (WAL); no torn state; performance no worse than the batched hive.
