# gucOS #69 (D6): default auto-2x on mobile viewports + "Desktop site" toggle

Branch `mobile-2x-default` off v129 (eb9e9a8). Page-side only; HOLD-DEPLOY —
bundled into the next gucOS bake by the coordinator.

## What

With nothing persisted, a phone-shaped viewport now boots the VT2 desktop at
the shipped integer zoom's 2× instead of 1×; a "Desktop site" tab-bar toggle
(the standard mobile-browser affordance) flips back to the unzoomed 1× desktop
— and back — with the choice persisted so it overrides the auto-default on
every later boot. Desktop-shaped viewports are untouched: 1×, nothing stored,
no new controls visible.

## Why it's shaped this way

- **~80% of this slice had already shipped.** The VT2 integer-zoom mechanism
  (backing store = floor(pane/Z), CSS-pinned display, pixelated upscale, the
  /Z pointer seam) and the 26px VT1 font bump are live since v126–v129. D6 is
  purely the *defaulting + toggle policy* over that mechanism: the only code
  that changed is os.html's zoom-factor *selection* (init default + a new
  control that calls the existing `vt2SetZoom`). The compositor, wm.c, the
  zoom mechanism itself, and compiler.js are untouched.
- **The mobile signal is the VT1 font default's predicate, not touchUiSync.**
  Two "mobile" signals exist page-side: `touchUiSync`'s touch-or-narrow
  predicate (shows the key strip / zoom controls) and the VT1 font default's
  `min(innerWidth, innerHeight) <= 700` phone-shaped test. The auto-2x uses
  the latter, deliberately: a touch-capable *wide* viewport (tablet, touch
  laptop — and os-vt2zoom.mjs's 820×1040 hasTouch context, which asserts a
  Z=1 default) should get the mobile *controls* but keep desktop-density
  defaults. Only genuinely phone-sized viewports get bigger-by-default. This
  is the exact saved-else-viewport-default shape the 26px font bump shipped
  with, now extracted as one shared `mobileViewport()`.
- **Boot-time only.** The default is evaluated once at page-script init.
  Mid-session viewport resizes (os-screen.mjs shrinks to 760×680, min ≤ 700)
  never re-evaluate it — resizing a desktop window must not yank the zoom.
- **Persistence is the existing key, absence = auto.** `gucos.vt2.zoom`
  stays the single store; an *absent/invalid* key now means "auto by
  viewport" instead of hard 1. The toggle routes through `vt2SetZoom`, which
  already persists — so "explicit choice beats auto-default" falls out with
  zero new storage. The auto-default itself is deliberately NOT written back,
  so a user who never chose keeps tracking the default.
- **Toggle semantics:** at Z>1 → 1× (lit "on"); at 1× → 2× (the mobile
  default). Visible under the same `body[data-vt="2"][data-touchui]` gate as
  the zoom control it drives.

## Image

NOT bumped (stays v129). os.html is not in image.json and mkimage never reads
it — it's a served page, not baked blob content. Nothing image-affecting in
this diff.

## Gate (all green)

- `tests/browser/os-mobile2x.mjs` (new, port 3264): 12 checks — proven RED
  pre-change (phone viewport booted 1×) → GREEN after. Legs: phone-viewport
  auto-2x unpersisted; toggle → 1× persisted; persisted 1× overrides the
  auto-default across reload; toggle back → 2× persisted across reload;
  desktop viewport unchanged (1×, unpersisted, controls hidden).
- Kernel suite: 94 passed, 0 failed (410s).
- Browser sweep: 32 passed, 0 failed (482s) — os-vt2zoom / os-screen /
  os-touch / os-vt1mobile all green (the non-regression proof for the
  predicate choice above).
- Flake gate: kernel tripwire 12/12 (4 files × 3, under load), browser
  tripwire os-doom + os-term 3/3 each, os-mobile2x 3/3 under load ×10 —
  0% flake.

## Gotcha for the next reader

`className.includes('on')` is a trap for probing the toggle's lit state —
"fontbtn" itself contains "on". Use `classList.contains('on')` (the test does).
