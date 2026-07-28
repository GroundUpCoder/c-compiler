# 0360 — the cross-ref id survey trusts remote-tracking refs without checking how stale they are

- **Status**: done
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

## Landed (branch `0360-stale-fetch`)

Both plans, plus the third axis the plan did not name. `todos/idspace.js` grew a
`freshness()` verdict printed by `add next`, `queue.js next-id` and
`liabilities.js next-id`:

- **(2) fetch → probe.** `git ls-remote` per remote, compared against the
  remote-tracking refs, is default-ON with a 5s timeout and a non-interactive
  git env. It never fetches (no write), it only PROVES whether one would move
  anything. Failure/timeout degrades to (1) LOUDLY (`PROBE FAILED … CANNOT be
  shown current`), never silently. `--offline` skips it.
- **(1) age.** The offline fallback: `max(FETCH_HEAD mtimes across ALL
  worktrees, newest remote-tracking reflog mtime)` — FETCH_HEAD is per-worktree
  while the refs it updates are shared, so reading one worktree's copy reports
  "never fetched" in every fresh worktree. Warns past 1h, when never fetched, or
  when the lane has COMMITTED since it last looked. Only consulted when no probe
  ran: nagging about a state just proven current is how a warning gets ignored.
- **the third axis** — every sibling **worktree**'s uncommitted `todos/` and
  register are surveyed from disk. That is the incident that filed this ticket,
  and it is now a test.

Policy: `add next` REFUSES (exit 1, nothing written) when the probe proves the
survey stale; `next-id` reports and exits 0. Refuse on proof, warn on doubt.

`L47` retired. Residual (an unpushed id in a DIFFERENT clone — undetectable
without a coordination point) filed as `todos/0364` + register `L52`. Tests:
`todos/idspace.test.js` (14, new suite case `idspace-tests`) + two CLI cases in
`todos/queue.test.js`. Dev log: `logs/2026-07-28/0360-idspace-freshness.md`.
