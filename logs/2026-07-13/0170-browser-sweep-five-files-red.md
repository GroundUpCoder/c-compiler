# 0170 — browser sweep: 5 files red were 5 independent stale-TEST bugs

The 0165/0166 gate found 5 of 25 browser-sweep files failing on clean main
(os-drop, os-paint, os-shell, os-user32, os-wm). The 0170 item's leading
hypothesis was a single shared winbox/launch-path cause (three legs waited on
the winbox orange `255,140,0` that never arrived). **That was wrong.** Bisecting
os-wm (the 36s witness) over the suspect range showed the chord legs failed
byte-identically as far back as b56aee1 (0146) and 28fce87 (0102) — i.e. the
tests were never green in a real browser, only ever run headless-absent. Every
failure was a stale TEST assertion; **zero product code changed.**

## The five causes (all in `tests/browser/*.mjs`)

- **os-drop, os-shell** — hardcoded `DESK_ENTRIES`/`DESK` lists (7 names) missed
  `notepad`, which 785eca2 seeded into `/root/Desktop`. Every icon row shifted
  down one, so the derived `term`/launcher cells were wrong and the dblclick legs
  clicked empty desktop → the target window's orange never appeared. Fix: DERIVE
  the list from `os/image.json`'s user section — the exact todos/0166 rule the
  kernel e2e (`test_wm_service_e2e.js`) already followed; the two browser copies
  were simply never updated when 0166 landed. This is the same regression class
  0166 fixed, in a second location.
- **os-wm** (3 legs) — winbox toggles its fill green on the *bare* `Alt` keydown
  (the os-snap "one toggle per chord" rule — `winbox` flips on any keydown). So
  Alt+Space leaves winbox C **green**, not orange-unchanged. The test asserted
  fill-UNCHANGED and waited for orange. Rewrote the three chord legs to assert
  exactly-one-toggle (green = the swallow proof; a leaked Space would flip it
  back to orange), sample B's orange under C's vacated corner (not teal), probe
  a teardown point clear of A/B + drop shadows, and wait for each of the two
  no-WM toggles in turn.
- **os-paint** — `sample()` used canvas-LOCAL coords but every caller passed PAGE
  coords (`scr()`/`bmp()` already add the canvas origin) → it sampled the wrong
  pixel entirely; and the toolbox tap omitted the `+BAR` menu-bar offset. Fix:
  subtract the canvas rect inside `sample`, add `+BAR` to `tbCell`, and gate the
  tool/color picks on paint.c's `paint: tool=5` / `paint: fg=` tty markers
  (the 0083 event-wait rule) instead of blind sleeps.
- **os-user32** (3 legs) — (a) the two 0105 cursor-hover legs read
  `canvas.style.cursor` one gesture stale (a fixed 200ms sleep raced the
  SetCursor→SDL→RPC round-trip) → replaced with a poll-and-jiggle that waits for
  the style to settle; (b) modal dialogs are kernel-CASCADED — each open lands
  one slot further (`+40+60`, `+68+84`, `+96+108`), so the hardcoded `(120,100)`
  sample fell into the REOPENED Options dialog's navy title bar. The first two
  dialogs passed only by luck (their sample happened to land in-client). Fix: a
  `dialogGeom(title)` helper reads the live `WxH+X+Y` from `wmctl list` and
  samples BTNFACE at `x+w/2, y+40` (clears the ~20px chrome for any slot).

## Second bug, unmasked

Fixing os-drop's first leg exposed a latent one the early bail had hidden: the
persistence-reload leg reassigns `page = context.newPage()`, but `osHelpers(page)`
had captured the ORIGINAL page — so `setVt(1)` after the reload called
`evaluate()` on the closed page ("Target page, context or browser has been
closed"). `let`-bound the helpers and rebind `osHelpers(page)` right after the
reopen. (A latent trap for any future reload test — noted here, not generalized
into the harness this round.)

## Result

Final full `os-sweep.mjs`: green except os-shell's `(49,52)` leg, which is the
todos/0156 desktop-icon-rename failure — confirmed still separate (it wipes the
Desktop, so the DESK_ENTRIES fix doesn't touch it) and stays deferred under 0156.
Each of the five files also verified PASS in isolation.

One incidental flake seen: os-boots' "vi edits a file through xterm" leg failed
once in a sweep run (4.1s), passed solo — the known tty-veof-transient timing
class (logs/2026-07-12/tty-veof-transient.md), not a 0170 file and not touched
here.

No `flake.js` run: all changes are test-only, no frame/input **product** path
moved, and none of the flake tripwire files (os-doom/os-term, the wm/term/os_apps
kernel e2es) were edited.
