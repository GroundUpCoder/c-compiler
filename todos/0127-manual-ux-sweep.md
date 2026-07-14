# 0127 — manual UX bug sweep (THE consolidated human dogfood pass)

- **Status**: deferred (mass-deferred 2026-07-12; was: open). Rewritten
  2026-07-15 by the queue reconciliation: this is now the ONE open manual
  sweep — it absorbed the byte-identical clones 0128/0129/0142/0143/0144
  and the desktop-apps behavior sweep 0073 (its checklist + seeded findings
  folded in below; all six closed pointing here). The reseed rule changed
  with it: exactly ONE successor, seeded at close (the queue.js `--manual-ux`
  scaffold now says the same) — never a stockpile.
- **Design**: `todos/OS.md` (the agent-target pillar + `wmctl`), the
  `tests/browser/os-*.mjs` sweep, and the todos/done/0033 dogfood format
  (WM rounds 0039/0064 are the siblings).

## Goal

A recurring, exploratory dogfood pass: interact with the live OS the way a
person would — launch apps, click through menus, play the games — TAKE
SCREENSHOTS, and actually LOOK at them for anything visibly or behaviourally
wrong. The automated `os-*.mjs` legs only assert pixels they already know to
expect; this turn hunts the bugs no golden covers. Output is repro tests +
fixes + an updated known-issues list, NOT a new feature.

## Reseed rule — ONE open copy, successor seeded at close

There must only ever be **one open copy** of this sweep (the 2026-07-15
reconciliation consolidated seven overlapping copies — don't rebuild the
pile). At CLOSE time, as part of the closing commit:

    ls todos/*-manual-ux-sweep.md   # must list ONLY this file
    node todos/queue.js add next --manual-ux --priority 2   # exactly once

Then `node todos/queue.js check` and close this one. Note in the
successor's body which rotation slices this run covered, so the next run
starts on a different slice.

## Plan

- **Boot the OS and get onto the desktop (VT2).** Two ways to drive it:
  - Real compositor (best for visual bugs): a Chromium session in the
    `tests/browser/os-*.mjs` style (`--enable-unsafe-webgpu`); switch to VT2
    with `window.__osVtSwitch(2)`, derive screen geometry from
    `window.__osScreen`.
  - Headless + screenshots (fast, no GPU visuals but full app logic):
    `node os/boot.js` driving the shell, `wmctl list/tree/shot/click/
    dblclick/keydown` for gestures, `wmctl shot <sid> out.ppm` for frames.
- **Exercise breadth, not depth — the rotating checklist.** Cover a
  different slice each run and note what you skipped:
  - Shell & WM: Start menu + flyouts + search, desktop icons (select/drag/
    rename/marquee), right-click context menus, taskbar (buttons, clock,
    Show Desktop, right-click Cascade/Tile), Aero Snap, window min/max/close,
    Alt-Tab cycle, the screensaver.
  - Desktop apps: calc, notepad, paint, fileman (copy/cut/paste/rename/
    delete/Recycle Bin), ctlpanel applets, term, winmine.
  - Games / media: doom, quake, snake, sameboy & gameboy (a ROM through the
    .gb/.gbc association), the REPLs (lua/micropython/sqlite3).
  - **App BEHAVIOR depth (the 0073 slice)** — the Unix/Win95-correctness
    details feature items skip:
    - term: control chars (^C/^D/^Z/^\\), EOF vs shell exit, resize/SIGWINCH
      reflow, alt-screen restore, job-control interplay.
    - notepad / calc / fileman / ctlpanel: keyboard focus & tab order,
      clipboard, dialog cancel paths, window close vs app quit, error
      dialogs on bad input.
    - gameboy/sameboy: ROM open via association, input focus, exit.
- **Screenshot and eyeball.** For each windowed app, `wmctl shot` a frame (or
  grab a browser screenshot) and LOOK: garbled pixels, wrong colours, missing
  chrome, stuck frames, off-by-one layout, unreadable text. Note audio glitches
  where audible.
- **File every finding as a MINIMAL repro test FIRST** (conformance-corpus
  rule), then a fix as its own commit referencing this item. A finding you
  can't cheaply fix goes to the relevant known-issues list (`WM.md` /
  `WIN32.md` / the vendored app's README) with a repro — never silently
  dropped.

## Seeded findings carried from 0073 (start a behavior-slice run here)

Deliberate v1 shortcuts recorded at 0048's landing; each is sweep fodder to
either fix or formally accept into a known-issues list. Cross-check against
the open EDIT-completeness items (0133–0137 own the EDIT gaps; don't
duplicate work they already track):

- **EM_GETHANDLE non-ASCII padding**: the materialized WCHAR view is sized
  by the UTF-8 length (tail-zeroed), so notepad saves of non-ASCII documents
  can append NUL padding — ASCII round-trips exactly (user32.c
  edit_sync_handle comment).
- **OFN hooks/templates are not run**: notepad's Save As encoding/EOLN
  combos never appear; encoding silently stays at its previous value
  (comdlg32.c header records the call). Sibling: todos/0145 owns the silent
  no-op feedback class.
- **MessageBox knows OK/OKCANCEL/YESNOCANCEL/YESNO only** —
  ABORTRETRYIGNORE falls back to a bare OK (user32.c BTNSETS).
- **Status bar draws no size grip** (SBARS_SIZEGRIP accepted, ignored);
  IsDialogMessageW is ESC-only (no Tab order — the 0058 simplification).
- **notepad opens existing files cleanly now** (verified 2026-07-12 menu
  audit, `logs/2026-07-12/queue-hardening-and-keymap.md`) — the lock-in
  regression test (title + EDIT content + no `#32770`) is still owed.
- **ctlpanel**: volume is master-only (per-source gain can grow on the same
  AUDIO_GAIN opcode if a mixer panel wants it).
- (Retired from the 0073 list as since-owned elsewhere: EDIT undo →
  todos/0135; fileman rename/delete/copy → shipped by todos/done/0092/0106.)

## Acceptance

- A dev-log entry (`logs/YYYY-MM-DD/manual-ux-sweep.md`) listing what was
  driven, the screenshots taken, and a fixed/deferred split of findings.
- New regression tests committed for everything fixed; known-issues lists
  updated for everything deferred.
- Exactly ONE fresh `manual-ux-sweep` successor seeded at close (with the
  covered-slices note); `queue.js check` passes.
- Close this item the normal way (Status line → move to `done/`, commit, push).
