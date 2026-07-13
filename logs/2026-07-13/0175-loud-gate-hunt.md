# 0175 — the loud-gate hunt: 5 kernel e2es were green on dead clocks (+ 0156 falls)

The 0175 gates landed (driveBoot throws on any `wmctl: wait ... timed out`
in a boot's output; `waitForServer` throws a named stale-serve.js error
instead of returning false) and the point of landing them was the HUNT:
re-run the whole kernel suite + browser sweep and see which green tests
were quietly burning dead timeouts. Five were.

## What the gate found (and what each really was)

**The 0171 closed-menu rule claimed three boot barriers.** winmine (×2:
"Advanced", "Exit") and paint ("Filled Rectangle") gated boot on `wmctl
wait label <closed-menu item>` — comments claiming "the item resolving
means the menu is built". AQ_GETTEXT deliberately resolves HWNDs + OPEN
menus only (0171: otherwise paint's `wait label Save` would match
File>Save's tab-cut forever), so these waits have been unsatisfiable since
0171 landed — 10-12s of dead clock per boot, invisible because the app WAS
up by then and later assertions passed. The right barrier is `wait label
<window title>`: top-level window TEXT resolves through the agent socket
exactly when the app is pumping/serving (probed: `Advanced`/`Game` DEAD,
`WineMine` OK). AQ_CLICK on closed-menu items still works — click and
GETTEXT visibility are different by design; a barrier must use the latter.

**gdi32's "two distinct presents" premise was false.** gdidemo paints once
per instance (WM_PAINT when the queue is dry; nothing ever re-invalidates
it) — probed `wait seq` 1 OK / 2 DEAD / 3 DEAD. So the in-boot second shot
re-read the SAME present and the "repeated paints are bit-exact" check
compared a buffer with itself. Fixed by taking shot2 in a SECOND boot: an
independent instance's paint, which is the stronger determinism claim
anyway.

**user32: CLASS:n indexes the whole tree.** The Options-dialog leg typed
into the focused dialog edit but waited on `EDIT:0` — the main window's
single-line edit (its two EDITs enumerate before the dialog's; typed text
lands in EDIT:2, probed via gettext).

**fileman: exact-title counting vs the 0106 title.** `wait count "File
Manager" 2/1` assumed the main window matches "File Manager", but 0106
retitled it "File Manager - <cwd>" and `wm_count_title` is exact strcmp —
the EROFS error box is the ONLY exact match, so the count never left 1/0.
`wait win`/`wait nowin` on the box's title is both correct and clearer.

The dead clock was real wall time: gdi32 7.0→1.5s, winmine 18.8→9.4s,
paint 18.7→7.1s, fileman 26.6→12.8s per run, every run.

## 0156 fell to the same technique

The sweep re-run re-surfaced the deferred 0156 os-shell red ("(49,52)
never navy"). A headless repro of the exact gesture + a `wmctl shot`
pixel map settled what two hypotheses (wm.c placement bug vs window
occlusion) hadn't: the selected label strip IS drawn (wm.c exonerated),
but (49,52) sits on the first 'a' glyph's own white ink — unpassable
regardless of occlusion. AND the full run separately fails to focus the
desktop at all: the accumulated hub/notepad/winbox soup swallows the
focus click (fresh-boot probe passes, full-run fails). Two fixes: sample
the strip's all-navy padding row (49,48), and `pkill -9` the leftovers
first — `wmctl close` is wrong there because a modified notepad's close
raises a modal save prompt that keeps focus, and SIGTERM can't wake a
process parked in GetMessage.

## Process notes

- The wt-head worktree battery needed playwright: this repo does NOT
  declare it (only `webgpu`); it resolves via a `node_modules/playwright`
  symlink → the sibling checkout's real install. A dangling symlink to the
  (empty) pnpm-global dir cost one full sweep of ERR_MODULE_NOT_FOUND.
- The gate's error dedups identical timeout lines, which hides
  multiplicity (fileman's two distinct waits printed as two lines only
  because the timeouts differed; gdi32's seq 1-vs-2 was ambiguous until
  probed). Acceptable — the message names the CONDITION, and the probe
  script settles the rest.
- `wmctl wait` probes compose well as a diagnosis harness: a driveBoot
  script of `wait X 2000 && echo X-OK || echo X-DEAD` lines answers
  "what is resolvable HERE" in one boot.
