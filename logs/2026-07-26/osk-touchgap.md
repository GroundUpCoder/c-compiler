# OSK inter-key gaps: the third double-tap-zoom fix, and the last one that should be needed

**Branch** `osk-touchgap` off `origin/main` @db7edb4e (image v166).
**Report** jku, real iPhone, 2026-07-26 ~12:30 KST: "tap the OSK Enter key two or
three times in quick succession — the page zooms." Still live after 4bc04fc4.
**Change** `os/os.html` (static asset, no image bump) + `tests/browser/os-vt1mobile.mjs`.

## The bug

4bc04fc4's commit message asserted that ".oskkey keeps its local guard so the
OSK's inter-key gaps stay `none`". That clause is false, and it is false for the
exact reason the file keeps restating and then forgetting: **touch-action does
not inherit**. `#osk { touch-action: none }` styles the `#osk` element only. Its
descendants were:

    .oskin   max-width/margin only          -> computed auto
    .oskrow  display:flex; gap:4px; ...     -> computed auto
    .oskkey  touch-action: manipulation     -> guarded

So the keyboard's interior disagreed with its container: ~56px-tall guarded keys
floating in a sheet of default-zoomable surface.

I verified this rather than taking the read on faith, and the verification is
what sharpened the diagnosis. A stripped repro (the real `<style>` block from
os.html + the real `osk.js` DOM, no gucOS boot — the iOS simulator gets no worker
WebGPU adapter, so it cannot boot gucOS) run in **both Chromium and WebKit**
reported identical computed values, and the `elementFromPoint` hit-test around
the Enter key gave the mechanism:

    enter center           -> .oskkey   touch-action=manipulation
    2px above key top      -> .oskin    touch-action=auto
    2px below key bottom   -> .oskin    touch-action=auto

Two details the "gaps are auto" summary misses:

- **The vertical gaps are `.oskin`, not `.oskrow`.** `.oskrow`'s 4px row gap is
  `margin-top`, and margins sit *outside* the border box — so a vertical
  near-miss falls through the row entirely to the wrapper. Only the horizontal
  4px `gap:` between keys within a row is `.oskrow` area. A fix that guarded
  `.oskrow` alone would have missed the dominant miss direction.
- **Enter is a row-end key.** At 390px its rect is x 342.8..388 of a 390px
  viewport, so above it, below it *and* to its right are all non-key surface.
  That is why *Enter* is the reported repro and not some interior letter key:
  it has the most unguarded perimeter, and it is the key you tap repeatedly.

A thumb repeat-tapping a 56px target in the bottom-of-screen keyboard drifts a
couple of px; tap 2 lands on `.oskin`; WebKit runs double-tap-zoom.

### The inheritance question, stated honestly

Per the Pointer Events spec the effective touch behavior is the **intersection**
down the ancestor chain, which means `html, body { touch-action: manipulation }`
should already have covered every descendant and none of these three bugs should
have existed. On a real iPhone it demonstrably does not work that way — this
repo has now paid for that lesson three times (7ae67648, 1a5a5b33, 4bc04fc4 each
had to fix a surface an ancestor already "covered"). I cannot test the iOS
gesture, so I am not going to explain *why* WebKit behaves this way; the
operational rule that survives contact with the device is: **reason only from
what `getComputedStyle` reports on the element under the touch.** That rule is
now written into the stylesheet and asserted per-surface by the test.

## The fix

Stop writing per-element guards — that shape is what produced this bug twice
(#uploadbtn shipped with its own guard while its neighbours were never
retrofitted; .oskkey was guarded while the gaps around it were not). Cover the
app subtree once and narrow deliberately:

```css
  html, body { ...; touch-action: manipulation; }
  #wrap, #wrap * { touch-action: manipulation; }
  #wrap #screen, #wrap #osk, #wrap #osk * { touch-action: none; }
```

`#wrap` is the whole app, so membership is now *where an element lives*, not
whether someone remembered a property. Anything added under `#wrap` later — or
generated at runtime, which matters because **xterm builds its own DOM inside
`#terminal`** and none of it carried a guard — is covered by construction.

This also swept up the secondary uncovered surfaces in the same pass, all of
which measured `auto` before: `#terminal` (most of the screen on VT1),
`#desktop`, `#status`, `#guard`, `#guardRetry`, `#wrap` itself, `.xterm`,
`.xterm-screen`.

The old `#vtbar, #vtbar *, #keystrip, #keystrip *` rule is deleted, not kept —
it is exactly redundant under `#wrap *`, and a dead duplicate is the thing that
makes the next reader guess which one wins.

### Deliberate call: the whole OSK subtree is `none`, not `manipulation`

`manipulation` on the gaps would have fixed the reported bug. I went to `none`
for the entire `#osk` subtree instead. **This narrows the keep-pinch contract
inside the keyboard rectangle: you can no longer start a pinch-zoom on the OSK.**
Stating that explicitly because it is a real reduction, not an accident.

The reasoning: an on-screen keyboard should own every touch that lands in it —
there is nothing to scroll and a two-finger gesture on a key grid is an accident.
`#osk` itself has been `none` since 0212 with no complaint, so this makes the
interior agree with its container rather than changing the container's character.
Pinch-zoom stays live over the terminal and the desktop above it, which is where
a user actually wants it, and the OS's own zoom controls (VT1 A−/A+, VT2 −/2×/+)
are the first-class path anyway. A subtree whose interior disagrees with its
container is precisely the bug class this whole change exists to end; leaving the
gaps at `manipulation` would have preserved that split for no gain.

### Two specificity traps, both live

`#wrap *` is (1,0,1) and **beats** a bare `#screen`/`#osk` (1,0,0) and `.oskkey`
(0,1,0). Written naively this fix would have handed the canvas and the keyboard —
the two surfaces that must own their touches — back to the browser: a regression
worse than the bug. Hence `#wrap #screen` (2,0,0) and `#wrap #osk *` (2,0,1).

The second trap is subtler and is why the narrowings live in the top block rather
than in the `#screen`/`#osk` property blocks: raising *those* selectors in place
would have made `#wrap #osk { display: none }` (2,0,0) out-specify
`body[data-osk] #osk { display: block }` (1,1,1) — **the OSK would never open
again.** The touch declarations are therefore pulled out of both property blocks
and grouped at the top, with a pointer comment left at each old site.

`.oskkey`'s now-removed local declaration is replaced by a comment saying why
there is deliberately nothing there, since "no property" and "forgot the
property" look identical otherwise.

## Comments corrected

The router's instruction to fix the false comment was well aimed — a comment
that misstates cascade behavior is load-bearing for the next person's reasoning,
and this file's comments have now been provably wrong three times. The top block
is rewritten to state the non-inheritance rule, the ancestor-intersection
caveat, the pinch/user-scalable contract, the two specificity traps, and the
deliberate OSK narrowing. `#osk`, `#screen` and `.oskkey` carry pointer comments.

## Tests

`tests/browser/os-vt1mobile.mjs`, extended two ways:

1. **The enumerated table**, now split into `TOUCH_MANIP` (18 surfaces — the old
   11 plus `#wrap`/`#terminal`/`#desktop`/`#status`/`#guard`/`#guardRetry`/
   `#keystrip`) and a new `TOUCH_NONE` (`#screen`, `#osk`, `.oskin`, `.oskrow`,
   `.oskkey`). Computed values, not source.
2. **A behavioural hit-test**, because the table alone still passes if a
   refactor slips a new unguarded wrapper between `.oskkey` and `#osk` — which is
   *how this bug arrived*. It samples the points a drifting thumb actually hits
   (2px above / below / left of the Enter key) and asserts whatever element is
   really there computes `none`.

The OSK is closed on this file's 1100×900 viewport and a `display:none` subtree
has no rect, so the block opens the OSK for its duration and closes it again —
the strip legs below it need `#keystrip` back, which the OSK hides while open.

**Proven RED before the fix, in the booted OS** (not just in the stripped
repro): reverting `os/os.html` alone gives 13 failures with the diagnostic
values `.oskin -> auto`, `.oskrow -> auto`, `.oskkey -> manipulation`, and the
gap hit-test reporting `oskin -> auto`. GREEN after.

## What was run

`node tests/browser/os-sweep.mjs` on the six mobile/boot legs, all solo-green on
this branch: `os-vt1mobile` 26.8s, `os-osk` 117.7s, `os-touch` 37.2s,
`os-boots` 4.9s, `os-mobile2x` 3.6s, `os-vt2zoom` 3.7s. The full gate is
@master's. Disk checked first per the new discipline: 44Gi free.

## What is NOT verified

**The iOS gesture itself.** Headless cannot reproduce an iOS Safari double-tap,
and the simulator cannot boot gucOS (no worker WebGPU adapter). What is proven
here is the CSS contract the gesture depends on, measured in two engines and in
the booted OS. Final confirmation is jku's, on his phone, on the deployed build.

Also unverified: that `manipulation` on `#terminal`/`.xterm*` leaves on-device
long-press text selection untouched. It should — selection is governed by
`user-select`, and `manipulation` only drops double-tap-zoom — but it is a new
surface for that property and worth a glance during the device check.

## Ship notes

`os.html` is in `BAKE_INPUT_SKIP` (`os/os-common.js:1144-1147`, verified by
reading it, not assumed), so this is a static-asset change with **no
`os/image.json` bump** — v166 stands. `osk.js` was read but not modified. Not
merged, not deployed.

Device check-list for jku:
- Tap OSK **Enter** 3× fast — no zoom. Then the same on a corner key (Esc, the
  arrows) and on a key while drifting slightly off it.
- Pinch-zoom over the **terminal** and over the **desktop** still works.
- Pinch **on the OSK** no longer works — that is the deliberate narrowing above,
  not a regression.
- Tab bar still pans sideways to reach Upload.
- Long-press text selection in the terminal still works.
