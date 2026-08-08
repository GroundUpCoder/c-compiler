# #580 — mkpkg publishes ADDITIVELY; removal becomes explicit `--prune`

Ticket #580, lane-580additive (paired with a comguc change of the same branch
name — the split `--image-only` / `--packages-only` deploy modes live there).

## What changed

`tools/mkpkg.js` used to treat `index.json` + `pool/` as one repo that every
build REPLACES: the index was rewritten to exactly the invocation's
enumerable names, and the orphan prune deleted every payload the fresh index
did not name. Now the publish is an UPSERT:

- Entries in the previously published index whose names this invocation
  cannot enumerate (gated behind a producer flag not passed, or definition
  removed) are **carried forward**, and the orphan prune keys off the merged
  index — so their payload bytes survive too.
- `--prune` is the explicit removal path: it drops the unknown entries (each
  logged by name) and then the prune deletes their now-unreferenced payloads
  from the private view. Shared `--pool` stores stay append-only, unchanged.
- A carried entry whose payload bytes are missing from both the view and the
  store refuses at exit 1 naming `--prune` — an index row that 404s is worse
  than either keeping or dropping the entry deliberately.
- A prev index with an unknown `schemaVersion` refuses rather than merging
  entries whose shape this tool cannot judge.
- `materializeView` accepts a live payload that exists only in the view
  (carried entries can predate `--pool` or survive a store reclaim).

## Why (the honest framing)

This was NOT a currently-bleeding regression. The 41-deploy episode (base
builds unpublishing the -clang set) was already mitigated by todos/0337
making the clang superset the deploy default — one builder publishes one
superset index. But that mitigation is exactly what blocked jku's 2026-08-08
ask ("base image update should not necessarily trigger package updates and
vice versa"): "always publish the superset" cannot survive independent
release cadences, because an independent package publish would still REPLACE
the index and an image-only deploy would rewrite it back. Additive publish
removes the replace-not-merge property itself.

Design note: the ticket offered (a) merge against the local published index
or (b) per-producer index fragments merged at publish time. (a) shipped: the
deploy box is single-writer, the `.mkpkg-lock` already serializes same-dir
builds, and (b)'s machinery buys protection against a multi-writer race this
repo does not have. If a second independent publisher ever appears, (b) is
the recorded upgrade path.

The deploy/test split caveat stands: this buys independent RELEASE cadence;
it does not by itself cut the full test gate (the test fixture folds all
packages back in — per-package gate scope is #576 territory).

## Evidence

- Red control first, on the unmodified tool @2344fa80: publish {iso-alpha,
  iso-common} → publish {iso-common} into the same out dir dropped iso-alpha
  from the index AND deleted its payload bytes.
- Post-change: the same sequence keeps iso-alpha (index + bytes) — the UNION.
  `--prune` reproduces the destruction on demand; missing carried bytes
  refuse at exit 1.
- `tests/serve/test_mkpkg_isolation.js` reworked: UNION legs (the #580
  regression guard), the RED CONTROL moved to `--prune` (the instrument
  provably still fires), a SERVABLE refusal leg — all 20 pre-existing 0388
  legs (isolated repos, append-only shared store, hardlink view, lock)
  unchanged and green. 33/33.
- comguc `scripts/test-publish-split.mjs` (real pipeline, two bakes): an
  `--image-only` build leaves `/packages` byte-identical (positive-controlled
  comparator); a `--packages-only` build leaves the image half untouched by
  mtime+size and republishes the repo. 12/12.

## Gotchas for future readers

- The purity story is unchanged where it matters: enumeration (`listPackages`,
  `foldPackages`) still excludes gated names by construction — the BAKE can
  never absorb a -clang package. Only the published *index* carries foreign
  entries now, which is the deployed superset's intended shape.
- comguc's `--no-clang` therefore no longer means "ships a base index": the
  carried -clang entries stay published, just un-refreshed. build-info.json's
  `clang` field is now derived from the shipped index content, not the flag.
