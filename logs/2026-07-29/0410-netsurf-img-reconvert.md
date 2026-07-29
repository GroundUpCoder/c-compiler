# 2026-07-29 — todos/0410: an `img` never rendered again after a re-conversion

Branch `0410-netsurf-img`, from `origin/main` at `aed9fe03`. Image 191 to 192.

## The defect

In gucOS NetSurf an `img` rendered at load and then never again. Any class
toggle schedules the port's whole-document re-conversion (Lane B). After that
re-conversion the image did not come back, from any hiding or showing
mechanism, until a fresh page load.

## The discriminator came first

The ticket named a suspect but called it a discriminator, not a verdict. So the
first step measured the suspect instead of changing it. Temporary `NS0410`
stderr lines went on the fetch, the callback, the bind, the hlcache lookup and
the re-conversion entry. One click-triggered re-conversion answered every
question at once:

- the refetch **is** issued (`fetch_object … err=0`);
- the hlcache reuses the already-`DONE` content (`entry=reused status=2`);
- the callback **does** fire, with LOADING, READY and DONE;
- the box **is** re-bound (`obj_done box=…`).

Every link the ticket suspected was intact. That is what made the next link
visible: nothing laid the document out again.

## The mechanism

`html_object_callback` ends with two completion branches, and a post-load
completion falls between them.

The all-objects-arrived branch reformats and sets the content done. It is gated
on status `READY`. A re-conversion's refetch lands on a document that is
already `DONE`, so the branch is skipped.

The `incremental_reflow` branch is throttled by `reformat_time`. The swap's own
reformat had just pushed that clock at least 250 ms ahead. The check is one
test with no retry, so the single chance is dropped in silence.

A box that already knows its size survives this: the bind is enough, and the
`REPLACE_DIM` path broadcasts its own redraw. A box that needs the object's
intrinsic size does not. It keeps zero height for ever.

That is why the shape of the tag decided the outcome. An `img` with **both**
`width` and `height` sets `REPLACE_DIM` and always worked. The deck's
width-only `img` did not, and never came back. My first probe used a
both-attributes `img` and showed no defect at all — the probe was wrong, not
the engine. The width-only A/B is what exposed it.

## Why this is not upstream's problem

Upstream NetSurf never re-converts, so upstream never fetches against a `DONE`
document. The missing branch is a consequence of our mutation bridge. The
window is port-local, and so is the fix.

## Not `0386`'s mechanism

`todos/0386` was the input routing table staying live across the swap. This is
a layout pass that never runs. The two share the re-conversion window and
nothing else. Citing `0386` here would have made a wrong mechanism sound
established.

## The fix

`content/handlers/html/object.c` gets the `DONE`-status twin of the READY
completion branch. When the last outstanding object completes against a
document that already finished loading, reformat and request a full redraw.
Completions that land during a re-conversion window are skipped on purpose,
because the swap's own reformat runs after them.

The branch sits at the general content-object altitude. It serves any object
fetched after load, a script-inserted element included, not only an `img`.

`vendor/netsurf/patches/netsurf.diff` and the checked-out tree are in sync. The
round-trip was proved: the committed diff reverse-applies to a pristine
`aed9fe03` tree, the new diff forward-applies to that, and `diff -r` against
the live tree reports no difference.

## Numbers

- Kernel e2e leg `test_netsurf_img_reconvert_e2e.js`: ink `a=0 b=40000 c=0
  d=40000`, full-image budget 40000.
- The story-repo one-file deck, slide 3 after navigation: ink 26058 forward,
  26058 backward, against 26058 for the verified static `s3.html` and 4233 for
  the same page with the `<img>` removed.
- Kernel suite 129/129 pass, unfiltered, carried 0, recorded 129 of 129.
- Browser sweep 41/41 pass, unfiltered, carried 0, recorded 41 of 41.
- todos suite 5/5, `queue.js check` OK at 124 items and 45 liability entries.

The deck stayed private. Its files rode a throwaway test image only, and no
deck content is in the diff.

`todos/0411` (the image cache ceiling) is untouched and unclaimed. The ceiling
was not raised. The deck asset fits it, which is what keeps the two tickets
independent.
