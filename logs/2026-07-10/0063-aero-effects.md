# 0063 — Aero effects on the WebGPU compositor

All five waves of the item landed in one unit: per-pixel alpha, drop
shadows + rounded corners, Aero Peek thumbnails, minimize/restore
animations, and the glass backdrop-blur tier. The item's one hard
constraint — **the headless deterministic composite keeps bit-exact
goldens, no tolerance loosening** — shaped every design decision below.
(Continued across a session boundary: the implementation and kernel tests
landed first, the browser test + docs + close-out in the second sitting.)

## Deterministic-or-invisible: how each effect met the constraint

Two effects are *semantic* (agents can observe them through shots), three
are *cosmetic* (they exist for human eyes at 60fps). The split decided
where each lives:

- **Alpha is semantic** → implemented in BOTH composites. The browser
  pipeline was already src-over for label-texture edges, so the client
  quad just blends; the headless `wmScreenshotScreen` gained an exact
  integer src-over (`(src*a + dst*(255-a) + 127) / 255`, round-to-nearest
  by construction) behind the new surface flag bit3 — opaque surfaces
  keep the old row-blit path byte-for-byte. The blend reuses the scaled
  path's nearest dst→src mapping, so a scaled translucent window blends
  identically in both worlds.
- **Thumbnails are semantic** → kernel-side `wmThumbnail`, a plain
  integer box filter (accumulate, floor-divide), aspect-fit, never
  upscaled. Deterministic enough to golden: the aero unit test asserts
  exact averages. Serving THUMB kernel-side keeps the WMP payload at
  popup size instead of streaming full frames to the WM.
- **Shadows/corners/anims/glass are cosmetic** → browser pass only. The
  headless composite never reads `_wmGlassOn` or `_wmAnims`; the e2e
  proves invariance by diffing whole screen shots with glass on vs off.

## The SDF vertex layout (shadows + corners without more passes)

Rather than extra passes or textures, every quad vertex grew 6 floats:
offset-from-mask-center, mask half-extents, corner radius, mode. The
fragment shader computes one rounded-rect signed distance; mode 1 clips
(1px AA edge — the frame's radius-7 corners), mode 2 turns distance into
a quadratic shadow falloff (14px reach, +3px drop, 0.5 alpha focused /
0.3 blurred). Still one vertex buffer, one pass, one draw per texture
run. Plain quads pass mode 0 and behave exactly as before.

Consequence for tests: a drop shadow is REAL pixels on the desktop.
Browser-test TEAL samples within ~17px of a chromed window's frame now
read shadowed teal — os-wm, os-scale (3 spots), os-quake (FLAGS-regex
column growth, see below) moved their sample points instead of loosening
tolerances. Sweep note recorded in CLAUDE.md.

## Glass: segments, not a second compositor

Glass ON splits the frame's quad batch into segments at each glass
window: composite-so-far lives in a scene texture; before a glass
window's chrome draws, a bilinear ½→¼→⅛→¼ blit chain (each resample a
2×2 box = cheap Kawase) blurs *exactly what is below that window*, which
its frame plate then samples through the quarter-res view, under a
whitish tint and 55%-alpha title colors. One final 1:1 blit presents.
With glass OFF, `segments.length === 1` and the code path is the
pre-0063 single-pass shape — not "equivalent", the same statements.
That's the zombie-fallback discipline: the fast path isn't a fallback,
it's the degenerate case of the one path.

## Aero Peek: the WM stays a policy client

The kernel got mechanism only (THUMB); the popup is wm.c policy — a
fourth borderless window raised by taskbar-button hover, parked above
the bar on the top layer, focus handed straight back to the app (a
preview must not steal focus). Two protocol quirks worth remembering:

- The wm only sees motion over its OWN windows, so "pointer parked over
  an app window" produces no dismiss signal — a 150-tick idle backstop
  handles it (peek_idle resets on every bar/preview hover).
- R_SHOT replies arrive in request order; `peek_pending` survives a
  dismiss so an in-flight THUMB still gets consumed off the socket
  (dropping it would desync every later reply).

`wmctl hover` (absolute-motion injection) exists purely to drive this
headless; `wmctl thumb` writes the box-filtered PPM for golden checks.

## Animations: transient kernel records, terminal state up front

Minimize/restore stamps `{kind, geometry, t0}` into `_wmAnims`;
`wmScene()` prunes records older than WM_ANIM_MS (200ms) and the
compositor interpolates an ease-out fly to a taskbar-strip slab, fading.
The kernel's minimized/hit-test state is final the moment the record is
born — the animation is provably cosmetic (headless kernels just
accumulate-and-drop tiny objects; no timer, no state machine).

## Ripples

- `wmctl list` FLAGS grew from 6 to 7 columns (`A` for WMP_F_ALPHA at
  [5], layer char moved to [6]) — every literal FLAGS assertion in the
  kernel e2e and the os-quake regexes widened by one dash.
- `SDL_WINDOW_TRANSPARENT` (real SDL3 value 0x40000000) is the app-side
  opt-in; host.js maps it to kernel bit3. `winbox alpha` ("alphabox",
  50%-alpha blue) is the acceptance app in all three test tiers.
- Image v45 → **v46** (winbox.c, wm.c, wmctl.c, wm_proto.h changed).

## Found, not fixed (owners assigned)

- **notepad ERROR dialog opening an existing file** — pre-existing
  (verified by stashing 0063 and re-running the probe on the unmodified
  tree); filed as a seeded finding in `todos/0073` (desktop-apps sweep).
- **Aero aesthetics need eyeballs** — pixel asserts prove mechanics, not
  looks; added to `todos/0064` (WM sweep round 3) next to the standing
  pointer-lock human check, including a glass-perf feel check (the blur
  chain reruns per glass window per frame).

## Tests

`tests/kernel/test_wm_aero.js` (new; blend goldens incl. scaled/extreme
alphas, thumbnail box-filter math, glass headless invariance, anim
record lifecycle), THUMB/GLASS/F_ALPHA legs in test_wm_policy.js, the
alphabox/thumb/glass/peek block in test_wm_service_e2e.js, and
`tests/browser/os-aero.mjs` (new; exact src-over blend on GPU, shadow
falloff + decay, corner clip, live peek popup raise/dismiss, anim
settle, glass round-trip). Full kernel suite + browser sweep at close.
