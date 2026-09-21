# 0410 — netsurf: an `img` never renders again after a Lane B re-conversion

- **Status**: done (2026-07-29, branch `0410-netsurf-img`) — **verdict: FIXABLE**,
  port-local, one branch in `content/handlers/html/object.c`
- **Design**: —

## Verdict — fixable, and the discriminator that proves it

The Stage 1 instrument answered the ticket's question first, before any change.
Temporary `NS0410` stderr lines were put on `html_fetch_object`, `html_object_callback`,
`html_object_done`, `hlcache_find_content` and `html__reconvert`. The instrument was
removed again before the fix commit.

The result of one click-triggered re-conversion, in order:

| # | Instrument line | Answer |
|---|---|---|
| 1 | `reconvert_start num_objects=2 active=0` | the teardown runs |
| 2 | `fetch_object url=…spectrum.png box=0x2177e0 err=0` | **the refetch IS issued** |
| 3 | `find_content handle=… entry=reused status=2` | the hlcache reuses the `DONE` content |
| 4 | `obj_cb ev=2` / `ev=3` / `ev=4` | **the callback DOES fire — LOADING, READY, DONE** |
| 5 | `obj_done box=0x2177e0 handle=…` | **the box IS re-bound to the content** |

So every link the ticket suspected is intact. The refetch completes and the object
reaches its new box. The failing link is the NEXT one: **nothing lays the document
out again**, so the box never gets ink.

`html_object_callback`'s completion tail has two branches, and a post-load completion
falls between them:

- The all-objects-arrived branch reformats and calls `content_set_done`, but it is
  gated on `base.status == CONTENT_STATUS_READY`. A re-conversion's refetch lands on
  a document that is already `DONE`, so this branch is skipped.
- The `incremental_reflow` branch is throttled by `base.reformat_time`. The swap's own
  `content__reformat` had just set that clock at least 250 ms ahead
  (`min_reflow_period` is 25, times 10). The check is a single test with no retry, so
  the one chance is silently dropped.

A box that already knows its size is unharmed: `html_object_done` binds the content and
the `REPLACE_DIM` path broadcasts its own redraw. A box that needs the object's
**intrinsic** size is not. It keeps zero height for ever. That is why an `img` with
both `width` and `height` survived and the deck's width-only `img` did not — the
attribute pair is what sets `REPLACE_DIM` (`box_image` in `box_special.c`).

**Why this is port-local, not a NetSurf invariant**: upstream never reaches this state.
Without the Lane B mutation bridge no fetch is ever issued against a `DONE` document,
so upstream needs no `DONE`-status completion branch. The window is ours.

**This mechanism is NOT `todos/0386`'s.** `0386` was the input routing table staying
live across the swap. This is a layout pass that never runs. The two share a window and
nothing else.

## Fix

`content/handlers/html/object.c` gets the `DONE`-status twin of the READY completion
branch: when the last outstanding object completes against a document that already
finished loading, reformat and request a full redraw. Completions that land **during**
a re-conversion window are skipped on purpose, because the swap's own reformat runs
after them and lays out the already-bound object.

The branch is written at the general content-object altitude. It serves any object
fetched post-load, which includes a script-inserted element, not only an `img`.

## Acceptance record

- **Kernel e2e leg**: `tests/kernel/test_netsurf_img_reconvert_e2e.js`. A deck-shaped
  page, a width-only `img` on a never-moving base layer, and three cover toggles.
  Ink after the 1st and the 3rd re-conversion: `a=0 b=40000 c=0 d=40000` against a
  full-image budget of 40000. The assertion is ink, not the absence of an error.
- **The story-repo one-file deck** renders its image slide after navigation. Ink on
  slide 3 reached forward = **26058**; reached backward from slide 4 = **26058**; the
  verified-working static form `s3.html` = **26058**; the negative control with the
  `<img>` removed = **4233**. The image contributes 21825 ink pixels and the navigated
  one-file deck matches the static page exactly. The deck stayed private — its files
  rode a throwaway test image only, and nothing deck-related is in the diff.
- **`todos/0411` is untouched and unclaimed.** The image cache ceiling was not raised.
  The deck asset fits the current ceiling, which is what keeps the two independent.

## Goal

In gucOS NetSurf, an `img` renders on first load and then **never renders again after the
first DOM mutation**. Any class toggle schedules the port's whole-document
re-conversion (Lane B). After that re-conversion, the image content does not come back —
from any hiding or showing mechanism — until a fresh page load.

The control is built in and it isolates the trigger: the sibling deck form that performs
**no** mutation renders its image on **every** arrival. Mutation is the trigger, not
navigation and not the asset.

Authorised by jku, 2026-07-29: *"I would like images to work as well, want to see if this
is a fundamental NetSurf limitation or if we can fix."*

## The rule this ticket is about

`todos/0386` established the rule for **interaction state** across the re-conversion
window. This is the sibling class — **content objects** — and it needs its own rule at
the same altitude, not an extension of `0386`'s:

> **Content objects torn down at reconvert-start must be re-fetched and re-bound at the
> swap; a refetch issued against an already-`DONE` content must still deliver its
> completion callback.**

🔴 Do **not** inherit `0386`'s mechanism just because the two share a window. `0386` was
about the input routing table staying live and being re-bound. This is about a content
object's fetch completing. Reusing `0386`'s explanation here would make a wrong mechanism
sound established.

## The suspect is a DISCRIMINATOR, not a verdict

`html__reconvert`'s own comment states that construction refetches through the hlcache.
The refetch appears not to complete on a post-load content. So the suspect is the
**object fetch/callback path when `base.status` is `DONE`** — *not* the teardown.

🔴 **First diagnostic step: instrument whether the hlcache callback fires at all on the
re-conversion, before touching the teardown.** Discriminator first. That sequencing is
what made `0386` work, and the kickoff should copy its shape
(`~/git/meta/meta/notes/kickoff-0386-fix.md`).

`html__reconvert` exists in both `vendor/netsurf/patches/netsurf.diff` and the checked-out
`vendor/netsurf/netsurf/` tree. Keep the patch file and the tree in sync, and round-trip
the diff.

## "Fixable, not fundamental" is a hypothesis, not a verdict

Evidence **for** fixable:

- The re-conversion is **port-local**. Upstream NetSurf never re-converts, so this is our
  window, not an upstream invariant.
- Forms, textareas and imagemaps **already** survive the swap through targeted re-binds.
  A re-bind path demonstrably exists for other object classes.

The lane must stay free to return **"fundamental"** with evidence. Do not write the
conclusion into the plan.

## Scope boundary

This ticket is the **refetch/callback lifecycle** only. The image **cache ceiling** is
`todos/0411` and is a different mechanism (sizing/config, no mutation needed, fails even
at load). They are **independent, not a pair**. Do not bundle them — a bundled lane can
close having fixed only half.

The deck's own asset (`spectrum-1000.png`, 1000×438, ≈1.7 MB decoded) **fits** inside the
current ceiling, which is exactly why this defect is isolable from `0411`.

## Acceptance

- A kernel e2e leg that **clicks away and back** over a page containing an `img`, and
  asserts the image renders after the mutation-triggered re-conversion. Assert on ink,
  not on the absence of an error.
- The story-repo one-file deck renders its image slide **after navigation**.
- A stated verdict — fixable or fundamental — with the callback instrumentation that
  distinguishes them.
- Gate artifact checked before the ticket closes: read `build/test-kernel/summary.json`
  directly, completion off the top-level `files` block, and **tally `results[].status`** —
  `recorded == total` is coverage, not pass.
- `todos/LIABILITIES.md` re-anchored or extended in the same commit if any anchored line
  moves.

## Notes

- Needs a **quiet box** for the e2e leg.
- 🔴 The deck stays **private**. The `013` deck must never be seeded into the published
  gucOS image.
- Image bump: **derive** it from the rule table in `todos/CLAUDE.md` at merge time. A
  change under `vendor/netsurf/` bakes `/usr/bin/netsurf` and owes a bump. `main` is at
  **191** as of `29d0c2b7`; do not assert a number ahead of the merge.
