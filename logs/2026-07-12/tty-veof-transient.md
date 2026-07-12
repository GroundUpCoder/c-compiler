# tty VEOF (Ctrl-D) was sticky — one ^D closed the whole terminal (0163)

## Symptom

Open `term`, run `lua`, press Ctrl-D. Expected: lua exits, back at the hush
prompt in the same window. Actual: the entire `term` window closed to the bare
desktop, VT1 printed `[1] Done term`. One Ctrl-D killed lua *and* hush *and* the
terminal.

## Root cause

`kernel.js`'s tty line discipline treated VEOF (Ctrl-D on an empty line) as a
**latched** EOF — `Tty._eofFlag` was set once and never cleared (the code even
called it "sticky EOF (v1)"). `readable()` and both brokered read-service sites
returned a 0-byte read forever after. So:

1. Ctrl-D → `_eofFlag = true` (permanent).
2. lua's `read()` → 0 → EOF → lua exits. ✔
3. hush's next `read()` on the *same* pty → `_eofFlag` still true → 0 → hush
   sees EOF → hush exits. ✘
4. hush (pty session leader) gone → slave closes → `term` gets SIGHUP → window
   closes. ✘

The EOF "leaked" from the foreground child into its parent.

## What real termios does

VEOF is a per-`read()` event, not a terminal state: it flushes the pending line
to the *current* read (0 bytes if empty) and is then gone — the next read blocks
for fresh input. That's exactly why `cat`→Ctrl-D drops you back at the shell
instead of logging you out. The only *latched* tty EOF is a genuine **hangup**
(pty master close / carrier drop), which also raises SIGHUP.

## Fix

Split the two conditions gucOS had conflated into one flag:

- `_eofFlag` stays the **transient** VEOF, consumed by the one read that
  delivers its 0-byte EOF (`Tty._consumeEof`, which clears the flag + `SI_EOF`).
- new `_hupFlag` is the **latched** hangup — the pty-master-close path now calls
  `eof(true)`; `_consumeEof` never clears it.
- `readable()` counts either; both brokered read sites (`FS_READ` handler and
  `_serviceTtyReaders`) call `_consumeEof()` when they return EOF. A transient
  EOF thus wakes exactly one parked reader; a hangup wakes them all.

Standalone-SAB ttys (single process, no kernel) have no parent-on-same-tty
cascade, so their `SI_EOF` handling was left as-is.

## Verification

- `tests/kernel/test_pty.js`: new case — VEOF returns 0 to the current read, the
  next read **parks** (EOF didn't latch) and wakes on fresh input; existing
  master-close→EOF (permanent) case still green. Failed pre-fix, passes post-fix.
- All tty/pty/repl kernel tests pass (incl. `test_repl_pty_e2e.js`, which still
  asserts "^D exits the REPL" — the child still gets its EOF; it just no longer
  leaks upward).
- Manual browser (`os/media/repro-lua.mjs`): `term`→`lua`→Ctrl-D returns to the
  `~ #` prompt, `echo STILL_ALIVE` responds, window intact.

## Note

`tests/kernel/test_recycle_e2e.js` fails 6 checks (desktop bin-icon glyph /
context-menu) — pre-existing, reproduces on clean HEAD with this change stashed.
Unrelated to the tty path; flagged for separate triage.
