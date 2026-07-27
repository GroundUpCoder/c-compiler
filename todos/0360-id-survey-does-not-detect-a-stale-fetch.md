# 0360 — the cross-ref id survey trusts remote-tracking refs without checking how stale they are

- **Status**: open
- **Design**: —

## Goal

`todos/idspace.js` (todos/0358) closed the collision that came from deriving an
id off the CURRENT BRANCH: `add next` and `next-id` now survey every ref. But a
`refs/remotes/origin/*` ref is only as fresh as the last `git fetch`, and the
survey has no way to know when that was. A lane that has not fetched today
allocates from a stale bound and can still collide — the same failure, one
degree removed, and just as silent.

Today the only mitigation is prose: every allocation prints `Remote refs are as
fresh as your last fetch.` That is a reminder, not a guard, and 0358 exists
precisely because the previous reminder ("derive ids across ALL REFS", written
down once already) was one forgotten handoff away from another collision.

## Plan

Pick one — the first is cheap and local, the second is authoritative:

1. **Report the age.** The newest committer date across `refs/remotes/*` is one
   extra `git for-each-ref --sort=-committerdate --format='%(committerdate:unix)'`
   away, no network. Print it, and make the allocation LOUD (a warning, or a
   refusal past some threshold) when the newest remote ref is older than the
   lane's own work. Zero new failure modes.
2. **Fetch.** `git fetch --quiet` inside the allocator makes the survey actually
   authoritative, at the cost of putting a network call in a CLI that is also
   run offline and inside tests. If taken, it wants an opt-out and must not fail
   the allocation when the network is down — degrade to (1) and say so.

Whichever is chosen, the printed derivation line must keep naming the ref the
maximum came from: that is what lets a lane recognise a ref set that looks
wrong.

## Acceptance

- A lane whose newest remote-tracking ref predates its own work is TOLD, not
  silently handed a stale bound.
- A test constructs a stale remote ref and demonstrates the new behaviour RED
  first (the 0358 discipline: an id-space guard that has never been shown
  failing is indistinguishable from a no-op).
- `node tests/run.js todos` green; `todos/LIABILITIES.md` L47 retired or
  re-anchored in the same commit.
