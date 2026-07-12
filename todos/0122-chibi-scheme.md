# 0122 — Chibi Scheme as the official Scheme (R7RS REPL + script runner)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: this file. Precedent: `todos/done/0036` seeded the REPLs
  (lua/micropython/sqlite3 as vendor `bin.json` projects); this adds
  Scheme as a peer. Port-over-build: Chibi is small, self-contained C.

## Goal

Pick **Chibi Scheme** as gucOS's official Scheme implementation — small
R7RS-focused C, embeddable, designed for exactly this constrained
(static-linked, single-threaded) world. Unlike a REPL-only stub, land it
as a real interpreter from the start: `chibi-scheme file.scm [args]`
runs a script, no-arg is the REPL, seeded `/bin/scheme` (and/or
`/bin/chibi-scheme`).

## Plan

- Vendor `vendor/chibi-scheme/` with a hand-listed `bin.json` (no
  configure runner here — sqlite/lua precedent), pin upstream commit +
  patch table in a README.
- Build **static, no dlopen** (dlopen is stubbed, `compiler.js`): compile
  the needed C modules in rather than loading `.so` extensions. Chibi
  supports a static-module build — use it.
- Wire `sys/*` / file primitives to the veneer libc; make `load`/`import`
  find `.scm`/`.sld` on a sensible path (bundle the stdlib `.sld` files
  into the image under `/usr/share/chibi` or freeze as needed).
- argv → command-line handling: script file, `-e` eval, REPL fallback;
  interactive use works at the hush prompt and over ptys (mirror
  `tests/kernel/test_repl_pty_e2e.js`).
- Seed in image.json: `/usr/bin/chibi-scheme` + `/bin/scheme` alias,
  a `.scm` openwith association (default.term → scheme), Accessories/
  Demos menu entry; bump image version.

## Acceptance

- `echo '(display (+ 1 2))(newline)' | scheme` prints `3`;
  `scheme /root/hello.scm` runs a file; no-arg REPL works interactively.
- An `import`/`load` of a second `.scm` module resolves off the path.
- REPL e2e leg (piped EOF-clean + pty interactive), like 0036's REPLs.
- CLAUDE.md vendored-projects + REPL list updated; per-vendor README.
