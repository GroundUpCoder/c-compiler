# 0128 — manual UX bug sweep

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/OS.md` (the agent-target pillar + `wmctl`), the
  `tests/browser/os-*.mjs` sweep, and the 0073 desktop-apps dogfood format.

## Goal

A recurring, exploratory dogfood pass: interact with the live OS the way a
person would — launch apps, click through menus, play the games — TAKE
SCREENSHOTS, and actually LOOK at them for anything visibly or behaviourally
wrong. The automated `os-*.mjs` legs only assert pixels they already know to
expect; this turn hunts the bugs no golden covers. Output is repro tests +
fixes + an updated known-issues list, NOT a new feature.

## Step 0 — reseed the pipeline (do this FIRST)

This item keeps itself alive. On kickoff, count the OPEN copies:

    ls todos/*-manual-ux-sweep.md 2>/dev/null | wc -l   # includes THIS file

If fewer than **2** remain, add **3** more so 3–4 always sit further down the
queue (each at low priority so it never blocks feature work):

    node todos/queue.js add next --manual-ux --priority 2   # repeat x3

Then `node todos/queue.js check` and carry on. (`add next --manual-ux`
scaffolds a byte-identical copy of this item and appends it to the tail.)

## Plan

- **Boot the OS and get onto the desktop (VT2).** Two ways to drive it:
  - Real compositor (best for visual bugs): a Chromium session in the
    `tests/browser/os-*.mjs` style (`--enable-unsafe-webgpu`); switch to VT2
    with `window.__osVtSwitch(2)`, derive screen geometry from
    `window.__osScreen`.
  - Headless + screenshots (fast, no GPU visuals but full app logic):
    `node os/boot.js` driving the shell, `wmctl list/tree/shot/click/
    dblclick/keydown` for gestures, `wmctl shot <sid> out.ppm` for frames.
- **Exercise breadth, not depth.** A non-exhaustive rotation — cover a
  different slice each run and note what you skipped:
  - Shell & WM: Start menu + flyouts + search, desktop icons (select/drag/
    rename/marquee), right-click context menus, taskbar (buttons, clock,
    Show Desktop, right-click Cascade/Tile), Aero Snap, window min/max/close,
    Alt-Tab cycle, the screensaver.
  - Desktop apps: calc, notepad, paint, fileman (copy/cut/paste/rename/
    delete/Recycle Bin), ctlpanel applets, term, winmine.
  - Games / media: doom, quake, snake, sameboy & gameboy (a ROM through the
    .gb/.gbc association), the REPLs (lua/micropython/sqlite3).
- **Screenshot and eyeball.** For each windowed app, `wmctl shot` a frame (or
  grab a browser screenshot) and LOOK: garbled pixels, wrong colours, missing
  chrome, stuck frames, off-by-one layout, unreadable text. Note audio glitches
  where audible.
- **File every finding as a MINIMAL repro test FIRST** (conformance-corpus
  rule), then a fix as its own commit referencing this item. A finding you
  can't cheaply fix goes to the relevant known-issues list (`WM.md` /
  `WIN32.md` / the vendored app's README) with a repro — never silently
  dropped.

## Acceptance

- Step 0 done: 3–4 open `manual-ux-sweep` items exist; `queue.js check` passes.
- A dev-log entry (`logs/YYYY-MM-DD/manual-ux-sweep.md`) listing what was
  driven, the screenshots taken, and a fixed/deferred split of findings.
- New regression tests committed for everything fixed; known-issues lists
  updated for everything deferred.
- Close this item the normal way (Status line → move to `done/`, commit, push).
