# Minesweeper build-from-GitHub as a tap-to-run Desktop sample (image v163)

Ship the T5 kit (now notes/minesweeper-programming-rainbow.sh) as a Desktop-
discoverable sample: jku taps the script on the phone, a terminal opens, the
script curls the game source live from GitHub, `cc *.c`s it in-OS, and the
game window opens. The LIVE fetch+build is the demo — nothing pre-seeded.

## Seed (os/image.json, user section; version 162 → 163)

ONE file (jku's call: tap the script itself, no separate launcher):
`/root/Desktop/Presentations/samples/minesweeper-programming-rainbow.sh`
(0755, inline `content`) — the kit script, desktop-flavored:

- **`[ -n "$TERM" ] || exec term "$0"`** as the first line: a desktop tap
  spawns the `#!` file DIRECTLY (launch_activate → spawn_path) and
  spawn_path's env is a fixed {PATH, HOME} — no TERM — so the guard
  re-execs the script into a term window (term's child env sets
  TERM=xterm-256color, so the second pass proceeds; $0 is the absolute
  path — kernel shebang dispatch sets argv[0] to the spec path). NB
  `[ -t 1 ]` would NOT discriminate: the system tty is interactiveOut, so
  even the desktop-tapped headless child sees a tty-kind fd 1.
- **foreground `./minesweeper`**, not the kit's `./minesweeper &`: term
  ends the pty session when its session leader exits (term.c reaps →
  `exit(0)`; master close SIGHUPs the slave's fg pgroup), so a
  backgrounded game would be killed the moment the script finished. In a
  term session the foreground run also keeps the log visible while
  playing; quitting the game closes the window.
- a libpng guard: `[ -f /usr/include/png.h ] || … || gucman install
  libpng` — no-op on the fat image (libpng folds Built-in per T5), makes
  the sample survive a minimal (`--packages=none`) boot too.
- inline `content`, not a `text` asset: the browser user-seed fetches
  `text` assets by URL, so a new os/ static file would also need the
  external embedder's deploy allowlist — inlining keeps the deploy
  surface exactly image.json (the /etc/profile precedent).

Placement is jku's literal ask ("under Presentations/samples/ under
desktop"). Presentations is otherwise the decks folder; a top-level
Desktop icon was deliberately NOT added — it would shift the desktop grid
every geometry-pinned test derives from deskEntries().

## Verification

- `tests/kernel/test_minesweeper_sample_e2e.js` (registered, IMG): the seed
  present+0755 with the guard line, then the REAL gesture headless —
  dblclick Presentations on the desktop → fileman → keyboard-nav to samples
  → open the .sh → asserts a term window appears (the $TERM re-exec PROOF —
  the tap itself spawned headless) and that the script is executing (its
  pre-network `mkdir $HOME/minesweeper` as the marker). Network-free by
  design; stops before the curls.
- `notes/run-minesweeper-sample-demo.mjs` (manual, NOT swept — live GitHub
  + minutes of in-OS compile): the same tap in real Chromium off the
  freshly-baked v163, through curl → cc → the game window, screenshots in
  build/minesweeper-sample-shots/ (committed:
  tests/browser/shots-minesweeper-sample/). PASSED end-to-end 2026-07-25.

## Gotchas

- fileman row-click math is a trap: the listbox top is 36 (toolbar row) and
  the row pitch is font-derived — a computed row-3 center click landed on
  row 2. Drive rows by keyboard (click row 0 to focus, HOME/DOWN/ENTER),
  the fileman_nav "row-height-agnostic" pattern.
- back-to-back `wmctl click` at the SAME coords lands inside user32's 400ms
  double-click window (wmctl chains run in ms) → LBN_DBLCLK opens the row
  EARLY, then the scripted ENTER opens it again — the first demo run
  launched two terms and two games. Not a product bug (2s-apart clicks
  verified NOT to pair; a human's double-tap is one open) — drivers just
  shouldn't repeat a click where HOME suffices.
