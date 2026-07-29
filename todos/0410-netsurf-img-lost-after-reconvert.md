# 0410 — netsurf: an `img` never renders again after a Lane B re-conversion

- **Status**: open
- **Design**: —

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
