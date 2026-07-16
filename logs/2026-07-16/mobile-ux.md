# 0212 — Mobile UX: touch layer (long-press = right-click) + VT1 mobile affordances

Two independent features, each page-side only (os.html), each with its own
browser test. Zero kernel/WM/C change — that was the design constraint, and
it held.

## Feature 1 — the touch input layer (commit `os: touch input layer …`)

The desktop canvas listened to mouse events only; touch did nothing. The
fix is a page-side state machine that synthesizes the SAME `wm-input`
records the mouse handlers post, so the whole WM stack (context menus,
title drags, win32 WM_CONTEXTMENU-on-RBUTTONUP, wheel scrolling) works
under touch without knowing touch exists.

Design points that mattered:

- **The initial down is DEFERRED.** Sending it at touchstart would commit
  app state (start a title drag, arm a marquee) before the gesture is
  known. A tap sends down+up together at touchend; crossing the 10px slop
  flushes the down at the ORIGINAL point and becomes a live drag; the
  500ms timer firing unmoved sends right-button down+up (the UP is what
  opens win32 context menus) and swallows the rest — long-press-then-move
  is a menu, not a drag (the Windows-tablet convention).
- **Tap `t` = the touchstart timestamp**, so two taps inside 400ms read as
  the kernel double-click (icon launch, title-bar maximize) for free.
- **Two-finger pan = wheel records at the pair midpoint** (natural
  direction). Pinch is deliberately uninterpreted — opposing fingers
  cancel in the midpoint.
- **The gotcha: wheel needs a hover.** SDL fills a wheel event's mouse
  position from the app's *last mouse motion* — and a touch-only session
  never produces one, so the first implementation's wheels all landed at
  (0,0), i.e. notepad's menu bar, and the EDIT never scrolled. The touch
  layer now synthesizes a buttons:0 MOVE at the midpoint before each
  wheel (exactly what a physical pointer does by existing). Debugging
  this went kernel-ring → host drain → user32 with temp instrumentation;
  every layer was innocent — the input was semantically incomplete.
- `touch-action: none` + preventDefault suppress browser scroll/zoom AND
  the compatibility mouse events, so the mouse paths are byte-identical
  (os-wm/os-ctxmenu re-ran green as the boundary proof).

Test: `tests/browser/os-touch.mjs` — REAL touch emulation (CDP
`Input.dispatchTouchEvent` on a `hasTouch` context; `page.touchscreen` is
tap-only). Long-press menus on desktop/icon/taskbar-button, tap dismissal,
double-tap icon launch of notepad, exact-delta (+100,+80) title drag
verified through `wmctl list` geometry, and a two-finger pan that scrolls
notepad's EDIT.

Two test-authoring notes for the next reader:

- The EDIT's WM_SETTEXT puts the caret at the END and scrolls it into
  view (deliberate, 0048 lineage) — so a "dense lines at top" fixture
  shows blank filler after settext. The test puts the dense lines LAST
  (visible immediately) and pans toward the top.
- A dark-pixel census over notepad's EDIT must exclude the WS_HSCROLL
  strip at its bottom edge (0211 gave notepad's EDIT no-wrap styles) —
  the bar's chrome reads as "text" otherwise. That was a 188-pixel red
  herring wearing an M-row costume.

## Feature 2 — VT1 font steps + mobile key strip (commit `os: VT1 font-size steps …`)

VT1-only, isolated from the desktop path by construction:

- **A−/A+ in the tab bar** step `term.options.fontSize` through
  [12, 14, 18, 22, 26] with a live FitAddon refit (cols/rows change →
  the existing resize → TIOCSWINSZ path just works). An explicit choice
  persists in localStorage; with nothing stored, a narrow viewport
  (≤700px min-dimension) defaults to 18. Refit also rides
  orientationchange.
- **#keystrip** (Esc, Tab, sticky Ctrl, arrows, `| ~ / -`) shows under
  the terminal on VT1 when the UI is touch-capable or narrow
  (`body[data-touchui]`, kept fresh on resize/orientation). Keys feed
  the ordinary tty input path; ALL tty input now funnels through one
  `vt1Input` chokepoint so the sticky Ctrl composes with the soft
  keyboard too (Ctrl→`c` = ^C, Ctrl→`d` = ^D). `pointerdown` +
  preventDefault keeps xterm's hidden textarea focused, so pressing a
  strip key never dismisses the phone's soft keyboard.

Test: `tests/browser/os-vt1mobile.mjs` — every strip key proven by its
EFFECT in the booted OS, not a probe: Tab = hush completion, ↑ = history
recall (side effect counted via `wc -l`), Esc = a real vi mode switch
(`:wq` lands the file), sticky Ctrl+u/d = line kill / EOF; plus refit
column shrink, persistence across a reload, and the fresh-narrow-context
18px default. vi authoring note: keystroke echoes interleave cursor-move
escapes, so a typed string never appears contiguously in `__osOut` —
wait on vi's status line (`- FILE …` / `I FILE …`) and caret-position
markers instead.

## Gates

- image v99 baked + sealed (mkimage).
- kernel suite: 73/73.
- full browser sweep: 27/27 (both new files included; the mouse-driven
  os-wm/os-ctxmenu/os-vt legs are the "mouse desktop unchanged" proof).
- flake gate: both new files `--repeat 3 --under-load` → stable, 0%.

## Screenshots (booted OS)

- s3://groundupcoder/gucos/0212-touch-longpress-menu.png — the desktop
  context menu raised by a touch long-press (CDP touch emulation).
- s3://groundupcoder/gucos/0212-vt1-font-large.png — VT1 at 22px with
  the key strip and the A−/A+ tab-bar steps.
- s3://groundupcoder/gucos/0212-phone-vt1-keystrip.png — a 500×800
  phone-shaped viewport: 18px narrow default, the strip wrapped to two
  rows, shell fully usable.

## Deliberately not done

- No pinch gesture, no touch handling on VT1's xterm pane (xterm's own
  touch scrolling + the soft keyboard already work), no WM/kernel
  changes. The `WM_SETTEXT` caret-at-end behavior was NOTED but not
  touched — it reads as deliberate (0048/0211 lineage), and this item's
  boundary was page-side only.
