# os-hires.mjs re-pinned to the v163 1×-default zoom contract (test-only)

`tests/browser/os-hires.mjs` was RED on main — not a product bug. The v163
bundle (1a5a5b33) dropped the phone auto-2× VT2 default (1× boots everywhere;
2× is the explicit, persisted Desktop-site toggle) and rewrote os-mobile2x.mjs
to the new contract, but os-hires.mjs was missed: its "DEFAULT UNCHANGED"
block still settled/asserted auto-2× + `stored === null`, and the applet
"Automatic (default)" leg asserted a return to 2×.

Re-pin, modeled on os-mobile2x.mjs:

- Default block now settles/asserts **1×** ("1×" label, localStorage null),
  and gains a `1× render mode is pixelated` check (os.html's
  `vt2ApplyRenderMode` is `Z<1 ? auto : pixelated`, so Z≥1 coverage is free).
  The no-cfg-file check stays BEFORE any zoom gesture — load-bearing, because
  `#desksite` routes through `vt2SetZoom` which delta-writes the OS display
  store (`display-set`), not just localStorage.
- The 2×-is-pixelated render-mode assertion (the file's actual job) is
  PRESERVED, but 2× is now reached explicitly via the `#desksite` toggle
  (asserted persisted, `stored === '2'`); its settled screen still feeds the
  0.5×-vs-2× density comparisons unchanged.
- "Automatic (default)" leg now waits for `z === 1 && stored === null`
  (`applyDisplayConfig('auto')` → `vt2SetZoom(1)` post-v163).
- Before-shot renamed `hires-before-1x.png` (it captures the boot default).
  The committed `logs/2026-07-25/hires-before-2x.png` + `hires-after-05x.png`
  stay as the hires-display lane's historical artifacts (regenerated-PNG churn
  reverted, the #82 rule).

Gate (all solo, green): os-hires 23/23 PASS, os-mobile2x PASS, os-vt1mobile
PASS. Diff is the test file + this log — nothing served, no image.json move.
