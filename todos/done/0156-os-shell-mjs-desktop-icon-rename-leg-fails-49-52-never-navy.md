# 0156 — os-shell.mjs desktop-icon rename leg fails: (49,52) never navy

- **Status**: done (2026-07-13)
- **Design**: `tests/browser/os-shell.mjs` (the todos/0103 desktop-icon
  rename-in-place leg); wm.c desktop layer + window placement.

## Resolution

TWO stacked test bugs; **wm.c exonerated** (a headless `wmctl shot` pixel
map of the exact gesture shows the selection working and the strip drawn
correctly — the 0175 loud-gate battery re-surfaced this file and the map
did the root-causing):

1. **The sample pixel sat on glyph ink.** The selected 3-char label strip
   spans x=47..67, y=48..58 with the white 'aaa' glyphs at y>=50 —
   `(49,52)` is the first 'a''s own white pixel, so the check could NEVER
   pass, occluded or not (both hypotheses in this item were beside the
   point for the pixel itself). Fixed: sample the strip's all-navy top
   padding row `(49,48)`.
2. **The desktop-focus click landed on the window soup** (the hypothesis-
   (b) part, confirmed on a fresh boot passing where the full run failed):
   the earlier legs' ctlpanel hub + notepads + winbox stay open, so
   `clickAt(500,400)` hit a window and ArrowRight never reached the
   desktop. Fixed: `pkill -9` the leftovers first — NOT `wmctl close`,
   whose close box on a MODIFIED notepad raises a modal save prompt that
   keeps focus (and cooperative SIGTERM can't wake a process parked in
   GetMessage).

`node tests/browser/os-sweep.mjs --filter=os-shell` green end-to-end
(106.5s), including the downstream 0151 spaced-name dblclick legs.

## Goal

The browser desktop-shell sweep (`node tests/browser/os-sweep.mjs
--filter=os-shell`) fails deterministically at the todos/0103 rename leg:

```
FAIL: pixel (49,52) never became 0,0,128; last 255,255,255
```

The leg (os-shell.mjs ~line 655-659) focuses the desktop on an empty cell,
presses ArrowRight to select the top-left icon ('aaa'), and waits for its
label strip to go navy at (49,52). Instead the pixel stays **white
(255,255,255)** — i.e. a window is composited OVER the top-left desktop
icon at that point in the run, hiding the selection highlight. Everything
up to this leg (Start menu, Control Panel hub, clipboard/notepad, taskbar
strip menu, Show Desktop) passes; this is the only failing check.

**Confirmed PRE-EXISTING and independent of todos/0132**: it fails
byte-identically on unmodified HEAD (verified 2026-07-12 by stashing the
0132 changes, rebaking the v75 image, and re-running — same
`(49,52) … 255,255,255`). Filed separately so 0132 (Start-menu
single-column) could close clean.

## Likely cause (to confirm)

By the rename leg the test has opened a Control Panel hub + two notepad
windows (clipboard section) and never closed them; one of those white
windows almost certainly cascades over the top-left corner (the icon 'aaa'
sits at the (46,x) cell). Either:

- **(a) a real wm.c placement regression** — a window now cascades onto the
  desktop's top-left icon column where it previously didn't (check the
  cascade counter / EV_SCREEN re-clamp), or
- **(b) a brittle test** — the leg assumed the top-left icon is unoccluded;
  the fix is to close the lingering hub/notepad windows before the rename
  leg (the winbox close-all at os-shell.mjs ~line 292 is the precedent),
  or select/sample an icon cell known to be clear of the open windows.

Determine which before fixing: if a window genuinely lands on the icon
that a user would interact with, that's the (a) bug and belongs in wm.c;
if it's only the test's accumulated window soup, close them first (b).

## Acceptance

- `node tests/browser/os-sweep.mjs --filter=os-shell` passes the rename
  leg (label strip navy at the icon), with the root cause identified as
  (a) or (b) and fixed at the right layer.
- No new flake: `node tests/flake.js --filter=os-shell` (if added to the
  tripwire set) or a `--repeat` run stays green.

## Notes

- Found while landing todos/0132 (Start-menu single-column); the 0132
  Start-menu legs of this same file all pass. Filed P0 per the
  shipped-feature-bug policy (a failing browser acceptance leg).
