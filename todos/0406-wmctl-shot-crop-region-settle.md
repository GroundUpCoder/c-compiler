# 0406 — wmctl shot crop rect: region-scoped settle for never-settling pages

- **Status**: open
- **Design**: `todos/0386-netsurf-mutation-e2e-intermittent-design.md` §4.3 (verified there;
  filed out of `todos/0386` per its §4.4 — the fix that did NOT land under 0386)

## Goal

`pollStable` in the e2e drivers compares whole PPM frames with `cmp -s`. A page with a
live timer repaints some region forever, so no whole-frame predicate can settle on it.
The `0386` test works around this with finite page timers and derived fixed sleeps. That
workaround is per-page. The general seam is missing.

Give `wmctl shot` an optional crop rectangle:

```
wmctl shot SID FILE [X Y W H]
```

Then `cmp -s` on two cropped PPMs is a region-scoped stability predicate, and
`pollStable` generalises to `pollStableRegion` with no new comparison machinery.

The `0386` design pass verified the seam: `shot_to_ppm` already holds the full RGBA
buffer in userspace before it writes the PPM. **The crop is a change to `os/wmctl.c`
alone — no kernel or WMP change.** A kernel-side crop would save bandwidth, but it is
not needed for correctness. Do not bundle it.

## Plan

1. Add the optional `X Y W H` arguments to `do_shot` in `os/wmctl.c`. Clamp the rect to
   the surface. Refuse an empty result loudly.
2. Add a `pollStableRegion` helper beside the `pollStable` shell helper in the consuming
   tests.
3. Convert one live-timer consumer as the acceptance case. The `0386` typing legs are
   candidates: the region settle replaces their derived fixed sleeps.
4. `wmctl` is baked, so the change owes an `os/image.json` bump at merge time.

## Acceptance

- `wmctl shot SID FILE X Y W H` writes a PPM of exactly the requested region.
- A test settles on a static region of a page whose timer region keeps repainting.
- Two-argument `wmctl shot` behaviour is unchanged.
