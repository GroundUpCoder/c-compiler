# 0038 — WM known-issues fixes (graduate the fixable entries)

- **Status**: DONE (2026-07-08) — kernel z layers (WMP SET_LAYER,
  stable-sort normalization; wm.c pins taskbar/menu +1, desktop -1);
  decision + rationale in WM.md "Implementation status — z layers",
  dev log `logs/2026-07-08/wm-z-layers.md`, image v27
- **Depends**: — (0033 created the list; this graduates its fixable
  entries per WM.md's "entries graduate to queue items when a fix is
  scheduled")
- **Design**: `todos/WM.md` "Known issues" (repros there)

## Goal

Fix the verified-but-unfixed WM.md known-issues entries that are actual
bugs (not watch-items). As of round 1 that is:

- **Taskbar is not always-on-top** — every window creates ABOVE the bar
  in kernel z, so a window title-dragged onto the bottom strip covers
  the bar (repro in WM.md). Decide between the two fix shapes sketched
  there:
  - wm.c policy: re-raise the bar (and the desktop layer's bottom pin)
    on EV_MOVED/EV_SCALE overlap — zero kernel change, but reactive
    (one composited frame of overlap is visible);
  - kernel mechanism: an always-on-top / layer bit on the surface
    record (SET_FLAGS bit), respected by the z-order ops — one more
    MUST-MATCH field, but airtight and reusable by the desktop layer's
    bottom-of-z pin (which is the same problem mirrored).
  Record the decision + rationale in WM.md when made; don't re-litigate
  0013–0033 invariants while in there.

NOT this item (stay on the standing list as per-sweep checks): the
pointer-lock human check, snake's double-`q` vendor quirk (decided: not
worth patching), the shrunk Dawn+SIGKILL caveat, the quiet gpubox
adapter flake.

## Plan

- Test-first: minimal repro test for bar-coverage (kernel suite
  `test_wm_policy.js` leg — drag a surface onto the strip, assert bar z
  after; browser leg in `os-wm.mjs` or `os-shell.mjs` if the fix is
  wm.c-side and needs real compositing).
- Implement the chosen fix shape; if kernel-side, keep the WMP/record
  MUST-MATCH blocks (kernel.js ↔ os/wm_proto.h ↔ test_wm_policy.js) in
  sync and bump what needs bumping.
- Sweep the same fix over the desktop layer's bottom-of-z pin if the
  mechanism generalizes (a maximized/dragged window must never sink
  UNDER the desktop layer either — verify, don't assume it can't).

## Acceptance

- The repro from WM.md no longer covers the bar (drag winbox onto the
  strip → bar stays visible/clickable; `wmctl list` z agrees).
- New regression test(s) committed first, suites green (unit, kernel,
  browser sweep serially incl. os-shell.mjs).
- WM.md known-issues entry moved to a "fixed in 0038" note or deleted;
  dev-log entry; image version bumped if seeded sources changed.
