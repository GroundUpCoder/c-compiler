# todos/0423 — the patch record now checks itself

`vendor/netsurf/update.sh` states an invariant: a rebuild at the pinned
revisions must reproduce the committed trees byte-identically. No check
enforced the invariant. A hand-edit to a component file that was not
mirrored into `patches/` was a shipped fix that the next rebuild would
delete. This happened twice (todos/0407 landed such edits in `1a0909c4`
and `436a024b`; a person caught them two commits later).

## The design: verify by inversion, not by proxy

The first plan for the gate arm was a proxy: fail a commit that edits a
component file but does not touch the matching `.diff` file. A proxy of
this kind accepts a wrong or truncated hunk. We built the real check
instead. The check inverts the record on each side of a change:

    pristine(F) = reverse_apply(section for F, committed F)

The check then compares the two pristine results byte for byte. A missing
hunk cannot hide, because the reverse application leaves the new code in
the residue. A change to the hunk framing cannot cause a false failure,
because the inversion removes the framing. The comparison is differential:
it trusts the older side. `update.sh --check` validates the base against
real upstream on its own cadence.

## What landed

`vendor/netsurf/patchcheck.mjs` applies the inversion in three layers:

1. **Frame** (standing): each section of each `patches/*.diff` must
   reverse-apply exactly — correct context at the correct line numbers.
   The applier is strict by construction. A fuzzy or offset application is
   a failure, not a pass.
2. **Manifest** (standing): `patches/pristine.json` records the sha256 of
   each pristine residue. An edit that misses every hunk context passes
   the frame check. The manifest catches it at any later time.
3. **Differential** (per change): for each changed component file, the old
   and new residues must be identical. This layer also covers a file that
   no section owns, an added file, and a deleted file.

The layers run in three places. The new `netsurf-patch` suite
(`tests/netsurf/run.js`) runs on each gate; the diff rule for
`vendor/netsurf/` selects it. The pre-commit hook runs `--staged` on each
staged `vendor/netsurf/` change. `update.sh --check` rebuilds from
upstream into the stage, compares the stage with the committed trees, and
installs nothing. The check path cannot reach the install step.

`update.sh` step 3 now applies a patch for every component in
`UPSTREAM.json`, not for a fixed list of six. `patchcheck.mjs` fails on a
`.diff` file that names no component. The README and the `update.sh`
header now state which check enforces the claim and on what cadence. The
full check is a manual step: the owner is the repo maintainer; the cadence
is each `UPSTREAM.json` change and each wholesale `patches/` rebuild.

## Proofs

- The clean tree at the current pins passes `update.sh --check` (exit 0,
  all 10 trees byte-identical, 67/67 sections). A one-character change in
  `libdom/src/core/attr.c` fails it (exit 1, the diff names the line).
  A tree hash before and after both runs shows zero writes.
- A constructed commit that edits a patched file without the `.diff`
  fails the differential. The corrected twin commit passes. Both live as
  scenarios in `tests/netsurf/patchcheck.test.mjs`, with the add, delete,
  first-section, reframe-only, pin-change, and no-newline shapes.
- History pins: `cb4178b6` (the 0422 change, three files, heavy hunk
  reframing) passes. `1a0909c4` (the 0407 drift) fails. Both are test
  cases now.

## Gotchas for the next reader

- Section identity excludes the `---`/`+++` header lines. `diff -urN`
  writes timestamps there, so a regeneration would otherwise mark every
  section as changed.
- A `diff -urN` creation section starts `@@ -0,0`; a deletion section ends
  `+0,0`. The applier maps these to "the pristine file is absent" and
  "the committed file is absent".
- `git reset --hard` keeps a formerly-committed new file on disk as an
  untracked file. The test scenarios clean after each rewind, or each
  scenario would contaminate the next.
- The differential skips a component whose pin changed between the two
  refs, with a note. A pin transition changes every residue;
  `update.sh --check` owns that case.
