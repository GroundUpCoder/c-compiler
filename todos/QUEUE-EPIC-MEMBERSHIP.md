# Queue epic membership — the EXCLUSIVITY axis (#572, PKGDEV-EPIC rung 6b completion)

> 🔴 **THE AXIS IS STILL VALID; ITS DIRECTION FLIPPED (jku, 2026-08-13).**
> PKGDEV is TABLED and gamedev is PRIMARY AND EXCLUSIVE. The `epic:` token and
> the classification method below are unchanged and still the right
> instrument — but the selector now keeps **`epic:gamedev`** and parks
> `epic:pkgdev`, which is the exact opposite of what the 2026-08-07 text below
> says. See `todos/GAMEDEV-EPIC.md`.
>
> ⚠️ Two traps this flip creates, both measured:
> - **A ticket tagged `epic:pkgdev` may still be gamedev-advancing** — #548
>   (published doom SEGV) is tagged pkgdev and its own body argues the gamedev
>   case. Read the argument, do not trust the token alone.
> - **A lane- or coordinator-filed ticket has NO `epic:` token at all** and
>   reads as ABSENT, not as "neither" — it will vanish from a
>   token-filtered queue. Classify it yourself before concluding the queue is
>   empty.

Snapshot: 2026-08-09. **This file is the at-a-glance snapshot; the ticket DB
is the live truth.** Every open ticket (statuses open + in_progress +
deferred; done/dropped excluded) now carries a SECOND classification token in
its cc `design` field, appended after #567's stream token:

    ... | epic:<pkgdev|gamedev|neither> — <one-line argued reason>

This answers the question #567's stream axis deliberately does not: **"is
this ticket PKGDEV-advancing, yes/no"** — the axis jku's 2026-08-07
EXCLUSIVITY ruling needs (`todos/PKGDEV-EPIC.md`, "Queue selection"). The
proof the two axes are independent: **#475 was `package-side` AND ladder
rung 1** (in), while most `os-proper` tickets are out.

All pre-existing `design` content (the `pkgdev:` stream token, `| prior:`
free prose) survived byte-exact; the epic token is a pure append. Verified
2026-08-09 by fresh DB re-read: **263 targets (252 open + 2 in_progress +
9 deferred), 263 tokens, 263/263 byte-exact prefix survival, 0 leakage.**

| epic | count |
|---|---|
| pkgdev | 46 |
| gamedev | 21 |
| neither | 196 |
| **total** | **263** |

## How to read the tokens (the selector projection, incl. the traps)

The filter is a client-side projection over `cc-meta ticket list` JSON.
Measured traps, each of which produces a silent false-clean scan:

- **The default `--project` list is OPEN-ONLY.** in_progress and deferred
  tickets need their own `--status in-progress` / `--status deferred` calls
  (a claimed ticket VANISHES from the default list — #572 itself did, the
  moment its thread linked).
- Rows are `{items:[{ticket, derived}]}` — filter on `x.ticket.status`, not
  `x.status` (the latter matches nothing and reads like a clean queue).
- **`design` and `after` are OMITTED WHEN EMPTY.** An absent `design` key =
  filed after the sweeps, i.e. UNCLASSIFIED on both axes — treat it as
  "must classify before selection", never as `neither`.
- Epic token regex: `/(?:^|\| )epic:(pkgdev|gamedev|neither) — /` against
  `ticket.design`. Stream token stays `/^pkgdev:(os-proper|package-side|mixed) /`.
- **`blockedBy` and `after` hold ticket UUIDs, not numbers.** Comparing them
  to `t.number` silently reports every ticket free. `ticket block <ref>
  --soft <ids>` also REQUIRES UUIDs (numbers are refused with "unknown
  ticket"), and stores under the key **`after`** — there is no
  `blockedBySoft`.
- **`derived.ready` ignores `after`** (a soft edge orders, it does not
  block) and ignores `--needs-human` gates — `ready:true` is not
  "startable by an agent".
- `ticket update <ref> --blocked-by` is a SILENT NO-OP (HTTP 400, exit 0);
  the real verb is `ticket block`. Verify every edge write by RE-READING.

**The selection rule the axis serves (EXCLUSIVITY):** the queue runs
`epic:pkgdev` tickets only, weight-sorted (light → medium → heavy, Pn inside
a tier) — and the sort must now also consult **`after`**: a recorded soft
edge orders within the band; recorded edges (hard or soft) outrank the
weight sort, which never reorders across one. `epic:neither` does NOT mean
"never runs": P0/broken-build preemption and jku direct asks outrank epic
membership, and membership is not permission in either direction.

## Membership rulings applied (argued, never pattern-matched)

Inherited: PKGDEV-EPIC.md's three 2026-08-07 rulings, GAMEDEV-EPIC.md's
membership-is-argued rule. Applied lines where those underdetermine:

1. **pkgdev** = on the path of a developer building and shipping a package
   inside gucOS: the ladder rungs, gucman + package defs, the image/unbake
   estate, publish/artifact determinism, in-OS build tooling (make/diff/
   patch), the git/network substrate, gcode agent capability, the dogfood
   rounds, and the epic's own queue machinery (#567/#572 class).
2. **Ruling 3 (a blocking bug is epic work) — the toolchain line.**
   Toolchain/platform DEFECTS that can bite arbitrary code in the in-OS
   dev loop are pkgdev with the blocked thing named (miscompile-class #125,
   misleading diagnostic #127, brokered short-writes #152, LinkError-reads-
   as-SEGV #558, the bridge faults #362/#391/#392, the gcode defects
   #400/#504/#505/#511). Capability GAPS whose only named consumer is a
   parked epic (CPython) or a hypothetical future port are **neither** —
   marking every toolchain ticket pkgdev would re-merge the blob rung 6b
   exists to split.
3. **Both-epic tickets ride pkgdev** (epic doc: full PKGDEV standing) and
   say so in the reason: the gamedev dogfood rounds #502/#508 exercise the
   same in-OS edit-build-run loop as D1; #77/#378/#548 are package-estate
   work whose subjects are games.
4. **Agent UX ≠ agent capability.** gchat and the gcode GUI (#297–#300,
   #517) are neither: the dev loop runs the gcode CLI in term and gains no
   capability from a shell around it. Capability/correctness work on the
   agent itself (#467 compaction, #470 persistence, #530 orientation
   mechanism) is pkgdev.
5. **Host gate/test estate velocity is neither** (#576, #589, #591, #592,
   the tightness/guard tickets): it serves every stream equally; "the
   dogfood rounds hit it" was not true of any of these. Epic-machinery
   meta-work (#572 itself) is pkgdev — the distinction is whose question
   the ticket answers.

**Worked examples (the axis discriminates, both directions):**
- `os-proper` but `epic:neither` — **#16** (0115 more screensavers): squarely
  OS code, nowhere near the dev loop. Likewise #5 wallpaper, #102 resize
  edges, most of the 158-strong os-proper class.
- `package-side` but `epic:pkgdev` — **#504** (gcode windowed-app wedge):
  an app-side bug, in the epic under ruling 3 because it blocks the #568 D1
  windowed leg (soft edge now recorded). Likewise #128, #437, #467, #470,
  #505, #511, #530. (#475, the motivating example, closed done before this
  sweep.)

## epic:pkgdev (46)

Ladder + machinery: #464 #498 #545 (rung 2) · #563 (rung 3) · #564 (rung 4)
· #566 (rung 5) · #565 (rung 6a) · #572 (rung 6b completion) · #568 #569
#570 (dogfood D1/D2/D3) · #502 #508 (gamedev dogfood, advances both).
gucman / package defs / image+unbake / publish estate: #73 #74 #77 #128
#437 #378 #583 #585 #590 #594 #548 #21 #100 #137 #151.
In-OS build tooling + source-control substrate: #6 (pdpmake/diff/patch)
· #155 (github relay) · #156 (clone→compile→run e2e).
Ruling-3 bridge faults: #362 #391 #392.
Ruling-3 gcode agent capability/defects: #504 #505 #530 #467 #470 #400
#511 · #443 (measures the agent GUI-dev loop).
Ruling-3 platform/toolchain defects biting the in-OS loop: #152 #558 #125
#127.

## epic:gamedev (21)

#11 #12 #197 #280 #374 #384 #468 #492 #494 #496 #499 #500 #527 #528 #529
#531 #532 #533 #555 #556 #557 — the SDL surface/corpus estate, game ports
and game-presentation defects that advance a game developer but not the
package-dev path. Per-ticket reasons live in the DB `design` field.

## epic:neither (196)

By cluster (per-ticket reasons in the DB): win32 veneer/ports completeness
(47) · host gate/test estate (26) · desktop/WM UX + furniture (24) ·
general platform/kernel/infra (21) · NetSurf estate (18) · toolchain
widening with no live epic consumer (14) · parked-CPython consumers (12) ·
media/voice (9) · app/package content off the dev loop (9) · host input/
mobile (6) · gchat/agent-UX shells (5) · deferred rust program (5).
EXCLUSIVITY parks these; P0 bug policy and jku asks still outrank.

## The `after` (soft-edge) audit — reproduced 2026-08-09

Independently reproduced from a `--status all` list (594 tickets):

- **59** tickets carry a non-empty `after` (the #572 body said 54 — the
  five newcomers are the unbake/gate chains #585/#590/#591/#592 + #384,
  recorded after it was filed).
- **38** of them are open/in_progress (body said 35; none deferred).
- **26** have an UNMET soft constraint (body said 23; same explanation).
  The unmet set is the win32/NetSurf chains (#33 #149 #276 #283 #284 #285
  #286 #287 #289 #298 #299 #325 #336 #337 #338 #339 #340 #341 #361 #389),
  the gate/unbake chains (#585←#583, #590←#583,#585, #591←#583,#585,#590,
  #592←#591), #384←#280, #15←#14 — all inside parked-or-sequenced work;
  nothing re-sequences the current epic dispatch.

Edges recorded by this pass (prose → recorded, with the hard/soft call
written down):

- **#568 `after:[#504,#505]` (soft).** The #572 body's second miss, now
  recorded. Soft, not hard: the epic doc calls D1 "runnable TODAY, no
  blockers" — each bug degrades a leg (windowed-app launches; turn-1
  orientation burn), not the whole round. Hard would have made the round
  unstartable, the exact over-claim failure the ticket warns against.
- Checked, already recorded, nothing to add: #570 hard [#563,#564] (the
  epic doc's "D3 blocked by packaging + publish" prose), #156 hard [#155]
  ("THE consumer of 0380"), #478 soft [#362,#391] (cont-527's recording;
  #478 has since closed done), #505 hard [#530], the #336/#337/#361 win32
  consumer chains.

## Backfill note

11 tickets filed after #567's sweep carried NO `design` at all (#576, #583,
#585–#592, #594). This pass gave them the missing `pkgdev:` STREAM token as
well as the epic token, so #567's "every open ticket carries exactly one
stream classification" invariant holds again. `todos/QUEUE-CLASSIFICATION.md`'s
counts remain its own dated snapshot (255 at 2026-08-07); the DB is live.
