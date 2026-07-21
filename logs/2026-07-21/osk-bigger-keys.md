# OSK: noticeably bigger keys for real-iPhone comfort

Real-device feedback (jku, physical iPhone): the mobile OSK keys — bumped once
in the v136-era ship to ~46px tall / 15.6px font at 390px — were still too
small to tap comfortably. This is the follow-up bump: a page-side, ZERO-BAKE
change (os/os.html CSS + a legend class in os/osk.js), image version untouched.

## Sizing (390px iPhone reference, computed = verified rendered)

| axis | before | after |
| --- | --- | --- |
| key font | `clamp(15px, 4vw, 17px)` → 15.6px | `clamp(17px, 5vw, 20px)` → 19.5px |
| vertical padding | `clamp(11px, 3.2vw, 14px)` → 12.5px | `clamp(13px, 3.8vw, 16px)` → 14.8px |
| key height | ~46px | **56px** (target 52–58; small phones bottom out ~49px, desktop caps ~59px) |

Height arithmetic: line box + 2·pad + 2px border = 19.5·1.25 + 2·14.8 + 2 = 56.
Board is 4 rows → 248px pane at 390px (was ~210px); the flex-sibling pane
shrink → screen-resize → wm re-clamp occlusion path is unchanged and the
os-osk e2e's re-clamp legs stay green.

## The long-legend tier (the one non-CSS bit)

Keys are `flex: 1 1 0` sharing row width, so a 390px row-of-12 gives ~27px
cells — multi-char legends (Ctrl, PgUp, ?123, Home…) were already clipping
slightly at 15.6px and would clip badly at 19.5px. Fix is general, not
device-cased: `render()` adds class `long` to any legend of 3+ chars, and CSS
gives `.oskkey.long` a smaller clamp (`clamp(13px, 3.4vw, 16px)` → 13.3px at
390px, which fits the 4-char legends in their flex share). Row rhythm is
preserved by moving the font size to a `--oskfs` variable on `.oskin` and
computing EVERY key's `line-height: calc(var(--oskfs) * 1.25)` from it — the
small-font keys keep the full-size line box, so all keys in a row are the same
height with the text vertically centered (no align-items:stretch top-drift).

## Gate

- `tests/browser/os-osk.mjs`: **43/43 ok, PASS** (no key-pixel assertions
  existed to update — behavior checks only).
- Adjacent sanity: `os-vt1mobile.mjs` PASS, `os-mobile2x.mjs` PASS.
- Rendered-size probe at 390×844: keyH 56.0, font 19.5px, long-font 13.26px,
  all 4 rows uniform 56px, board 386px wide (no board overflow).

Noted pre-existing (NOT this change): at 390px the top tab bar's `#desksite`
fontbtn pushes `scrollWidth` to 413px — a tab-bar overflow that predates this
work; the OSK board itself fits.
