# 0297 — BLOCK_FS Immediate: C-level tests for the 10 untested WASM imports

- **Status**: open
- **Design**: `todos/BLOCK_FS.md:286` (the "Immediate" checklist item and the list of
  imports it refers to).

## Goal

Write the C-level unit tests that `BLOCK_FS.md` has listed as **"Immediate"** without anyone
picking them up.

`todos/BLOCK_FS.md:286`:

```
### Immediate
- [ ] **C-level unit tests for the 10 untested WASM imports** listed above.
  Each is ~10 lines of C + `{"blockFs": true}` in config.json.
```

## Why this is a good example of the class

It is filed under a heading **literally named "Immediate"**, it sits in an otherwise all-`[x]`
list, and it carries a **self-assessed cost of ~10 lines of C each**. `grep -i "untested WASM
imports"` over tickets → **0**. Cheap, marked urgent, in a maintained-looking list, and still
unscheduled for want of a ticket id.

The surrounding fuzz/fsck estate is genuinely strong — **which is exactly what makes this hole
easy to overlook.** A strong neighbourhood lends unearned confidence to the untested corner.

## Status of the facts

**Inventory-only** — the sweep read the doc and grepped the ticket DB; it did not re-verify that
all ten imports are still untested. **First step: re-check the list against current code**, since
some may have gained coverage incidentally.

## Plan

- Re-verify which of the ten are still untested; update the list in `BLOCK_FS.md`.
- Write the ~10-lines-of-C test per remaining import, with `{"blockFs": true}` in `config.json`
  as the doc describes.
- Tick the checklist item and cite this ticket id next to it, so the doc stops carrying an
  unfunded "Immediate".

## Acceptance

- Every WASM import in the BLOCK_FS list has a C-level test, or is documented as covered
  elsewhere with the pointer.
- `BLOCK_FS.md:286` no longer shows an unchecked "Immediate" item.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.

## VERIFICATION (cont-78, 1e8a940)

**Verdict: PARTIALLY CONFIRMED — the count is wrong. 6 of the 10 are still
untested at C level; 4 have gained C-level tests since the doc was written.
But only ONE of those 4 runs under `{"blockFs": true}`, so the block-fs import
path specifically is still uncovered for 3 of them.**

### The 10 imports

They come from `todos/BLOCK_FS.md:246-259`, the table headed "### Test gaps — not
yet covered", which `:286`'s "Immediate" item refers to as "listed above":
`fchmod`, `utime`, `fcntl F_DUPFD`, `fsync`, `lstat`, `pipe`/`dup`/`dup2`,
`isatty`, `access`, `fstat`, `getcwd`.

### Per-import status (call-shaped grep over every `.c`/`.h` under `tests/`)

| # | Import | C-level test today | Where | `blockFs: true`? |
|---|---|---|---|---|
| 1 | `fchmod` | **NO** | — (`tests/unit/blockfs_chmod/main.c:8` calls `chmod`, not `fchmod`) | — |
| 2 | `utime` | **NO** | `utime()` is never called anywhere in `tests/`. `utimes()` is covered at `tests/unit/core/utimes/utimes.c` and `tests/unit/core/stat_fields/stat_fields.c` — different entry point, and **neither has a `config.json`**, so neither runs in block-fs mode | — |
| 3 | `fcntl` F_DUPFD | **NO** | no `fcntl(` call in any C test file | — |
| 4 | `fsync` | **NO** | — | — |
| 5 | `lstat` | **NO** | — | — |
| 6 | `pipe`/`dup`/`dup2` | **PARTIAL — YES for pipe/dup/dup2** | `pipe`: `tests/unit/stdlib/poll_pipe/poll_pipe.c`, `tests/unit/blockfs_select_pipe/main.c`, `tests/unit/stdlib/select_pipe/select_pipe.c`. `dup`+`dup2`: `tests/unit/stdlib/posix_dup_shared_offset/main.c:16,26` | `poll_pipe` **yes** (`{"blockFs": true}`), `blockfs_select_pipe` **yes**; `select_pipe` and `posix_dup_shared_offset` have **no** config.json |
| 7 | `isatty` | **YES** | `tests/unit/stdlib/isatty_pipe/main.c:8,10` | **no** — `{ "subprocess": true }` |
| 8 | `access` | **YES** | `tests/unit/stdlib/posix_dir/posix_dir.c:53-54` | **no** — no config.json |
| 9 | `fstat` | **NO** | only `tests/manual/large_file.c` (manual corpus, not a suite test) | — |
| 10 | `getcwd` | **YES** | `tests/unit/stdlib/posix_dir/posix_dir.c:11` | **no** — no config.json |

### The precise count

- **6 of 10 still have no C-level test at all**: `fchmod`, `utime`,
  `fcntl F_DUPFD`, `fsync`, `lstat`, `fstat`.
- **4 of 10 gained a C-level test**: `pipe`/`dup`/`dup2`, `isatty`, `access`,
  `getcwd`.
- Of those 4, **only `pipe` is exercised under `{"blockFs": true}`**
  (`tests/unit/stdlib/poll_pipe`, `tests/unit/blockfs_select_pipe`). `dup`/`dup2`,
  `isatty`, `access` and `getcwd` are tested only in the DEFAULT backend, so the
  block-fs WASM import that this checklist item is about is still unexercised for
  them.

So the remaining work is **6 new tests + 4 cheap `{"blockFs": true}` variants**
(or one `config.json` addition where the existing test can safely run in both
modes) — not 10 tests, and not 4 items already done.

### Doc drift found while checking

`BLOCK_FS.md:248-259`'s wording is now wrong in two rows and should be corrected
in the same commit as the fix:
- `pipe`/`dup`/`dup2` and `isatty` and `access` say "Only JS-level tests, no
  C-level unit test" — a C-level test now exists for each (see table).
- `getcwd` says "Only tested via error path (chdir), not normal operation" —
  `posix_dir.c:11` exercises the normal path.

The `Totals` line at `BLOCK_FS.md:243-244` ("97 dedicated tests + 575 existing
unit test regression suite = 672 passing tests") was **not** re-counted here and
is very likely stale too.
