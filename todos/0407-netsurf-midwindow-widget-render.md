# 0407 — netsurf: recreated text widget renders pre-layout (default fstyle) for the whole re-conversion window

- **Status**: open
- **Design**: —

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
