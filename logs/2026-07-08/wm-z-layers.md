# Kernel z layers — the taskbar becomes always-on-top (todos/0038)

Round 1 of the WM bug sweep (todos/done/0033) left one verified real bug
on WM.md's known-issues list: **every window creates ABOVE the taskbar in
kernel z**, so wm.c's furniture only stayed visible because placement
cleared the strip — a window title-dragged onto the bottom strip covered
the bar, buttons and all. 0038 graduated that entry; this log records the
fix shape and why.

## The decision: kernel mechanism, not reactive policy

The item sketched two shapes:

1. **wm.c policy** — re-raise the bar (and the desktop's bottom pin) on
   EV_MOVED/EV_SCALED overlap. Zero kernel change, but reactive: one
   composited frame of overlap is visible per violation, and — the
   killer, found while reading the code rather than assumed — **RESTACK
   has no event**, so a `wmctl lower` that sinks a window under the
   desktop layer is invisible to wm.c. The reactive shape can't defend
   the invariant it's supposed to own.
2. **kernel z layers** — a per-surface layer respected by the z-order
   ops themselves. One more MUST-MATCH field, but airtight, and the
   desktop layer's bottom-of-z pin is the same problem mirrored, so one
   mechanism covers both.

Went with (2). The mechanism/policy split survives intact: the kernel
only enforces layer bands; *which* surfaces are furniture stays wm.c's
call (it pins its own windows), and the no-WM kernel-chrome fallback
never sets layers, so its behavior is byte-identical.

## What landed

- **kernel.js**: `surf.layer` ∈ {-1, 0, +1} (default 0). After EVERY z
  mutation — create-push, focus-raise, RESTACK raise/lower, SET_LAYER —
  `_wmZNormalize()` re-sorts `_zOrder` **stably** by layer.
  `Array.prototype.sort` stability (ES2019) is load-bearing: the
  raise/lower that just happened is preserved *within* the layer band,
  the sort only stops it crossing a boundary. That single sort IS the
  whole always-on-top story — hit-testing and both compositors already
  walk `_zOrder`, so they inherit it for free.
- **Protocol**: WMP `SET_LAYER` 0x1A { sid, layer } → R_OK/R_ERR;
  kernel-JS `wmSetLayer` (agent channel — one op set, exposed twice);
  `wmctl layer SID -1|0|1`. The 80-byte window record's word 11 (the
  reserved slot — no size change, no offsets moved) now carries the
  layer; `wmctl list` FLAGS grow a `T`/`B` char for pinned surfaces
  only (width unchanged for normal windows, so existing
  `\tf---R\t`-style test greps stayed valid). No new event: nothing
  needs to *react* to a layer change, that's the point.
- **wm.c**: on its own EV_CREATED echoes, pins taskbar → +1,
  Start menu → +1 (created after the bar; the stable sort keeps it
  above within the layer, which is exactly the Win95 stacking), desktop
  layer → -1, replacing the old one-shot `RESTACK place=1`.
- **image.json v27** (wm.c + wmctl.c are baked system sources),
  `os/os-system.img` rebaked via tools/mkimage.js.

## Test-first

The failing legs landed as their own commit (a17f7e5) before the fix:

- `test_wm_policy.js` — scripted-client legs: SET_LAYER pins across
  create/raise/focus; the strip composite keeps showing the bar's
  pixels with a window parked over it; RESTACK lower stops above a
  bottom-pinned surface; error paths (bogus sid, layer out of range).
  Pre-fix output shows the repro exactly: strip pixel `[50,60,70]`
  (the window) instead of `[10,20,30]` (the bar).
- `test_wm_service_e2e.js` — the REAL wm.c binary pins its furniture;
  `wmctl raise` stops below the bar; FLAGS carry T/B. Pre-fix the list
  showed the taskbar at z=1 with ten windows above it.
- `os-wm.mjs` (browser) — the original WM.md repro verbatim: title-drag
  a winbox onto the strip; the bar stays composited above it AND its
  button still clicks *through* the overlap (minimize/restore), plus
  `wmctl list` z agreement. (This leg rode the fix commit — it can't
  pass without the rebaked image.)

## Gotchas for the next reader

- The layer sort must be STABLE and must run after *every* z mutation;
  if you add a new z-order op, call `_wmZNormalize()` or the invariant
  silently rots (the fuzz-free WM has no checker for it — 0039's storm
  should try `wmctl layer`/`raise`/`lower` combinations).
- The record grew no bytes; wm_proto.h renamed `reserved` → `layer`.
  MUST-MATCH triple: kernel.js WMP block ↔ os/wm_proto.h ↔
  test_wm_policy.js — now including SET_LAYER and word 11.
- Suites at landing: unit 697✓, blockfs✓, kernel✓ (incl. the new legs),
  full serial browser sweep✓ (os-wm ran 3×; one first-run flake in the
  boot-phase checks did not reproduce).
