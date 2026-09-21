# 0163 — tty VEOF (Ctrl-D) must be transient, not sticky EOF

- **Status**: DONE (2026-07-12) — split transient VEOF (`_eofFlag`, consumed by
  one read via `Tty._consumeEof`) from latched hangup (`_hupFlag`, pty master
  close) in `kernel.js`; both brokered read-service sites consume the transient
  EOF. Regression in `tests/kernel/test_pty.js`; manual `term`→`lua`→^D verified
  (window survives, hush responsive). Pre-existing `test_recycle_e2e.js` failures
  are unrelated (reproduce on clean HEAD).
- **Design**: KERNEL.md (tty line discipline)

## Goal

Fix a P0 correctness bug in the shipped tty/pty line discipline: Ctrl-D
(VEOF) on an empty line sets a **sticky** EOF flag (`kernel.js` `Tty._eofFlag`,
commented "sticky EOF (v1)") that is never cleared. Every subsequent read on
that tty then also returns 0/EOF, so the EOF "leaks" from a foreground child
into its parent.

Reproduced in the browser: open `term`, run `lua`, press Ctrl-D. Expected —
lua exits, back at the hush prompt in the same window. Actual — lua's read
gets EOF and exits (correct), then **hush**'s next read on the same pty *also*
gets EOF and exits, the pty session ends, and the whole `term` window closes
(SIGHUP). One Ctrl-D closes everything.

Real termios: VEOF is a per-`read()` event, not a terminal state. It flushes
the pending line to the current read (0 bytes if empty) and is then gone — the
next read blocks for fresh input. Only a genuine **hangup** (pty master close)
latches EOF permanently (+ SIGHUP). gucOS conflated the two into one flag.

## Plan

Split the two conditions in `kernel.js`:

- Keep `_eofFlag` as the **transient** VEOF (Ctrl-D on empty line); consume it
  the moment a 0-byte read delivers it, so later reads park again.
- Add `_hupFlag` for the **permanent** hangup (pty master close, `_closeOfd`
  ptm branch) — stays latched, keeps SIGHUP.
- `Tty.readable()` counts either flag; a new `Tty._consumeEof()` clears the
  transient one (JS flag + `SI_EOF` word) but never the hangup.
- Both brokered read-service sites (`FS_READ` handler + `_serviceTtyReaders`)
  call `_consumeEof()` when returning EOF.

Standalone-SAB ttys have no parent-on-same-tty cascade (single process, no
kernel), so their SI_EOF handling is left as-is (out of scope).

## Acceptance

- `tests/kernel/test_pty.js` — new case: VEOF returns 0 to the current read,
  the next read PARKS (EOF did not latch) and wakes on new input; the existing
  master-close→EOF (permanent) case still passes.
- Manual: browser `term` → `lua` → Ctrl-D returns to the hush prompt, window
  survives (repro harness in `os/media/repro-lua.mjs`).
