# 0407 — netsurf: recreated text widget renders pre-layout (default fstyle) for the whole re-conversion window

- **Status**: done
- **Design**: —

## Verdict (2026-07-29, branch `0407-widget-fstyle`)

Fixed. A mid-window shot of the T arm is now pixel-identical to its settled shot. The
diagnosis in this ticket was correct but it named one of THREE pre-layout leaks. All
three are closed.

1. **The style.** `box_textarea_create_textarea` derives the widget's `fstyle` from the
   box's computed style with `font_plot_style_from_css`, the derivation the layout pass
   itself uses. This moved the mid-window field from 204 ink pixels to 283 against 285
   settled.
2. **The geometry.** Only the layout pass knows the box's size and padding, and it does
   not run again until the swap. The recreated widget therefore CARRIES the geometry of
   the widget it replaces, through a new `textarea_get_layout` — the exact inverse of
   `textarea_set_layout`. The outgoing `fstyle` is deliberately not carried: its
   `families` array belongs to the dying tree's computed style.
3. **The coordinates.** 47 pixels still differed: the caret sat 2 px left of its settled
   place. `html_set_focus` takes the caret's offset from `box_coords` of the FOCUS OWNER
   box, and `box_textarea_callback` named `gadget->box` — mid-window the NEW tree's box,
   which layout has never seen, so every coordinate off it is zero. The same applied to
   the damage rectangle of a mid-window keystroke. The old box is ALIVE for the whole
   window, so `html__reconvert` now hands it to `ctl->reconvert_box` instead of dropping
   it, and `form_gadget_screen_box()` returns the box that is on screen.

Two consequences fell out of (3). `reconverting` now means exactly "the old tree is
still displayed", so the flag clears when that tree is freed, not at the end of the
callback — the caret re-fire after the reformat sits between the two and needs the new
box. And the two re-conversion failure paths restore `ctl->box` from `reconvert_box`:
construction had bound gadgets into the partial new tree, which is freed there, so those
pointers were left dangling.

**Step 3 — what a page that re-boxes continuously shows.** Decision: KEEP today's
behaviour, no rate limit. Reasoning recorded in `todos/NETSURF-JS.md` §12, with a
pointer comment at `html_schedule_reconvert`. In short: `html__reconvert` already
refuses a second pass while one runs, so the rate is capped at one pass per pass and no
timer can beat the work; every pass completes and swaps, so the page shows its last
COMPLETE rendering, refreshed once per pass; a rate limit repairs no leak and only makes
the displayed frame older.

**Not fixed here, filed as `todos/0412` (register L60).** Every other gadget consumer —
the select menu's geometry, the select and radio repaints, the file gadget — still names
`control->box` and so still takes mid-window coordinates from an un-laid-out box.

Gate: `tests/kernel/test_netsurf_mutation_e2e.js` gates the T arm's immediate shot on
equal ink AND zero differing pixels across the field band. All four forced-window arms
read `band=0`, and the forced-window page now types glyph for glyph like the static
control at every step (91 142 165 216 252 285, both). Stable 3/3 under load.
`os/image.json` 192 → 193.

## Goal

Found during `todos/0386`'s trigger runs, first-hand and deterministic. It is
pre-existing behaviour: the `0386` fix made it visible because typed text now survives
into the window.

When a live re-conversion recreates a text gadget's widget
(`box_textarea_create_textarea`), the new textarea starts with the hardcoded default
setup: 10pt sans, 200×20, "Reset to correct values by layout". The correct values arrive
only at the swap's reformat (`textarea_set_layout` with the computed style). For the
whole window, redraws of the still-live OLD tree draw the NEW widget — at the wrong
font size.

On a normal page the window is 1–2 ms per tick and the artefact is invisible. On a page
whose window spans the tick period (the `0386` D2 trigger: 3000 elements, 300 ms tick),
the page is mid-window essentially always, so the field renders the 10pt state
persistently. Measured: the six-glyph field reads **204** ink pixels mid-window vs
**285** settled — the full value at ~13px instead of 20px. The same mechanism means a
page that mutates faster than it can re-box (`reconvert_pending` re-arming forever)
never shows its settled rendering at all — that page-health concern lives here too.

## Plan

1. Seed the recreated widget's fstyle from the box's computed style in
   `box_textarea_create_textarea` (`font_plot_style_from_css` — the same derivation
   layout uses), instead of the hardcoded 10pt default. The layout pass still owns the
   final values.
2. Assert in `tests/kernel/test_netsurf_mutation_e2e.js`: the T arm's IMMEDIATE
   (mid-window) shot must read the same ink as the settled one once the widget carries
   the right fstyle from birth. Those shots are diagnostics today; they become the
   regression guard.
3. Decide and record what a perpetually-re-boxing page should show. Options: nothing
   (today's behaviour, documented), or a re-box rate cap.

## Acceptance

- Mid-window redraws of a recreated focused field are pixel-identical to the settled
  render (the `0386` T arm immediate == settled).
- The `vendor/netsurf` change owes an `os/image.json` bump at merge time.
