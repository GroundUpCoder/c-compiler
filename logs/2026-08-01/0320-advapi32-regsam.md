# #320 — advapi32: REGSAM enforcement + volatile keys

Ticket `#320` (W1-TC, gap #9): a `KEY_READ` registry handle could write —
`RegOpenKeyExW`/`RegCreateKeyExW` both `(void)sam`, so `RegSetValueExW`/
`RegDeleteValueW` on a read-only-requested handle mutated the hive, and
`REG_OPTION_VOLATILE` (which the header didn't even define) was silently
persisted.

## What landed

**REGSAM is real now.** `RegHandle` carries the REGSAM its open asked for;
enforcement is Windows-faithful in BOTH directions, not just the
write-refusal the ticket named:

- `KEY_SET_VALUE` gates `RegSetValueExW` / `RegDeleteValueW`;
- `KEY_QUERY_VALUE` gates `RegQueryValueExW` (a `KEY_SET_VALUE`-only
  handle can write but not read, like Windows);
- `KEY_CREATE_SUB_KEY` gates *creating* a new subkey through a handle
  parent (`RegCreateKeyExW` on an existing key is an open, checks nothing);
- refusals are `ERROR_ACCESS_DENIED`, checked after handle validation
  (`ERROR_INVALID_HANDLE` outranks it) and before any mutation.

There are no ACLs in this hive, so every request is grantable: enforcement
is purely "you get what you asked for". `MAXIMUM_ALLOWED` (new in
windows.h, real value 0x02000000) and the four predefined roots pass every
check. The full-enforcement choice is safe by construction for the corpus:
these are ReactOS ports written against real Windows, which enforces the
same masks — audited every caller anyway (winmine/calc/notepad/doom/
libgit2/kernel32-profile-shim/k32demo: all open read-ish to read and
write-ish to write).

**`RegOpenKeyW` opens `MAXIMUM_ALLOWED`, not `KEY_READ`.** The old
hardcoded `KEY_READ` was a trap armed by this very ticket: real Win32's
legacy no-sam API grants maximum access, and notepad reads its settings
through it — the day a port writes through a `RegOpenKey` handle it would
have hit a phantom `ERROR_ACCESS_DENIED` baked into the sub-API.

**`REG_OPTION_VOLATILE` keys are memory-only.** New constant (0x1) +
`ERROR_CHILD_MUST_BE_VOLATILE` (1021) in windows.h. A volatile key and its
whole subtree (a stable child under a volatile parent is refused with
1021, like Windows) never touch the hive file: mutations under one skip
the dirty/tombstone machinery entirely, `hive_flush` skips them at write
time as a backstop, and the flush's adopt-the-merged-set step SPLICES the
volatile keys + their values across instead of freeing them — a flush
must not evaporate a live volatile key (the in-demo test pins exactly
that: value still readable after a `RegCloseKey`-triggered flush). The
option decides at CREATE time only; reopening an existing key with it
changes nothing (also Windows).

Deliberate narrowing, recorded in the file header: real volatile keys are
machine-wide in-memory objects visible cross-process until reboot; this
hive's only sharing channel is the file, which volatile keys must never
touch, so here they are PER-PROCESS. No corpus app shares volatile state
between processes; revisit if one ever does.

## Tests

- `k32demo` grew `test_reg_access` (KEY_READ write/delete/create-subkey
  refused AND the hive unmutated; KEY_SET_VALUE writes-but-not-queries;
  KEY_WRITE writes; RegOpenKeyW handle read+write+delete — the
  MAXIMUM_ALLOWED decision pinned) and `test_reg_volatile` (create,
  in-process read-back, 1021 for a stable child, volatile child ok,
  survives a flush, option ignored on existing key), plus a
  `reg-vol-check` mode for the fresh-process probe.
- `tests/kernel/test_kernel32_e2e.js` session B now runs `reg-vol-check`
  on the SECOND boot: volatile key gone + persistent sibling
  (`K32Persist\Stay`) survived — the positive control that distinguishes
  "vanished" from "the reload read nothing" — + the KEY_READ-refused
  write absent from the file, + a `grep -c K32Vol` belt-and-braces that
  not one hive line mentions the volatile key.

`W4 — regedit-lite` is the permanent live customer for this surface.
0162 (SQLite hive backend) stays out of scope, as ticketed.
