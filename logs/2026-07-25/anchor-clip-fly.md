# Anchored-child menu bar: grab-gated clamp + group fly (kernel/compositor only)

Two bugs, one root cause: since 0259 the app menu bar ("Shell Edit View" /
"Edit View Help") is a SEPARATE anchored-child surface (SDL_CreatePopupWindow
TOOLTIP — user32.c:1404, term.c:2106), and the compositor is anchor-blind, so
two behaviors the bar used to inherit for free from the parent's pixels were
being applied wrongly (or not at all) to the strip.

## Bug 1 — bar didn't clip to the window frame on phones

`_wmAnchorApply` ran the into-the-screen slide clamp on EVERY anchored child.
On a phone viewport where the window is wider than the screen,
`screen.w - dstW` goes negative, so `Math.max(0, ...)` pinned the bar to
viewport x=0 unconditionally — detached from its window frame (mirror bug at
the right edge).

Fix: the clamp is now gated on `c.grab`. The grab bit is the kernel's own
distinction between the two anchored kinds, so the rule is general, not a bar
special-case:

- **grabbed (POPUP_MENU) = transient menu** — must stay reachable to be
  clickable, so it slides into the screen (dropdowns depend on this).
- **non-grab (TOOLTIP) = structural attachment** — rigidly tracks the parent
  and clips at the viewport like the parent's own client pixels.

Consumer audit (all anchored-child creators in the tree): menucore.c creates
its popup levels with grab=1 only (menucore.c:410 → user32.c:1140 /
term.c:1105); the two bar strips are the only veneer TOOLTIPs; wm.c's
Start/ctx flyouts (wm.c:1636) are TOOLTIP but pre-clamp themselves in screen
coords before converting to parent-relative (their comment already noted the
kernel clamp "is already satisfied and never fights this one") — byte-identical
placement after the gate. Both composites already clip off-screen rects
(top-levels could always be moved off-screen), so nothing downstream cared.

## Bug 2 — bar popped instead of animating on minimize/restore ("group fly")

`wmMinimize`/`wmFocus` push a fly-anim record for the PARENT sid only; the
child either left the scene at frame 0 (`_wmAnchorHidden` → wmScene filter,
min direction) or drew parked at its settled position at full alpha for the
whole 200ms (restore direction — the visible "hovers detached then pops" bug).
Pre-0259 the bar was painted INTO the parent's top pixels and rode the fly for
free; the strip extraction regressed that.

Fix — the ONE sanctioned anchor-blind exception, kernel-computed so the
compositor stays geometry-dumb:

- kernel `wmScene`: for each child, resolve the root via `_wmAnchorRoot`
  (arbitrary depth) and set `s.animRootSid = root-has-live-anim ? root.sid : 0`;
  KEEP an anchor-hidden child iff its root has a live 'min' record
  (restore-direction children are visible anyway — `minimized` clears before
  the restore push).
- compositor surface loop: resolve the anim by `(s.animRootSid || s.sid)`;
  a child with a live root anim draws ONLY a proportionally-transformed quad
  inside the root's interpolated `animRect` (same ease/alpha as the root),
  then `continue`s; expired-anim-but-root-still-minimized draws nothing. The
  gating matters: an ungated normal-path draw is exactly the old restore bug.

Hit test / cursor / headless composite still use `_wmAnchorHidden` directly —
anim frames were never hit-testable and headless never renders anims, so those
paths are untouched.

## Test contract changes (tests/kernel/test_wm_anchored.js)

- The far-child clamp case now creates with `flags:64|128` (grabbed slides);
  a new sibling case asserts a non-grab child is NOT clamped (x=5200) and
  rigidly tracks the parent off-screen.
- The old "scene excludes hidden children" leg now asserts the NEW contract:
  children KEPT with `animRootSid === root.sid` while the min fly is live,
  excluded after expiry; restore-direction linkage set while live, 0 after.
  Fly liveness is made deterministic by re-stamping/rewinding the anim
  record's `t0` — no wall-clock dependence under -j load.

## Gates

- `node tests/run.js --diff` → kernel 114/114 pass (incl. the updated
  anchored test), browser sweep pass. os-drop failed once mid-sweep
  ("survive the reload" ls race) and passed solo — flake, path untouched by
  this diff. os-hires red was the KNOWN stale-contract failure on main;
  cb4e98f0 (test-only re-pin) landed mid-run and this branch fast-forwarded
  onto it — os-hires green here after the ff.
- Eyeball evidence (headless can't render anims): one-off driver
  `tests/browser/shots-anchor-fly.mjs` (untracked) captured per-rAF frames →
  `build/anchor-fly-shots/`: the restore fly shows the term bar riding the
  flying quad scaled+faded at 51ms/90ms and settling clean; the 390px-viewport
  still shows the bar aligned with the window frame (x=12), not pinned to 0.
  The smooth-motion feel still deserves an on-device human check.

No image.json bump: kernel.js + compositor.js ship as static assets
(gucos-0140 convention).
