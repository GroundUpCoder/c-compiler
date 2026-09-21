# 0358 — queue.js add next derives ids from the current branch, so concurrent lanes collide (caused the 0354 and L44 double-assignments)

- **Status**: done
- **Design**: —

## Goal

## Plan

## Acceptance

## Why this is P1 despite being light

Two id collisions landed on disk this week and **both lanes were correct** when
they allocated. `todos/queue.js add next` derives the next free id from the
**current branch's** `todos/*.md`. Lanes push at the end, so a branch — and
`origin/main` itself — is a **LOWER BOUND on the id space, not the id space**.

Observed, not hypothesised:
- `0318` and `0338` each allocated `0354`. Master renumbered the `0338` side to
  `0356` at merge (`todos/0356-micropython-float-exception-class.md`).
- The **liability register collided the same way**: `0318`'s `L44` and `0338`'s
  `L44` were two different entries. Master renumbered the `0338` side to `L46`.
  No handoff had flagged this second one — the register has no allocator at all,
  so it is allocated by eye off whatever ref the lane happens to be on.
- `0341` hit it live: *"`queue.js add next` gave me `0355` — already taken on
  another ref"*, and only avoided a third collision because a coordinator had
  hand-carried a cursor to it.

A renumber at merge is not free: the id is already referenced by the ticket
body, by `queue.json`, by the register's `ticket:` field, and by prose in the
lane's own dev log and done-ticket. Master fixed four such references by hand
for `0338`.

## What done looks like

1. `queue.js add next` derives the max id **across all refs**, not the working
   tree. The shape that works today:
   ```
   git for-each-ref --format='%(refname)' refs/heads refs/remotes |
     while read r; do git ls-tree -r --name-only "$r" -- todos/; done |
     xargs -n1 basename | grep -oE '^0[0-9]{3}' | sort -u | tail -1
   ```
   Anchor on the **basename** — a path-anchored match misses `todos/done/`.
2. Do the same for the **liability register**. It is allocated by hand today and
   collided for exactly the same reason; an allocator that only fixes tickets
   leaves half the bug.
3. A **red control**: a test that constructs two refs each allocating from a
   common base, and asserts the allocator returns distinct ids. Without it this
   fix is indistinguishable from a no-op, and the failure only appears when two
   lanes race — the worst possible time to discover it.
4. Consider whether the allocator should refuse (loudly) rather than silently
   return a duplicate when it cannot see all refs (a detached/offline clone).

## Note

This is the mechanical counterpart to the coordination lesson already recorded
("derive ids across ALL REFS"). The lesson tells a human to do the right query;
this ticket makes the tool do it. A discipline that only lives in a handoff
document is one forgotten handoff away from another collision — and it already
survived being written down once.
