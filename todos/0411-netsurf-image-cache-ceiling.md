# 0411 — netsurf: the image cache ceiling is too small for a large decoded image

- **Status**: open
- **Design**: —

## Goal

A large image never renders in gucOS NetSurf, **even at load**, because the decoded
bitmap does not fit the image cache.

Stated sizing, to be re-verified against source by the lane rather than trusted from this
ticket:

- the core memory cache defaults to **12 MB** (`desktop/options.h`);
- the image cache takes about **a quarter** of it (`desktop/netsurf.c`) — roughly **3 MB**;
- a decoded **3200×1400** PNG needs about **18 MB**, so it never renders.

This is a **sizing/config** defect. It needs **no mutation** to reproduce, which is what
separates it from `todos/0410`.

Authorised by jku, 2026-07-29, alongside `0410`.

## Scope boundary — independent of `0410`, not a pair

`todos/0410` is the `img`-after-re-conversion defect: an object refetch/callback
lifecycle bug that requires a mutation and fails only after the re-conversion. This
ticket fails at **first load** and needs no mutation.

They are **independent**. Filed separately on purpose: bundling would let a lane close a
combined ticket having fixed only one mechanism. Neither ticket may claim the other's
acceptance.

The deck asset (`spectrum-1000.png`, 1000×438, ≈1.7 MB decoded) **fits** the current
ceiling. It is therefore evidence for `0410` and **not** evidence for this ticket. Do not
use it here.

## Fix

Size the caches for the gucOS target rather than inheriting the upstream desktop
defaults. The lane owes:

- the **measured** decoded footprint of the failing image, not an estimate;
- the actual constants and the code path that derives the image cache from the core
  cache, read from source;
- a chosen ceiling with a **stated rationale** — what it costs in memory on the gucOS
  target, and why that cost is acceptable. A number with no rationale is not the
  deliverable.

Consider the behaviour when an image genuinely exceeds whatever ceiling is chosen. Silent
non-rendering is the current failure and is the worst option; a bounded, observable
outcome is better. Say what happens at the new limit.

## Acceptance

- A decoded image **above the old ceiling** renders **at load**, asserted on ink.
- The chosen ceiling, its memory cost, and its rationale are recorded in the ticket and
  the dev log.
- Behaviour at the new ceiling is stated and, if the lane implements one, tested.
- Gate artifact checked before the ticket closes: read `build/test-kernel/summary.json`
  directly, completion off the top-level `files` block, and **tally `results[].status`** —
  `recorded == total` is coverage, not pass.
- `todos/LIABILITIES.md` re-anchored or extended in the same commit if any anchored line
  moves.

## Notes

- Load-time acceptance. **No mutation** is involved, and none should be introduced to
  reproduce it.
- Image bump: **derive** it from the rule table in `todos/CLAUDE.md` at merge time. A
  change under `vendor/netsurf/` bakes `/usr/bin/netsurf` and owes a bump. `main` is at
  **191** as of `29d0c2b7`; do not assert a number ahead of the merge.
