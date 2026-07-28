# todos/0360 — the id survey measures its own staleness instead of disclaiming it

Branch `0360-stale-fetch`. Files: `todos/idspace.js`, `todos/queue.js`,
`todos/liabilities.js`, `todos/idspace.test.js` (new), `todos/queue.test.js`,
`tests/todos/run.js`, `todos/README.md`, `CLAUDE.md`.

## The thing being fixed

`todos/0358` shipped an id allocator that surveys every ref, and printed one
sentence about the gap it could not close:

> `Remote refs are as fresh as your last fetch.`

That sentence is TRUE, which is what makes it dangerous — it is the exact shape
`todos/LIABILITIES.md` exists to kill. It fired the same day it shipped: the
master was mid-merge of 0340 with `L47`/`L48` written into an **uncommitted**
register, while 0358's own worktree allocated `L47` off the refs and pushed.
Both were correct. Neither could see the other. It was caught by luck — a
`next-id` run afterwards happened to name the ref the id lived on.

A sentence in the output is not a check.

## What shipped

Three measurements, one per visibility class, all in `todos/idspace.js`:

1. **Would a fetch move anything** — `git ls-remote --heads --tags` per
   configured remote, compared against `refs/remotes/<remote>/*` (and
   `refs/tags/*`, which are not namespaced per remote). Only the dangerous
   direction is reported: a ref the REMOTE has that this clone has not seen. A
   lingering remote-tracking ref for a deleted upstream branch can only make the
   survey over-count, never under-count, so it is not staleness.
   **This is authoritative**, which is why it is default-ON.
2. **When did this clone last look** — the offline fallback, and a LOWER BOUND
   by construction: `max(FETCH_HEAD mtimes, newest reflog mtime under
   logs/refs/remotes)`.
3. **Ids on no ref at all** — every sibling worktree's `todos/` and
   `todos/LIABILITIES.md` read straight off disk. This is the incident above,
   and it is now a test (`RED: an id in a SIBLING WORKTREE's uncommitted tree is
   taken — the L47 incident`).

Policy lives in the CALLERS, mechanism in the module: `add next` **refuses** to
write an id when the probe PROVES the survey stale; `next-id` reports and exits
0, because it writes nothing. **Refuse on proof, warn on doubt.**

## Decisions worth keeping

**FETCH_HEAD is per-worktree; remote-tracking refs are not.** The obvious
implementation — stat `git rev-parse --git-path FETCH_HEAD` — reports "this
clone has NEVER fetched" in every freshly-added worktree, because a fetch run in
the main tree writes MAIN's FETCH_HEAD while updating the SHARED refs. That is a
false alarm on the most common workflow in this repo (22 live worktrees at the
time of writing), and a check that cries wolf is a check nobody reads. The
implementation maxes over `<common>/FETCH_HEAD` and every
`<common>/worktrees/*/FETCH_HEAD`, plus the reflog mtimes. Pinned by
`a fetch made from ANOTHER worktree counts`.

**The probe overrides the clock, not the other way round.** If `ls-remote` says
the remote holds nothing new, a day-old FETCH_HEAD is NOT nagged about — it has
just been shown to be current. The age threshold (`REFRESH_WARN_MS`, 1h) only
applies when no probe ran. Nagging about a state you just proved fine is how a
warning gets ignored.

**A network call in a CLI needs a bound and a loud degrade.** 5s timeout;
`GIT_TERMINAL_PROMPT=0` plus BatchMode ssh and a no-op askpass, because a
credential prompt turns "the allocator checks its freshness" into "the allocator
hangs forever". A timeout or a network failure yields
`freshness: PROBE FAILED (…) — … This survey CANNOT be shown current either
way`, level `warn`, and the allocation still proceeds. The degrade is
deliberately NOT the pre-0360 behaviour under a new name: it says it failed.
Both are tested, the timeout via git's `ext::` transport pointed at a `sleep 3`
helper (the case hangs forever without the bound).

**`--offline` is the named opt-out, and it is also the escape from the
refusal.** No second `--stale-ok` flag: skipping the probe means nothing is
proven, so `add next` warns and writes. The line says `probe SKIPPED
(--offline)` and never claims currency it did not check.

## Residual, filed rather than implied away

An id that exists only in a **different clone** and has not been pushed is
invisible to all three measurements — no fetch can surface it, no local scan can
reach it. Filed as `todos/0364` + register `L52`, with the two candidate
closures written down (a pushed `refs/idspace/*` reservation at allocation time,
versus accepting the residual and building `queue.js renumber` so a collision is
cheap). The freshness line names 0364 in its own output.

`L47` is retired in this commit — the gap it named is closed.

## Red control

`node todos/idspace.test.js` against the pre-0360 `todos/idspace.js` (from
`origin/main`): 12 of 14 fail, including both `RED:` cases. Restored: 14/14.
Full transcript in the lane's report.

## Gates

`node todos/queue.js check`, `node todos/liabilities.js check`,
`node todos/queue.js next-id`, `node tests/run.js todos` — all green (5/5 cases,
13.7s). `todos/`+`tests/`-only diff, so no image bump.
