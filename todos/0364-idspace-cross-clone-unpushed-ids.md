# 0364 — id allocation cannot see an unpushed id in another clone

- **Status**: open
- **Design**: —

## Goal

`todos/idspace.js` allocates across three visibility classes after todos/0360:

1. every ref in this clone (0358),
2. every sibling **worktree**'s uncommitted working tree (0360),
3. and it PROVES, via `git ls-remote`, that (1) is current (0360).

That is authoritative over **everything that has been pushed, plus this clone's
own uncommitted trees**. The residual is exactly one case: an id that exists
only in a **different clone** — another machine, another checkout — and has not
been pushed. No fetch can surface it (it is not on the remote) and no local scan
can reach it (it is not on this filesystem). Today the allocator says so in the
freshness line and stops there; the id can still be handed out twice.

This is not hypothetical for the same reason 0360 was not: the failure mode is
two lanes that are each correct, and a renumber at merge is not free (the id is
referenced from the ticket body, `queue.json`, the register's `ticket:` field
and the lane's dev log).

## Plan

The only thing that closes it is a **coordination point both clones can see**,
i.e. a push at ALLOCATION time rather than at the end of the lane. Sketch:

- `queue.js add next` / `next-id --reserve` pushes a lightweight ref —
  `refs/idspace/ticket/0364`, `refs/idspace/liability/L52` — pointing at any
  object (the current HEAD is fine; only the NAME carries meaning).
- The survey already enumerates `refs/remotes`; it would additionally read
  `refs/idspace/*` from `git ls-remote` (already called by the 0360 probe, so no
  extra round trip) and treat a reservation as a taken id.
- A reservation is dropped when the lane's ticket lands on `origin/main`, or
  garbage-collected by age; a stale reservation costs one skipped number, which
  is the cheap direction of the trade.

Costs to weigh before building it, honestly:

- it makes allocation a WRITE to the remote, so it fails offline — and 0360's
  whole point was that the allocator must not become network-DEPENDENT, so the
  write has to degrade to today's behaviour as loudly as the probe does;
- it needs push permission at allocation time, which not every consumer has;
- `refs/idspace/*` is repo litter that someone has to prune.

An alternative that avoids the write: accept the residual and make the merge
cheap instead — a `queue.js renumber <OLD> <NEW>` that rewrites the ticket file,
`queue.json`, the register's `ticket:` field and greps the dev logs, so a
collision becomes routine rather than expensive. Decide between the two before
building either.

## Acceptance

- Either a reservation mechanism whose staleness is measured the way 0360
  measures the survey's, with a test that constructs a second clone and shows
  the collision RED first;
- or an explicit written decision NOT to close it, plus the renumber tool that
  makes the residual cheap — in which case this item retires register L52 and
  the freshness line stops promising a fix.
