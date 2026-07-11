# 0096 — Screensaver: idle-triggered Win95 classics

Landed the screensaver (todos/0096): after a configured stretch with no
input anywhere, /bin/wm covers the screen with a classic — the scrolling
marquee or a starfield flythrough — and any input dismisses it back to
where you were. Image is **v57**.

## The design call: whose clock is it?

wm.c cannot detect idle by itself — it only ever sees SDL events over its
OWN windows (the exact blindness that forced Aero Peek's hover-loss
timeout, 0063). The kernel is the single place all real input crosses:
`wmKey` and `wmPointer` are the two entries the UI bridge (and 0095's
INJECT_SCREEN) feed. So the split lands the same way as 0025/0032/0095:

- **Kernel = mechanism**: stamp `_wmLastInput` at those two entries and
  answer `GET_IDLE {} → R_IDLE {ms}` (`wmctl idle`). No timeout, no saver
  state, nothing raised kernel-side. R_IDLE is a NEW reply type rather
  than an R_OK payload because /bin/wm's drain is fire-and-forget — it
  skips anonymous replies and routes typed ones (the R_SHOT/peek
  precedent). Per-window INJECT_KEY/INJECT_POINTER deliberately do NOT
  stamp the clock: agent tests can poke apps without waking the saver —
  and headless tests can go "idle" while still driving wmctl.
- **wm.c = policy**: poll GET_IDLE once a second off the frame tick,
  compare against ITS configured timeout, raise/dismiss the window.

Dismissal needed no kernel help at all, which is the pleasant surprise of
the fullscreen-top-layer-focused shape: every pointer event hit-tests to
the saver and every key goes to the focused window (= the saver, because
this is the ONE piece of wm furniture that keeps its create-focus instead
of handing it back). Any input event on it → destroy + re-focus the saved
window; the waking input already re-stamped the kernel clock by arriving.

## The bug the first smoke caught: stable normalize vs "top layer"

First headless run: the saver listed at z BELOW the taskbar. SET_LAYER's
`_wmZNormalize` is a STABLE sort — a surface entering the +1 band from
layer 0 lands at the band's BOTTOM, under the earlier-created bar. Every
prior piece of top-layer furniture (start menu, peek, snap preview)
parks CLEAR of the bar spatially, so nobody had ever noticed. Fix: the
echo handler sends an explicit FOCUS after SET_LAYER — wmFocus raises
within the layer band, and the saver wants focus anyway. One send, both
semantics.

## Config: the sounds.h shape, one more time

`os/saver.h` (header-only, shared wm.c + ctlpanel.c): store = first
existing of `~/.config/screensaver`, `/etc/screensaver`, baked
`/usr/share/screensaver`; whole-file, no merge; keys `saver
none|marquee|starfield`, `timeout` (seconds, 0 = off), `text` (the
marquee banner). `sv_set` rewrites the effective table into the user
file (tmp+rename, carry-forward) — the ctlpanel applet's radios and
Apply button ride it; Preview sends WMP `SAVER {}` → `EV_SAVER` (the
EV_MENU pattern, subscriber-gated, `wmctl saver`). wm.c re-reads the
store at every poll, so applet writes go live within a second, no wm
restart.

**Default timeout is 900s, not 300** — deliberately past the kernel
suite's 600s per-test cap. With 300 baked, any e2e that runs >5 min
without INJECT_SCREEN traffic would have had a surprise fullscreen
window photobombing its `wmctl list` asserts. Tests that want the saver
write their own short timeout; everyone else can't collide by
construction.

## The savers

Self-contained draw routines over the one surface, full repaint per
frame tick (the compositor's vsync in the browser, the 0100 pacer
headless — hidden tab = parked animation, the honest-pause rule):

- **marquee**: the wm's 5x7 font at an integer zoom (`scr_h/64`, clamped
  2..8) via a new `draw_text_zoom`, scrolling 4px/frame right-to-left,
  random height each pass. Config `text`, default "WASM OS".
- **starfield**: 128 stars, z-flythrough (0.008/frame), projected from
  screen center, size 1-3px and brightness by depth, respawn deep on
  rim exit.

## Gotchas for future sessions

- **VT1 typing is tty input, not wm input** — it never stamps the idle
  clock. Fine in practice (the saver lives where the desktop is), but a
  browser test must jiggle the mouse on VT2 to arm a known-fresh
  interval; os-saver.mjs documents the pattern. Also the browser-test
  pacing trap again: pause ~800ms between typed VT1 lines or the next
  command's first key races the returning prompt (bit me: "rintf").
- EV_SCREEN dismisses the saver (stale geometry) rather than re-fitting;
  the idle clock just re-raises it. Recorded trim.
- `wmctl saver` with `saver none` configured is accepted (R_OK — the
  event fired) but raises nothing; the e2e pins that.

## Verified

`tests/kernel/test_saver_e2e.js` (25 checks: clock, baked defaults, idle
raise + above-the-bar stacking, animation shots, dismissal + focus
restore + clock reset + re-raise, `saver none`, the gesture, the applet
store writes + Preview, no-WM refusal with the clock still answering),
mechanism legs in test_wm.js, `tests/browser/os-saver.mjs` (real idle →
black + row-diff animation, real-mouse + key dismissal, no re-raise) —
plus the full kernel suite green. Follow-ups: Mystify/pipes → 0115; the
look-and-feel eyeball joined 0064's operator list.
