# 0301 — mobileViewport() trips on a short-but-wide NON-touch window (900x600) while data-touchui stays off

- **Status**: open
- **Design**: this file.

## Goal

Decide what a short-but-wide desktop window should get, and make the predicate say it.

`os/os.html:387-389`:

```js
function mobileViewport() {
  return Math.min(window.innerWidth, window.innerHeight) <= 700;
}
```

A **900×600 non-touch** window has `min() = 600 ≤ 700`, so it trips this predicate — while
`touchUiSync`'s separate touch-or-narrow test leaves `data-touchui` **off**. Result: a plainly
desktop-shaped window gets **phone defaults** (VT1 font bumped to 26px from 14; OSK
open-by-default) with none of the mobile controls. Two call sites are affected —
`os.html:399` (VT1 font) and `os.html:1199` (OSK default).

Verified at `847dc057`.

## The interesting part — this is already documented

`os/os.html:381-386` states it outright:

```
// It is a DIFFERENT predicate from touchUiSync's touch-or-narrow test, not a
// subset of it. Intended: a touch-capable WIDE viewport (a tablet, a
// touchscreen laptop) gets the mobile CONTROLS but keeps desktop-density
// defaults. Also true, and less intended: a short-but-wide non-touch window
// (900×600 — min() ≤ 700, innerWidth > 768) trips THIS predicate while
// data-touchui stays off. Explicit choices override either way.
```

The divergence from `touchUiSync` is **deliberate and correct**. The 900×600 case is explicitly
flagged as **"less intended"** — i.e. a known, accurate, unscheduled gap, with no ticket. It is a
textbook instance of the class the 2026-07-27 sweep found: the comment's accuracy is exactly why
nobody revisited it. This item is that revisit.

## Severity — genuinely low, and that is fine

`900×600` is an unusual desktop window, and the comment's last line is true: **explicit choices
override either way**, so a user who sets a font size or closes the OSK is unaffected. Only
first-run defaults in an odd window shape are wrong. Filed at P3 to enter the scheduling system,
not because it is urgent — the sweep's lesson is that *unscheduled* and *unimportant* are
different properties.

## Plan

Pick one and record the reason:

- **(a)** Add a non-touch escape: require `innerWidth <= 768` **or** touch capability, so a
  short-but-wide mouse-driven window keeps desktop density.
- **(b)** Split the predicate per call site — the VT1 font bump and the OSK default may not want
  the same signal (an OSK on a non-touch device is arguably never wanted, which would make the
  `1199` call site the clearer bug of the two).
- **(c)** Decide it is acceptable and **change the comment** from "less intended" to a stated
  decision, so it stops reading as an open gap.

**(b) is worth a real look** before defaulting to (a): the two call sites are being served by one
predicate mostly because one predicate already existed.

## Acceptance

- A 900×600 non-touch window gets whichever behaviour is chosen, and the choice is recorded here.
- `os/os.html:381-386`'s comment describes a decision, not an unintended-and-unowned case.
- Touch tablets keep mobile controls with desktop density (the intended case must not regress).
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
