# os.html comment audit — every claim traced or corrected

**Branch:** `oshtml-audit` (base `origin/main` @6a9efc73). Comments only; no
behavioural change, no `os/image.json` touch (stays 168 — `os.html` ships as a
static asset, so the deploy check is the SERVED file, not the image version).

## Why

`os/os.html`'s comments bit this project twice in one session: a coordinator
read a comment, reasoned from it, and was wrong both times. So this pass is not
"fix the two known-bad ones" — it is *every* claim in the file either traced to
the code that makes it true, or corrected.

Rule held throughout: **a comment is verified only if the code that makes it
true was found.** Nothing was deleted to avoid verifying it.

## The two already-known ones were ALREADY FIXED

Both were corrected by `5ad36132` (clipboard seam), which is in the base — so
this pass re-verified and left them alone rather than double-editing:

- *"the OSK is a superset"* — now TRUE. `osk.js` `KCOPY`/`KPASTE` sit in the Fn
  (`num`) layer row 2, and `Ctrl+Shift+C/V` dispatch to the page-injected
  `ttyClip` handlers (`osk.js` `pressStart`, and the chord branch above it).
- *"…is gesture-less, so iOS Safari rejects them"* — the overbroad version is
  gone. The surviving statement (the window-FOCUS sync is the one genuinely
  gesture-less path) is correct: a `focus` event is not an activation-triggering
  input event, while `pointerdown` is.

## The correction with a reusable lesson: CSS specificity

The file asserted `#wrap *` is **(1,0,1)** and therefore *beats* a bare
`#screen`/`#osk` **(1,0,0)**. Both halves are wrong, and it matters because the
whole touch-action contract is justified by that sentence.

The universal selector contributes **nothing** to specificity, so `#wrap *` is
**(1,0,0)** — a *tie* with a bare id, broken by source order. Verified in
Chromium rather than argued:

| selector under test | vs `#wrap *` | computed |
|---|---|---|
| bare `#screen`, declared LATER | tie → source order | `none` (bare id **wins**) |
| bare `.oskkey` | (0,1,0) loses | `manipulation` (the claim's TRUE half) |
| `#wrap #osk *` (2,0,0) | wins | `none` |
| raising to `#wrap #osk` in the display block | (2,0,0) vs `body[data-osk] #osk` (1,1,1) | `none` — **the OSK never opens** |

So the rule's *conclusion* survives (keep the narrowings in the top block and
raised) but for the honest reasons: against a class it is a real win; against a
bare id it is a tie that today only works because of block ORDER and would flip
silently on a reorder; and raising the selector in `#osk`'s own property block
really would break `body[data-osk] #osk { display: block }`.

## Other corrections

- **`mobileViewport()` is not "narrower than" `touchUiSync`.** They are
  different predicates, not nested: a 900×600 non-touch window trips
  `min() <= 700` while `innerWidth > 768` keeps `data-touchui` off. Also the
  comment still claimed it drove "the VT2 zoom default" — it has only two live
  call sites (VT1 font, OSK open); the phone auto-2× default was removed when
  #69 D6 was revised to boot every viewport at 1×.
- **VT1 mobile font is THREE steps up, not one.** 0212 shipped an 18px mobile
  default (one step over 14); it is 26px now (`VT1_FONTS` index 4 vs 1).
- **`#zoomctl` "integer downscale" / "a non-touch desktop keeps Z=1".** Z≥1 is
  an integer *upscale*; Z<1 is the fractional high-density downscale. And only
  the *control* is touch-gated — `applyDisplayConfig` (the Control Panel Display
  applet) and a persisted localStorage choice set the factor on any device.
- **Two rules that do not exist.** `#uploadbtn` cited "the #vtbar subtree rule"
  and `.stripkey` cited "the #keystrip subtree rule". There is one rule,
  `#wrap, #wrap *`.
- **Safe-area gutter is 2px at the sides, 6px at the bottom** (the comment said
  a flat 2px; `padding-bottom` floors at 6px).
- **Header "EVERYTHING with logic lives in kernel.js/host.js/os-common.js".**
  Not true and it is the claim that makes this file easy to under-read: the page
  owns the touch gesture state machine, the zoom/CSS pointer seam, the clipboard
  bridge and VT/OSK state. That logic is real and is **not** Node-testable —
  `tests/browser/os-*.mjs` is its only gate, which is now said out loud.
- **`vt1ClipPaste` "minus its dedupe early-out"** — it keeps the identical
  `!== clipSynced` guard on the kernel post; what differs is that the paste
  happens either way.

## Found while auditing: a real code bug (NOT fixed here)

`window.addEventListener('focus', clipFromHost)` passes the `FocusEvent` as
`clipFromHost`'s `done` parameter, so `if (done) done()` throws
`TypeError: done is not a function` on **every** tab focus. Confirmed with a
stripped repro in Chromium. The clipboard import itself still lands (the
`postMessage` precedes `done()`), so the symptom is an uncaught error per focus
rather than a broken bridge — the quiet-symptom shape this estate has been
curing all week. Left alone deliberately: this branch is comments-only.
