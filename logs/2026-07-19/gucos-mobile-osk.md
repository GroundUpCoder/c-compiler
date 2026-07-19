# gucOS mobile OSK — synthetic-key on-screen keyboard (todos/0268)

Branch `mobile-osk`, page-side only (os/os.html + new os/osk.js + the
os-osk.mjs sweep). ZERO-BAKE: no kernel/C/image change — image version
untouched. HOLD-DEPLOY: bundles into the next gucOS boot.

## Why build-our-own (and not the device IME)

VT2 is a canvas with no focusable text input, so a mobile system keyboard
never raises — and a hidden-input IME proxy fundamentally cannot express
what the OS consumes: scancodes and chords. The kernel intercepts
Ctrl+Alt+Tab / Ctrl+Esc / GUI+arrow at its routing seam (kernel.js wmKey),
term folds ^C from the event mod word, wm.c reads ctrl/shift-click state
from real modifier keydown/keyup events. An IME hands you composed TEXT;
the OS wants KEYS. So the OSK synthesizes keys.

The synthetic-key architecture costs nothing at the seam: every key already
flows `wmSend({kind:'key', down, code, key, repeat, mods})` → routeInput
(compositor.js) → SDL_WEB.keyMsg (host.js SCANCODE_MAP/keysym/keymod) →
kernel.wmKey. A synthesized record is BIT-IDENTICAL to a physical one; the
kernel, the wm, and every app are oblivious that the OSK exists. Verified
against the real tables: all 114 legends resolve to nonzero scancodes and
the correct modifier-applied keysyms through host.js unmodified.

## The per-legend table (not a Shift transform)

SDL3 keysyms are modifier-applied (Shift+1 => '!'), and user32's vk_of
reads the SCANCODE for shifted digit-row symbols — so shifted symbols
cannot be derived at press time from a base key. Every legend is a
complete `{code, key, mods}` entry: '!' is `{code:'Digit1', key:'!',
mods:{Shift:true}}`, letters carry an explicit shifted variant
(`k:'q', K:'Q'`). Three layers (abc / sym / num-fn) cover letters, digits,
the full shifted-symbol set, F1–F12, Ins/Del/Home/End/PgUp/PgDn, arrows on
every layer. Named keys use the exact DOM strings (`'Enter'`, `' '` for
Space…) the NAMED_KEYSYMS table expects.

## Sticky modifiers: arm/merge/KEYUP-disarm (the one real design rule)

wm.c tracks Ctrl/Shift from REAL modifier keydown/keyup events, not
per-event mod words — so arming a mod sends a genuine `ControlLeft`
keydown, every subsequent event merges the mod into its `mods`, and
disarming sends the keyup. The load-bearing subtlety: **one-shots disarm at
the next regular key's KEYUP, never at its keydown.** The kernel swallows a
chord's keyup only while the mod bits are still held (wmKey's cycle/menu
branches match down AND up on the mod mask) — disarming at keydown would
leak half a chord (a stray Tab keyup) into the focused app. Tap = armed
(one-shot), double-tap = locked, third tap = off; multi-arm composes
(Ctrl+Shift+C is term's copy chord, proven end-to-end in the sweep).
Modifier and layer keys never repeat; regular keys repeat on the OSK's own
timer (400ms delay, ~30Hz, `repeat:true` — kernel chords keep cycling,
matching physical auto-repeat).

## Two first-class backends, one component

VT1 is a different seam entirely (tty bytes via `{type:'input'}`, not wm
keys), so the component takes a mode switch and two senders: on VT2 it
ships wm key records; on VT1 it ships bytes through the existing vt1Input
funnel (so the 0212 keystrip's sticky Ctrl still composes). The VT1
encoder speaks the estate's conventions — `\x1b[A` arrows, the tilde
group, SS3 F1–F4 — and under sticky mods the xterm modifier encodings
(CSI 1;N A–D, CSI n;N ~, Shift+Tab = `\x1b[Z`, Ctrl fold `^A..^_`, Alt =
ESC prefix). Neither backend is a stub; both are proven in the sweep
(vt1: command round-trips, ^U line kill, history recall, F5/PgUp byte
asserts; vt2: term typing, ^C, copy chord, kernel chords). A VT switch
releases held keys and disarms all mods through the OUTGOING backend —
their keyups must land where the arm keydowns did.

## Occlusion by layout, zoom composition

The `#osk` pane is a flex SIBLING of the VT panes at its natural height
(jku: not a literal half-screen). Opening it shrinks the flex:1 pane →
syncScreenSize → screen-resize → the wm re-lays the taskbar and re-clamps
windows — the 0023 dynamic screen does all the work, zero kernel change,
and it composes with the VT2 zoom's floor(pane/Z) automatically. The sweep
proves a window parked at the deep bottom re-clamps into the shrunken
screen, and that a Start-button click still maps through /Z at Z=2 with
the OSK open. Zoom is deliberately NOT clamped while the OSK is up: the
wm's clamp policy already handles small screens, and the Z=2×OSK product
is exercised green.

## UX decisions (jku-approved)

- Toggle visible whenever the tab bar is (both VTs), NOT gated on
  data-touchui — costs nothing on desktop, drivable in tests.
- Open state: saved-else-viewport-default (the #69 D6 / 0212 shape) — a
  phone-shaped viewport boots with the OSK OPEN, an explicit toggle
  persists and always wins.
- The OSK supersedes the 0212 keystrip while open (strict superset);
  closing it restores the strip (os-vt1mobile.mjs updated for this).

## Test gotchas found

- `clear` is NOT a seeded applet — a term e2e must not assume it can reset
  the screen; the copy leg selects the whole visible client instead of a
  guessed output row (and the term window's right edge clips at a
  phone-width screen, so the drag clamps to the canvas — motion routes by
  hit test and must stay on it).
- `page.keyboard` on VT2 can silently vanish (hidden xterm textarea can
  hold focus after VT flips); OSK probe taps (`__osOskTap`) need no DOM
  focus — prefer them for in-app typing in tests.
- The injection-log probe (`__osOskSent`) caps at 64 entries — entries
  carry a monotonic `seq` so drivers diff by sequence, not length.

Gate: os-osk.mjs 41 checks green; flake 3×/under-load 0%; kernel suite
93/94 with the one failure the known gucman_quake cold-bake load-flake
(passes solo, unrelated — this diff is page-side only); adjacent sweeps
os-vt1mobile / os-vt / os-vt2zoom / os-mobile2x / os-touch green.
