# The registry hive stops eating your peers' settings (todos/0288)

`os/win32/advapi32.c` is the win32 registry: one text hive per user at
`$HOME/.win32reg`, loaded once per process into a linked list, written back
tmp+rename on flush (flushing batched to `RegCloseKey`/`atexit` since the
2026-07-12 batched-flush fix).

The bug was in the *write back* half: `hive_flush` rewrote the **whole file**
from the snapshot the process loaded at startup. That is whole-file
last-writer-wins across processes, and it fires in a completely ordinary flow:

> open winmine and notepad, close them in either order — the second exiter
> reverts the first's registry writes wholesale.

Three shipped apps write this hive today (`vendor/winmine/main.c`,
`vendor/notepad/settings.c`, `vendor/calc/winmain.c`), all reachable from the
Desktop and Start menu, so this was live data loss, not a latent hazard.

## Why it survived this long

`todos/0162` (registry backend: consider SQLite) existed, which made the area
look handled — and its status line asserted *"no current consumer; defer until
a live cross-process registry consumer exists"*. The consumers arrived
(winmine, notepad, calc) and nobody reopened the ticket. Worth naming twice:
*"there's no current consumer"* is verbatim one of the reasons `CLAUDE.md`'s
CORE PRINCIPLE lists as **not valid** for cutting scope, and here it hid a real
data-loss bug behind a ticket that looked like coverage. The premise was
corrected in 0162 on 2026-07-27 (the SQLite question itself stays parked, on
its own merits); this item is the cheap correctness fix it was blocking.

## The fix — reload-merge, not snapshot-rewrite

`hive_flush` now:

1. **re-reads** the hive (peers may have written since we loaded);
2. applies **our tombstones** — each value THIS process deleted since load
   (`g_dels`, new) is removed from the reloaded set;
3. applies **our dirty values** — each value THIS process set since load
   (`RegVal.dirty`, new) is written over its on-disk twin;
4. **unions the key sets** (keys are append-only here: there is no
   `RegDeleteKey`);
5. saves the merged set, and on success **adopts** it as this process's
   in-memory hive (dirty flags cleared, tombstones dropped) — so a long-lived
   app also picks up peer writes instead of drifting further from the file with
   every flush.

Everything else on disk survives byte-for-byte, **including records for values
this process merely read**. That last clause is the load-bearing one: a naive
"merge = write all my values over disk" would resurrect a value a peer had
deleted while we ran. Only *dirty* values are written back.

### The conflict decision (recorded on purpose)

When two processes both dirty the **same** `(key, name)`, the resolution is
**last-writer-wins per VALUE, decided at flush time**. That matches Windows for
an unsynchronised write pair — there is no merge to perform on one scalar — and
it makes the old failure (a process reverting a value it never touched)
impossible. Last-writer-wins *per file* was the bug; per value is the fix. A
delete counts as a write for this purpose: our tombstone removes the value even
if a peer re-created it after our delete, because our delete is the later
decision we hold. The rule lives in the header of `os/win32/advapi32.c` so the
next reader of that file finds it without archaeology.

### Deliberately still open

Writes since the last flush are still lost on SIGKILL (that is the price of the
batched flush — notepad's 27-value exit burst stays one tmp+rename), and there
is no advisory lock, so two flushes landing in the same instant still race on
the rename. The race window went from *a whole process lifetime* to *one
re-read plus one write*, which is the difference between "reproduces by opening
two apps" and "needs a debugger". A genuinely transactional store is `0162`.

## Test — the two-process race, both orders

`k32demo` grew a self-contained harness (`reg-set`, `reg-agent`, `reg-race`)
because the bug is fundamentally about *overlapping process lifetimes*, which a
sequence of `hush` commands cannot express:

- `reg-race FIRST SECOND` spawns two agents; each opens the hive (taking its
  snapshot), makes its mutation, touches a ready-file and **parks** on a
  go-file. Only when BOTH are ready does the driver release them one at a time
  in the named order, waiting for each to exit. So both snapshots predate both
  flushes — the real-world "two apps open at once" shape.
- The driver then reads the hive back. It has not touched the registry until
  that moment, so its own load is fresh (this matters: a driver that had
  flushed earlier would be reading its own adopted copy and could not see the
  agents' writes).
- An agent spec of `-NAME` **deletes** instead of writing, which pins the other
  half of the rule in both orders.

`tests/kernel/test_kernel32_e2e.js` session C runs four legs, wiping the hive
between them so a leftover value can't make the next leg pass vacuously:

| leg | first flush | last flush | asserts |
| --- | --- | --- | --- |
| `A B` | A writes | B writes | both survive |
| `B A` | B writes | A writes | both survive |
| `-Keeper W` | Keeper deleted | W written | delete survives the later flush |
| `W -Keeper` | W written | Keeper deleted | the writer doesn't resurrect Keeper |

Legs 1 and 2 fail on the pre-fix binary (the last exiter's whole-file rewrite
drops the first's value); leg 4 is the one that would fail on a sloppy merge.
