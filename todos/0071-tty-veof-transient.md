# 0071 — tty VEOF is transient, not sticky (Ctrl+D in a REPL)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/KERNEL.md` (line-discipline; the "empty-line VEOF is
  sticky" v1 limit is called out there and in `kernel.js`).

## Goal

Ctrl+D at an interactive sub-program (a REPL like `lua`) should end
**only that program's** stdin, dropping back to the shell — exactly as a
real Unix tty behaves. Today it tears down the whole GUI terminal
window.

## Root cause (found)

`kernel.js` treats empty-line VEOF as **sticky, tty-wide** EOF. In the
line discipline, `V_EOF` on an empty line calls `Tty.eof()`, which sets
`_eofFlag = true` and `SI_EOF = 1` permanently (documented v1 shortcut,
`todos/KERNEL.md`: "empty-line VEOF is sticky"). Sequence:

1. `^D` → the REPL's `read` returns 0 → the REPL exits (correct).
2. The flag stays set → the shell's *next* `read` also returns EOF.
3. The shell exits → `os/term/term.c` reaps its only child (`waitpid`
   … `exit(0)`) → the terminal window closes.

Real VEOF is **transient**: it makes the *current* blocked/next read
return a short/zero result, then clears. EOF is per-read, not a latched
tty state.

## Plan

- Make empty-line VEOF one-shot: deliver a single 0-byte read to the
  reader waiting at the moment of `^D` (or the next reader if none is
  parked), then **clear** `_eofFlag` / `SI_EOF` so subsequent reads
  block for fresh input again.
- Audit every consumer of the flag: the ring/brokered read paths
  (`Tty.take`/`readable`/deferred-read RPCs), `select`/`FS_SELECT`
  readiness, and the `SI_EOF` shared-int probe. None may keep reporting
  EOF after the one-shot is consumed.
- Preserve genuine end-of-stream: an agent/host closing stdin for real
  (`Tty.eof()` from the bridge, not from a VEOF keystroke) should still
  latch — separate the "user pressed ^D" path from the "stdin closed"
  path so only the former is transient.
- Update `todos/KERNEL.md` to retire the "VEOF is sticky" v1 limit.

## Acceptance

- A kernel e2e (extend `test_jobctl_tty_e2e.js` or a new sibling):
  spawn a shell, launch a child that reads stdin, send `^D` — assert the
  child exits **and the shell keeps running and reads the next line**.
- A real-stdin-close case still latches EOF (no regression for pipes /
  agent-closed stdin).
- Manual: in the GUI terminal, `lua` → `^D` returns to the shell prompt;
  a second `^D` at the shell then exits the session (and closes the
  window) as before.
- Kernel + blockfs + browser suites green.
