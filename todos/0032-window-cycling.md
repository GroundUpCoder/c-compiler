# 0032 — window cycling: a kernel chord → EV_CYCLE

- **Status**: open
- **Depends**: —
- **Design**: `todos/WM.md` "The desktop shell" (window-cycling block)

## Goal

Alt-Tab-shaped focus cycling. The one desktop-shell piece needing new
kernel mechanism: every key goes to the focused surface today (`wmKey`),
there is no grab.

## Plan

- kernel.js: recognize ONE chord at the key-routing seam and emit WMP
  **EV_CYCLE** (next free event id; direction word for shift-reversal)
  instead of delivering the key. No general grab table — one chord,
  kernel-owned, like the title double-click.
- **Chord choice decided in-item** under the browser constraint:
  OS-level Alt-Tab never reaches the page on Windows/Linux — the
  Ctrl+Alt family aligns with the VT chords; document in the os.html
  tab-bar tooltip (discoverability rule).
- wm.c policy: cycle focus through non-minimized surfaces in z-order
  (WMP_FOCUS). **No subscriber → no interception**: the chord is not
  recognized at all and the key passes through to the focused app like
  any other (the kernel never silently eats keystrokes; cycling is
  purely WM policy — the maximize precedent, and the mouse covers
  maintenance mode).
- Agent exposure: `wmctl cycle` → WMP CYCLE command → the same event
  path ("one op set, exposed twice").
- Image bump (wm.c + wmctl.c are seeded).

## Acceptance

- `test_wm.js` / `test_wm_policy.js`: chord with subscriber → EV_CYCLE →
  focus advances in z-order, shift reverses, minimized skipped; without
  subscriber → the chord is NOT swallowed (key lands in the focused
  app's ring); `wmctl cycle` drives the same policy path headless.
- Browser (`os-wm.mjs` leg): chord flips focus between two winboxes
  (title-bar color assert); after killing the wm the chord reaches the
  focused app instead.
