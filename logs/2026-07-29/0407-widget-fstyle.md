# 0407 — a recreated text widget must be renderable from birth

Branch `0407-widget-fstyle`. Image 192 → 193.

## The shape of the bug

A live re-conversion builds the next box tree while the old tree stays on screen. The
old tree serves every redraw and every key until the swap. Box construction recreates
each text gadget's widget as it goes. The old widget belonged to the tree that is being
replaced, so it must go.

The new widget was born with a hardcoded setup: 10pt sans, 200x20, with the comment
"Reset to correct values by layout". That comment is true for a FIRST conversion, where
nothing is on screen yet. It is false for a re-conversion. The old tree draws the NEW
widget from the moment construction reaches it, so the field renders pre-layout for the
whole window.

The window is 1-2 ms on a normal page, so nobody saw it. `todos/0386` built a page whose
window spans its own tick period: 3000 elements, a 300 ms tick. That page is mid-window
essentially always, so it showed the 10pt state permanently. The number was
deterministic — 204 ink pixels against 285 settled.

## Three leaks, not one

The ticket named the style. The style was one of three pre-layout leaks, and the test
found the other two by refusing to accept an ink count as proof.

**The style.** `font_plot_style_from_css` is the derivation the layout pass uses. Box
construction can run it too: the computed style is on the box already. This took the
mid-window field to 283 of 285.

**The geometry.** Two ink pixels and 47 band pixels still differed. Layout owns the size
and the padding, and it does not run again until the swap, so no derivation can supply
them. The widget that is being replaced HAS them, though — they are what is on screen.
So the recreated widget carries them, through a new `textarea_get_layout`. The outgoing
`fstyle` is deliberately NOT carried: its `families` array points into the dying tree's
computed style, and the widget would hold that pointer from the swap until the reformat.
The freshly derived style points into the live tree instead.

**The coordinates.** The band diff then said the caret sat 2 px left of its settled
place. `html_set_focus` takes the caret's offset from `box_coords` of the focus owner,
and `box_textarea_callback` named `gadget->box`. Mid-window that is the NEW tree's box.
It exists, and the layout pass has never seen it, so every coordinate off it is zero.

That third one is the general defect: **`control->box` is not the box on screen during a
re-conversion.** The damage rectangle of a mid-window keystroke had the same fault. It
was invisible only because the test page's field sits at the document origin — on a page
whose field sits at y=500, a mid-window keystroke damages the wrong rectangle and a
mid-window caret jumps to the top of the page.

## What the fix keeps

`html__reconvert` used to drop each gadget's box pointer, because the box would dangle
after the swap. The box is ALIVE for the whole window, though, and it is the displayed
one. So the pointer moves to `ctl->reconvert_box` instead of vanishing, and
`form_gadget_screen_box()` answers "which box is on screen". Outside a re-conversion the
two are the same box.

Two things fell out of that.

`reconverting` now means exactly "the old tree is still displayed". The flag used to
clear at the end of the completion callback. The caret re-fire after the reformat sits
before that point and needs the NEW box, so with the accessor in place it read a
released pointer and the settled shot lost its caret entirely. Clearing the flag where
the old tree is freed is both the fix and the honest definition.

The two failure paths restore `ctl->box` from `reconvert_box`. Construction had bound
gadgets into the partial new tree, and that tree is freed there, so those pointers were
left dangling. Nothing tested it. It is one line inside a walk that had to exist anyway.

## Step 3 — a page that re-boxes for ever

The ticket asked for a decision: today's behaviour documented, or a re-box rate cap. The
decision is to KEEP today's behaviour, and `todos/NETSURF-JS.md` §12 records it.

The premise "such a page never shows its settled rendering" does not survive a read of
`html__reconvert`. It refuses to start a second pass while one runs; it sets
`reconvert_pending` and returns; the completion callback swaps and then schedules the
next pass. The rate is therefore one pass per pass, which no timer can beat, and every
pass completes and swaps. The page shows its last COMPLETE rendering, refreshed once per
pass. That is a double buffer, and it is what a browser must do.

A rate cap repairs no leak. It makes the displayed frame older, and an old frame is the
whole complaint about such a page. The repair was to stop half-built state leaking into
the displayed frame, which is what this ticket did.

## The test

The T arm's immediate shot was a diagnostic. It gates now, on two things: equal ink AND
zero differing pixels across the field band. The ink count alone would have accepted the
displaced caret — 283 against 285 is a two-pixel difference hiding a 47-pixel one. Any
metric that compresses a render to one number can do that, so the band comparison sits
beside it.

The other three arms print their band numbers but do not gate: their timing does not
GUARANTEE a mid-window sample, so a pass there proves less. All four read 0.

One number is worth keeping: the forced-window page now types glyph for glyph like the
static control at every step — 91 142 165 216 252 285, both. Before the fix the big
page's steps were 91 138 162 216 250 283.

## Left behind, and filed

`todos/0412` (register L60): the select menu's geometry, the select and radio repaints,
and the file gadget all still name `control->box`, so each still takes mid-window
coordinates from an un-laid-out box. The accessor exists; the conversion is mechanical;
the coverage is not written. Filing it was not optional — a comment that names a true
gap and no ticket reads as known and handled.
