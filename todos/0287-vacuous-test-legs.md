# 0287 — Three located vacuous test legs: muted-MessageBox, boot-race, and the missing browser-side wmctl timeout guard

- **Status**: open
- **Design**: this file. These are **already-located** defects, not a discovery pass —
  `0148` (recurring test-tightness sweep) is the pass that *finds* such things; this item
  fixes three specific ones that were found and then rode coordinator notes unfiled.

## Goal

Three test legs whose assertion is satisfied by the very failure it is supposed to catch. All
three are the same class: **the check cannot distinguish "the feature works" from "the thing
under test never happened."** All line numbers verified at `847dc057`.

### (a) `tests/browser/os-sounds.mjs:112` — muted MessageBox

```js
const w2 = await wposAt();
await page.keyboard.type('wmctl click About\r');
await sleep(2500);
const w3 = await wposAt();
check('muted: MessageBox raise stays silent', w3 === w2, { w2, w3 });
```

`w3 === w2` is satisfied **equally** by "muting works" and by "the About dialog never opened at
all." Since the only thing standing between the click and the sample is a blind `sleep(2500)`,
the second reading is entirely live. Fix: **assert the dialog exists** before sampling, so the
leg proves silence-with-a-dialog rather than silence-from-absence. While in here, retire the
blind `sleep(1200)`/`sleep(1500)`/`sleep(2500)` waits in favour of a real condition.

### (b) `tests/browser/os-boots.mjs:115` and `tests/browser/os-vt.mjs:38` — boot-race legs

Both are **self-documenting** about it:

- `os-boots.mjs:108-109` — *"if ready wins the race this degrades to a plain post-ready switch
  and the check passes vacuously — no flake either way"*
- `os-vt.mjs:35-36` — *"vacuously true if ready won"*, guarding
  `check('boot streams on VT1 …', early.state !== 'booting' || early.vt === 1, early)` — which
  is **unconditionally true** whenever `early.state !== 'booting'`.

On any machine or cache state where boot completes before the probe, neither leg tests anything.
Fix: make the mid-boot window **deterministic** (gate the probe on actually observing `booting`,
or arrange a boot slow enough to probe) so the leg either tests the claim or fails — never
silently abstains. If a deterministic window is genuinely not achievable, the leg should
**skip loudly**, not pass.

### (c) No browser-side `wmctl … timed out` guard

`tests/kernel/lib/drive.js:86-105` catches `wmctl: wait X timed out after Nms` in captured
output and throws, precisely because *a script whose `wmctl wait` timed out keeps running and
the test then samples stale state*. That guard is **kernel-only** — `grep` finds no `timed out`
check anywhere in `tests/browser/lib/`. Every browser suite that drives the UI through
`wmctl click`/`wait` (most of them) is exposed to the failure mode the kernel side considered
serious enough to guard. Fix: port the guard to the browser harness.

## Why these three survived

Each is described accurately in a comment, and **that is why nobody fixed them**: the comment
reads as known-and-handled, so the leg looks deliberate rather than broken. This is the
archetype `0286` is meant to make impossible.

## Sequencing

- (c) touches `tests/browser/lib/` — land it **after** the in-flight minimal-image harness work
  merges, to avoid editing the same harness file concurrently.
- (b) is a **precondition for gating `0285` honestly**: while the boot-race legs abstain, a green
  boot suite is not evidence that a boot-path change is safe.

## Acceptance

- (a) fails if the About dialog does not open; passes only for genuine silence-with-a-dialog.
- (b) both legs either test the mid-boot claim deterministically or **skip loudly**; neither can
  pass by abstaining. Demonstrate by forcing the "ready won" path and showing skip/fail, not pass.
- (c) a browser-harness guard turns a `wmctl … timed out` line into a test failure;
  demonstrated by inducing a timeout.
- Blind `sleep()` calls removed from the paths touched, replaced by real conditions.
- The affected suites green, reported **with NUMBERS** beside each (a suite without a number
  beside it counts as NOT RUN).
