# #630 — the created-dir claim survives any remove+reinstall interleaving

The #624 lane found (live, in its session-D sequence) that force-removing the
srclib tier creator while a dependent's plants keep the tiers non-empty, then
reinstalling, permanently orphans the tier-dir recording: the reinstall sees
the dirs alive and never re-records them, so no later remove can ever rmdir
them. The lane worked around it in the test; this ticket fixes the mechanism.

## The bug is the LIFETIME of a fact, not a srclib special case

"gucman created this dir" is a fact whose lifetime is the dir's — but it was
stored in the creator's per-package record, whose lifetime is the creator's
install. All three recorded families (`srclib_dirs`, `menu_dirs`,
`seed_dirs`) share the identical existence-check hole (`gm_tier_mkdir`,
`gm_seed_mkdir`, the `made_root`/`made_group` menu sites), and for menu/seed
dirs the interleaving does not even need `--force`: those families carry no
deps edge, so a plain remove of the creator reaches it.

## Why claim TRANSFER, not adoption, is the primary mechanism

The ticket's option (a) — "on install, adopt existing dirs no other record
claims" — cannot be the whole fix, for two measured reasons:

1. **Adoption is install-side, so it misses removal-only interleavings.**
   Install creator → install sharer → remove creator (claim dies) → remove
   sharer: residue, and no install ever happens afterwards to adopt it.
2. **Adoption cannot prove provenance outside the srclib tiers.** An
   existing-but-unclaimed dir under /root may be the user's own `mkdir`;
   /etc/menu is a *documented* hand-customization target (wm reads it).
   Adopting those would let a remove delete a dir gucman never made — worse
   than the residue.

So the primary mechanism is remove-side **claim transfer** (`gm_dirs_replay`):
when a recorded dir survives its rmdir with ENOTEMPTY, the claim migrates
into a surviving installed record whose own recorded plants lie inside the
dir (any planted-path array, seeds' `{path}` included — such a package's own
remove is guaranteed to revisit the dir). Atomic record rewrite, the #624
backfill precedent. Provenance stays *exact* by construction: claims only
ever originate at a real `mkdir`, so no exclusion lists are needed anywhere,
and the mechanism is uniform across all three families. The transferred
entry is inserted before the first existing entry inside it, keeping every
array ancestors-first so the reverse replay stays innermost-first (the
`/etc/menu` + `/etc/menu/<group>` pair is the case that breaks if you
append blindly). The transfer is idempotent (a crashed remove re-runs;
an already-present claim is skipped).

When NO surviving record has content inside — only user files remain, e.g. a
kept-modified seed or a hand-added header — the claim lapses with the dir
correctly kept: it holds user data, and deleting the claim's *record* while
the *dir* has user content is the right outcome. Residual: if the user later
empties such a dir by hand, it stays (for the srclib tiers adoption heals it
on the next install; for menu/seed dirs it does not — accepted, see below).

## Adoption is the LEGACY-repair supplement, srclib tiers only

Fleets running shipped ≤ v252 may already hold orphaned tiers; transfer
cannot heal an orphan because no claim exists anywhere to transfer. So
`gm_tier_mkdir` adopts an existing tier that no installed record's
`srclib_dirs` claims. This is sound for exactly `/usr/local/include` and
`/usr/local/src` because — measured, not assumed —

- neither ships in ANY image: the user seed section creates only
  `/root/**`, `/root/roms`, `/etc/profile`, and the fat fold's srclib twin
  plants at sealed `/usr/include` + `/usr/src` (`os-common.js` fold, claim()
  paths), never under `/usr/local`;
- the worst case against a hand-`mkdir`'d tier is an rmdir that fires only
  once the dir is EMPTY, at a standard FHS location (the dpkg shared-dir
  precedent).

Menu and seed dirs get NO adoption (provenance undecidable, above). Their
legacy orphans from ≤ v252 are accepted as residual: transfer stops new ones
forming, the deployed fleet is small, and an orphaned empty `/etc/menu`
group is behaviour-neutral under the 0259 union-menu semantics.

## Cost, measured

The claim scan (`gm_dir_claimed`) and the transferee scan parse every
installed record under `/var/lib/gucman` — the SAME cost class as #624's
reverse-dependency guard, which already runs on every remove. Records list
every payload path (win32 ≈ 339 members ≈ tens of KB of JSON; ≤ 128
records by `GM_LIST_MAX`); the scan runs once per adoption candidate at
install and once per kept dir at remove — single-digit ms against the
in-OS fs. No new store, no crash-consistency pair: the per-package record
stays the one source of truth, mutated only by the existing atomic writer.

## Positive control

The new legs against the PRE-fix binary (5e2242a7's gucman.c, same test
file): **16 FAILED, every one a #630 instrument** — the two transferred-claim
greps, the restored last-package-drops-the-tiers pair (the exact historical
red the #624 lane saw), the adoption legs, the no-transferee legs, and the
menu/seed session-G legs. Post-fix: full-file PASS. The #624 refusal-only
workaround in session D is gone — the real interleaving is inserted and the
existing legs pass with it.

gucman.c is a bake input → image.json 252 → 253, resealed
`--packages=all`.
