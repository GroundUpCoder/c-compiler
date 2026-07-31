# #342 — gdidemo windowed scene: pen5 deleted while selected

**Ticket:** #342 (P0) · **Branch:** `0342-gdidemo-pen5`

## The bug

Every plain windowed `gdidemo` launch emitted on stderr:

    win32: unsupported DeleteObject on a selected pen/brush/font (refused — select it out first)

The report is the 0211 gdi32 net working correctly — the defect was in
`draw_scene()`'s own object discipline. Found by W0's #318 stderr sweep;
0211 policy is that the booted app suite emits zero win32 reports.

## Root cause

In `os/win32/gdidemo.c draw_scene()`, every created object followed the
select-out-before-delete idiom except one: `pen5` (the row-2 thick-X pen)
was selected into the DC and never selected out, so its `DeleteObject` in
the cleanup block was refused AND the pen leaked — once per WM_PAINT.
(`pen3` restores via `oldPen`; the last brush deselects via the single
`oldBrush` restore; `bm` restores via `oldBm`; `hatch`/`cbBlue` are only
ever FillRect args.)

## Fix

The #281 rule, surgically: capture the previous pen at the `pen5` select
(`oldPen5`) and `SelectObject` it back immediately after the second
`LineTo` — i.e. after the last drawing call that uses the pen, before any
later drawing. Nothing after row 2 strokes with the current pen, so the
restore point cannot change a drawn pixel; the e2e's exact-pixel probes and
the two-boot bit-exactness check (sessionA/A2/B) all still pass unchanged —
no probe was rebaselined.

## The pin

`tests/kernel/test_gdi32_e2e.js` only observed the selftest leg's stderr
(`/tmp/st.err`); the windowed launch was bare `gdidemo &`, so its stderr
went unobserved — exactly how this shipped. The windowed launch now
redirects to its own file (`/tmp/win.err`), cat between
`==winerr-begin`/`==winerr-end` markers after the shot, and a new check
asserts the file is EMPTY, printing the offending content on failure.

Deliberately scoped to the windowed file only: the selftest leg emits
`win32: unsupported SetMapMode(2) (MM_TEXT only)` on purpose and the #318
pin asserts its presence — a blanket "no win32: anywhere" assert would
contradict a landed pin. Two legs, two files, two opposite asserts, both
honest.

Red control: with the fix stashed, the suite fails exactly the new check
(1 FAILED); with the fix, full PASS.
