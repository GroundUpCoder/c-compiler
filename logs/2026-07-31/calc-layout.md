# calc layout lane — #311 rc NOT drop + #310 MENU_BAR_H round-trip

One lane for both P0s because they collide: both live in calc's scientific
dialog and both move numbers in `test_calc_e2e.js`. Order was ruled #311
first — it changes which controls are visible inside the dialog #310
re-measures, and it regenerates the committed `.res` sidecars — so the e2e
was re-pinned exactly once, at the end, from a live boot.

## #311 — rc `NOT` clears bits from the RESULT (af451b56)

rc semantics are "default | given, then clear the NOT-listed bits from the
RESULT". win32rc resolved NOT intra-expression only, twice over:
`styleExpr`'s accumulator applied `acc & ~v` (a bare `NOT WS_VISIBLE` tail
= `0 & ~V` = 0, silently dropped at `style | 0`), and even a combined NOT
could never reach the control KEYWORD's default bits — which is NOT's main
real-world use. Fix: `styleExpr` returns `{or, not}` masks and the
control/dialog assembly applies `(default | or) & ~not` (`applyStyle`).
`evalExprString` got the same treatment so a `#define`-carried NOT behaves
like the inline spelling, plus `numToScalar` fails LOUD when a NOT-bearing
value reaches a non-style context (dimensions, ids).

Drive-by within the same mechanism: `evalName` only chased
single-identifier aliases or digit-leading expression bodies — an
identifier-leading `#define` body (`NOT WS_VISIBLE`, or even
`WS_CHILD | WS_VISIBLE`) threw "undefined identifier" on the whole string.
It now hands any non-identifier body to the evaluator.

Blast radius (the ruled sweep): NOT appears in exactly ONE port — calc, 7
sites. Regenerating all three sidecars moved exactly those 7 styles
(4 width radios + the 3 hidden `IDC_BUTTON_FOCUS` DEFPUSHBUTTONs, which
had also been painting as a stray button at the origin);
notepad.res/winmine.res byte-identical, `win32ports.js --check` green.

Red control: `tests/kernel/test_win32rc.js` — 6 of its checks watched FAIL
on the unfixed tree (bare NOT, default-bit reach, result-not-sequential
semantics, the #define crash) before the fix turned them green.

## #310 — GetWindowRect/GetWindowPlacement report the SURFACE rect (417f5917)

The pair was asymmetric on a menued top-level: `GetWindowRect` returned
`GetClientRect` (excludes the in-surface menu bar) while `MoveWindow`
passes w/h to `SDL_SetWindowSize` (the surface, includes the bar), so any
read-modify-write shrank the window by `MENU_BAR_H` (30px). calc's
WM_INITDIALOG "restore at the same position" hit it on every dialog
recreate.

Direction picked: the GETTERS report client + bar — the rect the setters
accept. Rationale: the rest of the tree already speaks surface semantics —
`dlg_create` creates the SDL window at client+bar, `AdjustWindowRect`
already adds `MENU_BAR_H`, `MoveWindow`/`SetWindowPlacement` set surface.
Making `MoveWindow` client-relative instead would have broken both.
Audit of the named set:

- `AdjustWindowRect` — already surface-consistent, untouched.
- `SetWindowPos` — declared in windows.h, NO implementation, NO corpus
  callers (calc/notepad/winmine). Nothing to audit; stays a link-time
  loud failure.
- `SDL_SetWindowSize` callers — MoveWindow (fixed pair) and the menu-bar
  popup strip (bar-sized, unrelated).
- `GetWindowPlacement` had the SAME bug (read `GetClientRect`, restore
  via `MoveWindow`): notepad saves placement to the registry and restores
  it at startup, so its menued main window shrank 30px per SESSION. Now
  reads `GetWindowRect`. Its doc comment claimed "size round-trips" — the
  comment described the intent, not the code.
- Child-window `GetWindowRect` consumers (notepad/fileman status bars) —
  child path unchanged.

Red control: the e2e grew a three-recreate cycle (Scientific → Standard →
Scientific) with per-recreate no-control-exceeds-client checks. On the
unfixed tree all 5 new checks failed with exactly the predicted values:
869x540 client with the keypad row bottom at 553, standard recreate
464x448, scientific recreate 869x570.

## The pin was the bug's fossil

`test_calc_e2e.js` pinned 869x570 — the POST-shrink surface, re-pinned by
arithmetic during C2 with no screenshot. The new pin 869x600 was read off
the test's own live `wmctl list` row (`869x600+40+60`), not derived; the
standard-recreate pin 464x478 likewise. A number re-derived by arithmetic
from a running system is not a measurement of that system.

## Evidence pair (in-OS, wmctl shot composites)

- before: `logs/2026-07-31/0275-lb-vscroll/calc-scientific-clip-evidence.png`
  (869x570: Dv/rd radio bleed-through, bottom row cut mid-button)
- after: `logs/2026-07-31/calc-layout/calc-scientific-after.png`
  (869x600: one radio set, full bottom row)

Image bumped ONCE to v207 (both tickets change seeded runtime content;
the bump rides the #310 commit).
