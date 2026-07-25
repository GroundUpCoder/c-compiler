# NetSurf JS Lane B — the mutation → re-box → reflow → repaint bridge

Branch `netsurf-lane-b` (off `main`, which carries Lane A).  This is the
production build of what the time-boxed spike (`netsurf-lane-b-spike`,
verdict YES, log at `logs/2026-07-26/netsurf-lane-b-spike.md`) proved
possible: JavaScript that changes the DOM now changes what the user sees.

Design doc: `todos/NETSURF-JS.md` — Lane B in the lane breakdown, and the
new §9 for what this lane found the doc and the spike had wrong.

## What was inherited, and why it was kept

The spike's shape survived review unchanged, so it was ported rather than
re-derived: one choke point `html_schedule_reconvert(htmlc)`, fired from
the GENERIC libdom default-action cases in `dom_event.c`, coalesced through
`guit->misc->schedule(0, …)`, then teardown → `dom_to_box` on the live
document → atomic bctx swap → `content_reformat` → invalidate-all.  The
build-then-swap ordering (old tree keeps serving redraw and input while the
new one is constructed) is the load-bearing part and is unchanged.

Two spike fixes carried forward verbatim because both are real upstream
bugs, not scaffolding:

- **`imagemap_addtolist` strtok'd the interned DOM string in place.**  The
  first extraction wrote NULs into the `coords` attribute, so any *second*
  extraction parsed a comma-less string and every area collapsed to
  0,0,0,0.  Invisible upstream because extraction ran exactly once per
  document; the moment a document can be re-boxed it is a live bug.
- **`selection_init`, not `selection_reinit`.**  `reinit` clamps byte
  offsets but leaves `drag_state` latched, and a latched drag swallows
  every subsequent click.

The spike's throwaway drivers (`spike-danger.mjs`, `spike-stopwatch.mjs`,
`test/spike-*.html`) were deliberately NOT carried over; their coverage is
re-expressed as `smoke-js.mjs` legs 6–8 and a kernel e2e.

## The honest v1 is whole-document re-box

Per mutation batch, the whole document is re-boxed.  That is the shipped
answer, not a step toward one: ~1 ms at demo scale, and the 152 ms measured
at 1508 elements is dominated by `convert_xml_to_box` yielding to the
scheduler every 10 nodes, not by layout compute.  Incremental subtree
re-box stays a later optimisation with a named knob
(`max_processed_before_yield`) if a demo ever needs it.  Nothing here is
special-cased to the demo pages.

## What this lane added on top of the spike

### Focus is a box-tree pointer, and dropping it broke typing

The spike's teardown reset `focus_type`/`focus_owner` because
`focus_owner.textarea` is a `struct box *` pointing into the tree being
destroyed — correct, but nothing handed the focus back after the swap.  The
selection and the gadget back-pointers were both re-bound; focus was the
one that was not.

This is not theoretical and it is not Lane C's: typing six characters into
a text field on a page whose timer mutated an unrelated element landed
**52 ink pixels against 285** on an otherwise identical still page.  Every
keystroke after the first mutation was dropped.  Any page that edits the
DOM while the user types — including `todo.html` adding its second item —
was unusable.

Fixed by remembering the focused gadget's DOM node and its caret index
before teardown (`reconvert_focus_node`) and re-binding both to the new box
in the completion callback, after the reformat (the caret's screen position
is only known once layout has run).  Ordering detail worth keeping: claim
the focus with the caret *hidden* first, then `textarea_set_caret` — the
textarea reports its own caret geometry through its `CARET_UPDATE`
callback, which lands on `html_set_focus` again with real coordinates, so
positioning it by hand would just be a zero-height guess for it to correct.

That needed one new public accessor, `textarea_get_caret_char`, the exact
inverse of the existing `textarea_set_caret` (internal state is a byte
offset; the public setter speaks character indices).  Additive, no
behaviour change for existing callers.

Measured after: 285 vs 285 — byte-identical to the still-page control.
That A/B is a committed leg, not a one-off probe.

### Gadget reuse needed three fixes

A gadget survives re-boxing by design (`html_forms_get_control_for_node`
re-finds it by DOM node), which is what makes form state persist.  Three
things hanging off one did not survive:

- **`<select>` duplicated its options.**  Box construction refills the
  option list from the DOM every time; on a reused gadget it appended
  rather than replaced.  Factored the teardown loop out of
  `form_free_control` into `form_select_clear_options` and called it at
  reuse.
- **Textareas leaked.**  `box_textarea_create_textarea` *overwrote*
  `data.text.ta` and `data.text.initial` — one leaked `struct textarea`
  plus one leaked `dom_string` reference per re-box.  Released first now.
- **Formless controls were owned by nobody.**  `<input>` outside any
  `<form>` was searched for only in `c->forms`, so it could never be
  re-found and a fresh gadget was invented on every re-box.  They are now
  adopted onto the content (`formless_controls`), which both makes reuse
  work and fixes an upstream leak — nothing freed them at destroy either.

### The NULL-box class is one guard, not several

The spike flagged `form_radio_set` for a missing `control->box` check.
Every such dereference funnels through `html__redraw_a_box`, so the guard
belongs there once: a gadget with no box — mid-re-conversion, or
`display:none` — is a legitimate "nothing to redraw", and one guard covers
the whole class rather than playing whack-a-mole per call site.

## Proving it, which is most of the work

**A demo that passes with and without the change proves nothing.**  So the
bridge has a build-time kill switch, `-DNETSURF_NO_LIVE_RECONVERT`, which
makes `html_schedule_reconvert` a no-op and restores upstream behaviour.
`smoke-js.mjs` leg 8 builds that variant **from the same tree** (the extra
define is folded into `bin.json` through `buildProject`'s read callback —
no second checkout, no string surgery on sources) and requires both demo
pages to plot nothing changing while their JS handlers demonstrably still
run.  It refuses to pass if the two binaries come out the same size.

Choosing an `#ifdef` over patching sources in the harness was deliberate:
a textual patch that silently fails to match would produce a *false* result,
which is the estate's "silent symptom" anti-pattern.  The compiler either
honours the define or the build fails.

Three mutation classes are covered by the two demos, and each is
independently drivable: character data (`stopwatch.html`'s `textContent`
tick), element insert/remove (`Lap`, and `todo.html`'s rows), and attribute
change that must **re-select styles** (`todo.html`'s counter flipping
between `.empty` and `.some`).  The restyle half is asserted by pixel
colour in the kernel e2e, because monkey's plot stream carries no colour.

Gotcha that shaped both demos: **mutations made during the parse are not
bridge traffic.**  Script running at load mutates while
`htmlc->parser != NULL`, so the reconvert declines and the normal load-time
conversion picks it up.  Useful — a page can seed itself and still render
with the bridge off — but it means a page whose only mutations happen at
script time proves nothing.  `todo.html`'s two seed rows are therefore the
*control*; only the post-load clicks are the proof.

### The scroll check the spike deferred

The spike called scroll preservation "preserved by construction —
frontend-owned and document-relative" from a code read, and explicitly left
the live check to this lane.  It is a measurement now, not an argument:
a purpose-built ruler page of 50 solid blocks whose colour *encodes* their
index, so a screenshot can be decoded back to an exact scroll offset by
finding a colour boundary.  The e2e scrolls 700 px, decodes the offset
either side of two re-conversions, and requires it unchanged **and
non-zero** — a check that passed at offset 0 would be vacuous.  It also
requires the re-conversions to have actually repainted, and to have
repainted only inside the one mutating block, so "the offset did not move"
cannot be satisfied by nothing happening.

## Findings handed to other lanes, not fixed here

- **`keydown` is fired at the document ROOT**, not the focused element, so
  a listener must sit on `document`.  And **Enter reaches JS with
  `event.key === null`** — `fire_dom_keyboard_event`'s special-key table
  has no `NS_KEY_CR`/`NS_KEY_NL`/`NS_KEY_TAB` case.  §6's demo-5 sketch
  assumed "text input + Enter/keydown"; that half is not possible today, so
  `todo.html` adds with a button.  **Lane C.**
- **`Date.now()` has one-second resolution.**  duktape's platform probe
  does not recognise this target and falls through to its "unknown OS"
  branch (`duk_config.h:853` → `DUK_USE_DATE_NOW_TIME` → `time()`).
  Verified two ways: 200 000 consecutive calls returned one value ending in
  `000`, and a direct `gettimeofday` probe through our own libc showed real
  microsecond resolution — so the limitation is duktape's config, not ours.
  One line in `duk_custom.h` fixes it, but it changes JS `Date` semantics
  estate-wide and wants its own verification.  **Lane D.**  Until then
  `stopwatch.html` counts `setInterval` ticks rather than lying about
  tenths it cannot measure.

Still open by choice (recorded in §9): `html->forms` is built once, so a
JS-inserted `<form>` is not a real form; dynamically-inserted stylesheets
still hit the static `select_ctx` wall; an in-progress text *selection*
inside a field does not survive a re-box (the caret does).

## Gate

- `vendor/netsurf/smoke-js.mjs` — 8 legs, all pass.  Legs 1–5 are Lane A's
  (unchanged and still green), 6–7 the demos, 8 the A/B baseline.
- `vendor/netsurf/smoke.mjs` — the JS-off v1 path, still green.
- `tests/kernel/test_netsurf_mutation_e2e.js` — NEW: timer-driven
  `textContent` reaching real pixels with zero input, a real SDL click
  inserting *and* removing an element, the scroll-offset decode, and the
  typing A/B.  Registered in `tests/kernel/run.js`.
- Regression: `test_netsurf_e2e`, `test_netsurf_layout_e2e` (the form-control
  rendering leg is the one that would catch the gadget-reuse changes),
  `test_netsurf_content_e2e`, `test_netsurf_js_e2e` — all pass.
- Flake gate (repo rule for a new e2e): 3/3 stable under CPU load ×10, 0%.

**`image.json` was deliberately NOT bumped.**  The seeded `/usr/bin/netsurf`
changes, so the version does need to go up for browser OPFS images to
re-fetch — but image numbering is the integrating owner's to assign, after
two lanes silently collided on 164 last round.
