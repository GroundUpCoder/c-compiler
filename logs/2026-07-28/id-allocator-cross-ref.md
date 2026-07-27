# todos/0358 — id allocation across all refs, and the check that says a collision landed

Two id collisions landed this week and **both lanes were correct when they
allocated**. `queue.js add next` derived the next id from the *current
branch's* `todos/*.md`; lanes push at the end, so any single ref — `origin/main`
included — is a **lower bound** on the id space, not the id space.

- `0318` and `0338` each took `0354`; master renumbered one to `0356` at merge,
  and four references by hand with it (ticket body, `queue.json`, the register's
  `ticket:` field, the lane's dev log).
- The register collided **identically**: two different `L44` entries, renumbered
  to `L46`. It had no allocator at all — entries were numbered by eye off
  whatever ref the lane happened to be on.

## What shipped

`todos/idspace.js` — one module owning both id spaces, because the bug's real
shape is *"a lane-allocated id space with no cross-ref allocator"*, and the last
time we wrote the lesson down it said "ticket ids" while the register collided
one field over.

`queue.js add next` / `queue.js next-id` / `liabilities.js next-id` go through
it. Each prints what it surveyed (`derived across 55 ref(s) / 30 todos trees +
the working tree (highest existing: 0359 on refs/heads/…)`) — the ref count is
the only thing that tells a lane whether the survey actually saw the other
lanes.

**Independent confirmation**: run against `origin/main` the new allocator
returns `0360` and `L47` — exactly the cursors the coordinator had derived by
hand for this lane's kickoff.

### Read TREES, not diffs

The obvious cheap survey is a diff scan:

```
git log --all -p -- todos/LIABILITIES.md | grep -oE '^\+### L[0-9]+'
```

It runs in 40ms and it is **wrong**: `git log -p` prints no diff for merge
commits by default. Measured on this repo it reports `L45` as the maximum while
`origin/main`'s register carries `L46` — and `L46` is precisely the entry a
*renumber-at-merge* created, i.e. the failure mode is worst exactly where these
collisions get resolved. The shipped survey resolves `<ref>:todos` and
`<ref>:todos/LIABILITIES.md` for every ref through one `git cat-file
--batch-check`, dedupes by object id (55 refs → 30 distinct trees, 11 distinct
register blobs) and reads each object once. ~0.45s including node startup.

### Refuse, don't degrade

Item (4) of the ticket asked whether the allocator should refuse when it cannot
see all refs. **It refuses** when git is unreachable at all (not a repo, no git
binary) — `--local-ids` / `--local` is the explicit opt-out and labels the id as
a lower bound in its own output.

The reasoning is the cost matrix, not caution for its own sake. A silent
duplicate costs a merge-time renumber across four references, discovered by a
human at the worst possible moment; a refusal costs one flag. And more to the
point: an allocator whose whole purpose is cross-ref visibility, silently
returning the working-tree bound, **is the pre-fix behaviour under a new name**
— which is the exact pattern this ticket exists to kill.

A repo with zero refs (a fresh `git init`, which is what the temp trees in
`queue.test.js` are) is *not* a refusal: git answered truthfully that there is
no history. It prints `no refs (this repo has no history yet)`.

What it still cannot detect is a **stale fetch** — filed as `todos/0360` with
register entry `L47`, rather than left as a comment claiming it is unfixable.

## The check that was missing (and the one that was not)

The kickoff's premise was that `liabilities.js check` passed green on the
duplicate `L44`. **It did not, and could not.** `parseRegister` has rejected a
duplicate entry id since the register was created (`81ae8841`, todos/0286), with
a test for it (`RED: a duplicate entry id fails`). The two `L44`s were never in
the same file — one per branch — so the check had nothing to fire on. That check
can only ever fire *after* the merge, which is why the allocator is the fix and
the check is the backstop.

The instrument that really was silent was the **ticket** side, and nobody had
looked:

```
$ ls todos/*.md
todos/0001-a.md    todos/0001-lane-b-version.md
$ node todos/queue.js check
check OK — 1 item(s), 0 done, 0 liability entries (0 pinned).
```

`scanDir`'s `Map` collapsed the pair, so the second file **stopped existing** for
every validator — including "every open file must be listed exactly once", which
is the one that would otherwise have caught it. That is what a landed collision
looks like on disk, and `check` called it OK. It now fails, naming both files
and pointing at `next-id`.

### It found a real one immediately

Turning the check on made `main` red: `todos/done/0275-kernel-text-service.md`
and `todos/done/0275-kernel-text-service-design.md`. That is not a collision —
it is a committed design doc filed beside its ticket, a documented category
(CLAUDE.md's "Design/topic docs") that happens to match the ticket filename
pattern. But `scanDir` was resolving "the file for ticket 0275" by *sort order*,
which is a real if benign ambiguity.

Fixing it by renaming was rejected: six references, two of them in `os/ksvc.js`
and `os/ksvc/ksvc.c` — a **seeded source**, so the rename would owe an
`image.json` version bump this lane must not make, for a comment.

So the classification is a rule instead: `NNNN-<slug>-design.md` is a *companion*
of ticket NNNN **iff a non-design file with that id also exists**. Both real
cases fall out right — `0275`'s design doc is a companion, and
`todos/done/0007-wm-compositor-design.md`, the sole `0007` file, stays ticket
`0007`. A suffix-only rule would have got `0007` wrong *and* let a lane's
`0354-x-design.md` shadow a genuine collision.

## Red controls

Every guard here was demonstrated failing against the code it replaces, because
the failure it prevents only appears when two lanes race — the worst possible
time to discover the test never worked.

| control | mutation | red output |
|---|---|---|
| two lanes, distinct ticket ids | `nextId` → pre-fix working-tree max | `both lanes allocated 0002 — this is the 0354 collision` |
| duplicate ticket id fails `check` | delete the check from `validate()` | `duplicate id must fail check (stdout: check OK — …)` |
| two lanes, distinct `Lnn` | `next-id` → derive off this ref only | `both lanes allocated L02 — this is the L44 collision` |
| duplicate `Lnn` fails `check` | delete the `seen` map from `parseRegister` | the pre-existing test goes red — it is a real control, not decoration |

## The generalisation

The ticket's shape is *"a lane-allocated id space with no cross-ref allocator and
no uniqueness check"*. Enumerating every other numbered scheme under `todos/`:

- **`NNNN` tickets** and **`Lnn` liabilities** — the two live ones. Both covered.
- `WEBGPU.md`'s `A1`–`A15`, review-finding ids (`A7`/`A13`/`CS3`/`R3` in
  `todos/done/0257` and the dev logs), `CONFORMANCE-REMAINING.md`'s ordinal
  lists — closed, per-document enumerations scoped to one doc or one review. No
  lane allocates into them. Not enrolled; nothing filed.
- **`os/image.json`'s `version`** has exactly the shape and has never collided —
  because the tree solved it the *other* way: executors never assign it, the
  master does at merge. Serialising the allocator is the alternative fix, and
  it works; it just does not scale to a space every lane writes to.
