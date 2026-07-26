# 0300 — wm.c modal min/max box suppression — descoped into a now-closed item, never refiled

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #12).

## Goal

Suppress the min/max title-bar boxes on modal (transient) windows, which real Windows does and
gucOS does not.

`os/wm.c:3853-3854` + `os/wm_proto.h:269-270`:

```c
/* (The WMP_F_TRANSIENT flag could later also suppress the min/max
 * title-bar boxes on modals — deliberately NOT done here, 0281.) */
```

**Verified.** `todos/done/0281` is **closed**, and its own body says *"note, don't
scope-creep."* So the descope was correctly recorded and the item shut — and then nothing
carried it forward. `grep 0281` over tickets → **0**.

## Why it is filed despite being cosmetic

**Blast radius: COSMETIC.** It is filed for completeness because it is the cleanest, smallest
example of the shape the sweep was looking for: a *correct* descope decision, recorded in a
*true* comment, pointing at an item that is now *closed*. Everything about it was done right
except that no one refiled it — so it became permanent by default.

`0294` (moving-edge window resize) is the same shape at larger size. Both would have been caught
by `0286`'s proposed check, which fails when a comment cites a closed item.

## Plan

- Use the existing `WMP_F_TRANSIENT` flag to suppress the min/max boxes when drawing a modal's
  title bar.
- Confirm the close box still renders and works on modals (that is the one control a modal
  needs).
- Update the comment to describe what is done rather than deferring to `0281`.

## Acceptance

- Modal/transient windows draw no min/max boxes; close still present and functional.
- Non-modal windows are visually unchanged.
- The `wm.c` / `wm_proto.h` comments no longer defer to a closed item.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS. Note this is
  a visual change — check whether any golden PNGs contain a modal title bar and rebake
  deliberately if so. **Do not rebake goldens blind**; that miss has burned this estate before.
