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
