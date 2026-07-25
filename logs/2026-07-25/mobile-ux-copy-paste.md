# Mobile-UX batch: keystrip Copy/Paste, os-osk root cause, pinch-zoom verdict

Branch `mobile-ux` (off v163 @1a5a5b33). All page-side (os.html) + tests — no
baked asset changed, so `image.json` stays at v163 (os.html ships static; the
0082 mtime gates re-materialize Node-side fixtures automatically).

## Copy/Paste strip keys (kickoff ITEM 2)

iOS Safari rejects every gesture-less Clipboard API call, which meant the
ticket-#79 bridge — writeText at the kernel CLIP_SET echo, readText on window
focus — never fires on a phone: gucOS had NO working clipboard path on iOS at
all. The fix is to put the two directions behind real taps, so the tap IS the
gesture:

- `#keystrip` grew **Copy** and **Paste** keys (one `stripKey` maker now
  builds every strip key; pointerdown keeps xterm focused AND is an
  activation-triggering event, so the async clipboard calls run inside the
  tap's transient activation).
- **Copy**: live xterm selection if any (exported host-side AND committed to
  the kernel slot so `clip -o`/term see it); with no selection it re-exports
  the last agreed clipboard text. That fallback deliberately BYPASSES
  `clipToHost`'s `clipSynced` dedupe — the retry case is exactly text the
  bridge already agrees on but whose automatic mirror was rejected on iOS.
- **Paste**: readText (iOS raises its paste callout here), import into the
  kernel slot (the `clipFromHost` contract minus its dedupe early-out — the
  tty injection must happen even for already-synced text), then
  `term.paste()` so bracketed-paste/CR conversion ride xterm's own path.
- **VT2**: the keystrip is VT1-only, but the OSK works on both VTs — the OSK's
  wm backend now mirrors the physical paste-chord refresh (os.html screen
  keydown): an OSK Ctrl/Cmd+V tap calls `clipFromHost()` before the key
  ships. The OSK tap is a real pointer gesture, so on iOS this is the one
  VT2 import path that can raise the paste callout. Same aims-at-the-next-
  paste semantics as the physical chord (ordering input behind an async
  clipboard read would be worse).

Remaining VT2 gap (surfaced, not forced): a first OSK Ctrl+V primes the slot,
the paste itself needs the app's own paste action (a second ^V, term's
^⇧V, an Edit menu). A one-tap VT2 "paste into the focused app" button would
have to guess the focused app's paste chord (EDIT wants ^V, term wants
Ctrl+Shift+V — ^V there is a literal byte) or grow a kernel-routed semantic
paste — a design decision, not a page patch.

Tests: os-vt1mobile.mjs grew 6 real-click legs (selection copy → host +
slot, dedupe-bypass re-export, paste → executed split-needle command + slot
import, stripkey touch-action assert); os-clipboard.mjs grew the OSK-chord
VT2 legs. Honest limit (same as os-clipboard's header): headless
grantPermissions stands in for the iOS callout/grant — the gesture-dependent
iOS behavior needs jku's on-device check.

## os-osk.mjs pre-existing failure — root cause

TWO stale test contracts, no product bug:

1. The drag-selection leg anchored its drag at term client (4,4) — since
   0273c (v148) the top `MENU_BAR_H`=30px of term are the menu-bar strip
   child, which swallows the down (it was opening the File menu, not a
   selection; term.c:1916's selection branch never ran). The dependent
   `clip -o` wait then starved. Fix: anchor below GRID_Y. The
   0273c memory note ("term pixel probes need GRID_Y=30") called this class.
2. `zoom === 2` phone-default assert — v163 re-pinned the phone boot default
   to 1× and updated os-mobile2x.mjs but not this file. Re-pinned here too.

## Pinch-zoom (kickoff ITEM 4) — genuine wall, native pinch left as-is

Verdict: relaxing `#screen{touch-action:none}` for "2-finger-only" native
pinch is not shippable, for two stacked reasons:

1. **The two-finger slot on the canvas is already allocated.** todos/0212
   defines two-finger drag = OS scroll (midpoint pan → wheel records;
   os-touch.mjs "two-finger pan wheels the notepad EDIT" is the acceptance).
   On iOS, a region that permits pinch-zoom hands ALL two-finger gestures to
   the native viewport interaction (pinch and two-finger pan are one gesture
   there) — the browser and the OS cannot share the same two fingers.
2. **The touch model has no mid-gesture handoff.** The single-finger state
   machine must preventDefault the touchstart (it also suppresses
   compatibility mouse events); a touch sequence whose start was canceled
   can never be claimed by the browser as a native pinch later. So "watch
   until it looks like a pinch, then hand off" is impossible by spec, and
   the only real relaxation (`touch-action: pinch-zoom` + uncancelled
   starts) surrenders two-finger scroll and reopens the double-event
   problem.

Not touched (per the ask): the viewport meta already allows user scaling —
no `user-scalable=no`/`maximum-scale` anywhere; native pinch still works
off-canvas. The forward path, if jku wants canvas pinch: interpret the
diverging-finger gesture IN the page touch layer and drive the existing VT2
zoom model (`vt2SetZoom`/`vt2Eff` — live fractional zoom during the gesture,
snap to a VT2_ZOOMS step at release). Single owner stays the page seam,
kernel/WM still never learn touch exists — but it re-purposes a shipped
gesture axis, so it's jku's call, not a silent change.
