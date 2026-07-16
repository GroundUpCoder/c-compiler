# 0215 — the sysmenu leg's "black pixel" was the test's own click mark

The os-wm sysmenu leg (the 0102 Alt+Space chord-swallow proof) failed 3/3
under load: `pixel (296,208) never became 0,200,80; last 0,0,0`. The todo
suspected the popup overlapping the probe or a mid-redraw sample — both
wrong, and worth writing down because the real cause is a *class*, not a
one-off.

## What actually covered the probe point

A scratch grid dump at the timeout showed an exact 8x8 black square at
(292,204)–(299,211), green on every side. That is winbox's persistent
MOUSE_BUTTON_DOWN paint, dead-centered on the probe pixel — which is also
exactly where the leg had clicked "to focus C" (CX+200, CY+100). So the
swallow semantics were CORRECT (one Alt toggle, Space eaten, fill green);
the probe was reading the test's own click paint.

## Why it passed serially and failed under load

Two interacting facts:

1. The "C composited" wait probed (CX+200, CY+100) — a point inside B's
   client as well (B: x 68–308, y 84–244). B was orange there, so the wait
   was satisfied *before C even mapped*.
2. Map-on-placement (0069): until the wm's placing MOVE, C is skipped by
   the hit test. So the focus click landed on *whichever window the hit
   test found at that moment* — a race between the Playwright click's CDP
   round-trips and C's spawn→create→map pipeline in the kernel worker.

Serially the click usually won (C not yet created): it landed on B, whose
mark C then covered — green probe, pass. Under load the browser-side
driver starves while the kernel worker proceeds, C maps first, the click
lands on C, and the mark is painted at C-local (200,100) = the probe
pixel. Hence 100% under load, occasional serial bites.

## Fix (test-only; the A/B chord leg already had it right)

Reorder to sync on the observable map/focus event, per 0171: wait for C's
focused NAVY TITLE first (a title composites only once mapped, and
create-focus is kernel mechanism, so navy at C's title row proves both),
then confirm C's orange fill at the probe point, then click — moved to
(CX+30, CY+30), on C but clear of every later probe, because a winbox
click paints a permanent mark wherever it lands. `waitPixel` grew an
optional `what` label so a timeout names what the pixel was supposed to
be instead of just its coordinates.

Lesson for future pixel legs: any "window N composited" wait must probe a
point NOT covered by an earlier window (or wait on the title, which is
unambiguous), and any click on a winbox must budget for the mark it
leaves. The click-races-map pattern is worth grepping for when a pixel
leg flakes only under load.

Gate: `--filter=os-wm --repeat 3 --under-load` 3/3 stable (flake 0%);
full browser sweep 27/27. No C sources touched — no bake, no image bump.
