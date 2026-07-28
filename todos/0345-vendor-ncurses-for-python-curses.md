# 0345 — port ncurses over the gucOS tty so CPython's `curses` imports

- **Status**: open
- **Provenance**: **jku instruction** — `~/git/meta/meta/notes/jku-RULING-queue-stdlib-ports-bz2-lzma-curses-tkinter.md`
- **Blocked by**: `0340` (CPython vendor tree + expanded inittab)
- **Priority**: below `0343`/`0344` — this is the largest of the three ports

## Goal

Add a `vendor/ncurses/` port targeting the gucOS tty and build CPython's
`_curses` static extension against it, so `import curses` succeeds and a
`curses` program actually draws in `term`.

## What is established (measured, not assumed)

- `todos/CPYTHON.md:163` records `_curses` as **OUT of M1** — *"needs an ncurses
  port. Noted as an attractive later port over the gucOS tty, not scheduled."*
  jku has now **scheduled it**; that line should be updated when this lands.
- ✅ **There is already something to build against: `vendor/xterm` exists**
  (verified 2026-07-28). gucOS has a real terminal emulator, so the terminfo
  target is not hypothetical. **Read how `vendor/xterm` models the tty before
  designing anything** — do not invent a terminal abstraction.

## Why this is bigger than the two compressors

`0343`/`0344` are pure computation over byte buffers — no I/O, no environment.
`curses` is the opposite: it is **entirely** an I/O and terminal-capability
story.

- **terminfo/termcap database**: ncurses normally reads a compiled terminfo
  tree at runtime. gucOS needs either a vendored minimal terminfo shipped in
  the image, or a fallback-terminal build. **This choice is the ticket's main
  design decision — make it explicitly, do not let the build's default pick.**
- **Raw-mode input**: key handling, escape-sequence decoding, and resize
  (`SIGWINCH`) must line up with what the gucOS tty actually delivers.
- **The honest risk**: `import curses` succeeding is the *easy* half.
  A `curses` app that imports and then renders garbage is a worse outcome than
  one that fails to import, because it looks shipped. Acceptance below is
  written to make that impossible to claim past.

## Plan

1. Determine the terminfo strategy first (vendored minimal DB vs. built-in
   fallback), and write down which and why before touching the build.
2. `vendor/ncurses/lib.json`, wide-char build decided explicitly against what
   the gucOS tty supports (gucOS has display-only Unicode/UTF-8 shipped —
   check what that actually covers rather than assuming either way).
3. Add `_curses` to `0340`'s inittab expansion.

## Acceptance

- `cpython-clang -c "import curses"` succeeds **in-OS**.
- ⭐ **A real curses program runs and renders correctly in `term`, proven by a
  browser-sweep screenshot, not by an exit code.** Import success alone does
  NOT close this ticket.
- Arrow keys / a keypress path demonstrably reach the program.
- A resize is either handled or documented as a known gap **with a liability
  register entry** — an unhandled resize that nobody wrote down is exactly the
  gap this project's rules exist to prevent.
- Stdlib import-sweep count stated **before and after**.
- Update `todos/CPYTHON.md:163` ("not scheduled") in the same commit.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry, the gate goes RED — re-anchor or
  retire it in the same commit. If your work leaves a gap, file a ticket AND a
  register entry; a gap that does not enter `todos/` does not exist.
- Touching `vendor/` forces an image rebake ⇒ **full gate + an `os/image.json`
  bump, which the master assigns.** Executors never touch `os/image.json`.
