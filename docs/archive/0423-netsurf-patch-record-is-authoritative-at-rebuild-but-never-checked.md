# 0423 — the netsurf patch record is authoritative at rebuild, but nothing checks it

- **Status**: done
- **Design**: —

## Goal

`vendor/netsurf/patches/` holds six curated `.diff` files (`netsurf`, `libcss`, `libdom`,
`libhubbub`, `libnsfb`, `libparserutils`). `vendor/netsurf/update.sh` applies them at step
3 to rebuild the vendored trees from upstream at the `UPSTREAM.json` pins.

The script's own header states the invariant:

> Running it against the pinned revisions must reproduce the committed trees
> byte-identically.

`vendor/netsurf/README.md` repeats it, and adds `(verified)`.

**Nothing checks that invariant.** Three separate measurements, all made on
`2abc8b4b`:

1. **`update.sh` does not verify — it overwrites.** Step 6 does `rm -rf "$HERE/$c"`
   followed by `cp -R "$STAGE/$c" "$HERE/$c"` (`vendor/netsurf/update.sh:104-109`). The
   committed tree is deleted and replaced by the rebuilt stage. If the committed tree had
   drifted from the record, the drift is not reported. It is **silently destroyed**.
2. **Step 7's "drift gate" is a different gate.** It runs
   `node relativize.mjs "$HERE" --check` (`update.sh:114`), which checks *include
   relativization* on the installed tree. It does not compare the rebuild against what was
   committed.
3. **No suite, tool, or build step references `patches/`.** A repo-wide grep over `*.js`,
   `*.sh`, `*.py`, `*.mjs`, `*.json` and `*.md` finds the directory named only in prose:
   `todos/NETSURF-JS.md`, `todos/0386` §4.2, `vendor/netsurf/demos/README.md`,
   `logs/2026-07-29/0410-…`, and two closed tickets in `todos/done/`.

So the record is not a stale document that someone will eventually notice. It is the
**source of truth at the next upstream drop**, and a hand-edit to
`vendor/netsurf/netsurf/…` that is not mirrored into the matching `.diff` is a shipped fix
that `update.sh` will delete.

**The drift window is real, not theoretical.** `todos/0407` landed its NetSurf source
changes in `1a0909c4` and `436a024b`; neither commit touched `patches/`. The patch record
caught up two commits later, in `81eefe0f` ("…, patch record"). A person remembered. For
the same reason, `todos/0386` §4.2 already treats `patches/netsurf.diff` as authoritative
while nothing confirms it matches the tree it describes.

## Prior art — the check has already been run BY HAND, once

🟢 The `0412` lane executed exactly this round trip on 2026-07-29 while regenerating
`patches/netsurf.diff`, and reported: *"regenerated; verified pristine + diff == live tree
for all 49 files."* It also found that a naive regeneration **differs from the committed
diff only in hunk framing** (a different diff heuristic), and spliced per-file sections to
keep untouched sections byte-identical.

⭐ **That settles feasibility and names the two traps before the lane starts:** the check is
achievable, and a byte-comparison of the `.diff` itself would produce false failures from
hunk framing alone. **Compare the applied TREES, not the diff text.** Ask the `0412` lane's
thread for the recipe it used rather than re-deriving it.

## Plan

1. Add a check-only mode to `update.sh` — for example `--check`. It must run steps 1 to 5
   into the stage, then **diff the stage against the committed trees** and exit non-zero on
   any difference, instead of installing. Do not let the check-only path reach step 6.
   🔴 Compare trees, not diff text (see the prior art above).
2. Decide, and record, whether the check can run in CI at all. It needs the network, `git`,
   `perl`, `gperf`, `cc` and `node`. If it cannot run in the normal gate, add it as an
   explicitly named manual step with an owner and a cadence, and say in the README that the
   claim is checked **on that cadence**, not continuously. Do not leave `(verified)` in the
   README unqualified.
3. Add the cheap half that CAN run in the gate: a suite arm that fails when a commit
   changes a file under `vendor/netsurf/<component>/` that the matching
   `patches/<component>.diff` claims to own, without changing that `.diff` in the same
   commit. This catches the `0407` shape at commit time, needs no network, and is a strict
   subset of the full check.
4. Correct the two prose claims to state what is actually enforced.

## Acceptance

- `update.sh --check` (or the chosen spelling) exits non-zero on an injected one-character
  drift in a committed tree, and exits zero on the clean tree at the current pins.
- The check-only path never writes into `vendor/netsurf/<component>/`.
- The gate-side arm fails on a commit that edits a patched file without touching its
  `.diff`, proven against a deliberately constructed commit.
- `vendor/netsurf/README.md` and the `update.sh` header state which check enforces the
  byte-identical claim, and how often it runs.
