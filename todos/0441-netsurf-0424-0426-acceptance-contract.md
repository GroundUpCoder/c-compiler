# 0441 — netsurf 0424 + 0426 have no acceptance contract — give them one (0426 needs a Plan too)

- **Status**: open
- **Design**: —

## Goal

`todos/0424` and `todos/0426` are open, rankable, spawnable tickets with **no `## Acceptance`
section at all**. Give each one a contract, so that whichever lane eventually runs them has a
stated bar to meet and `todos/done/` inherits the reasoning rather than losing it.

## The gap, measured 2026-07-30

| ticket | headings it has | what is missing |
|---|---|---|
| `0424-netsurf-js-errors-to-console` | `Goal`, `The gap`, `Plan`, `Why it is not part of 0421` | **`## Acceptance`** |
| `0426-netsurf-dynamic-restyle-invalidation` | `Goal`, `The two shapes`, `Anchor`, `Evidence`, `Cost note` | **`## Plan` AND `## Acceptance`** |

0424 is the cheaper half: it already has a `## Plan`, so its contract can largely be derived by
turning each Plan step into a checkable arm. **0426 is the real work** — it has evidence and an
anchor but no plan at all, so somebody must decide *how* the two uncovered restyle shapes get
covered before an acceptance list can mean anything.

## Why this is worth a ticket rather than a drive-by edit

A contract invented at spawn time lives only in the kickoff, and a kickoff is a message — it is
not versioned estate in the repo the work lands in, and nobody reads it again after the lane
closes. The lane would comply perfectly and `todos/done/0424` would still ship with no record
of what it was required to prove. (This is the lesson the coordinator recorded as **(FB)**; the
same gap was found and fixed on `todos/0396` at `7926ae43`.)

## Plan

1. **0424** — write `## Acceptance` derived from its existing `## Plan`. Every arm must be
   checkable by a command or an observable artifact, not by inspection. State explicitly which
   surface the error must reach (console **and** log **and** tty are three different claims —
   the title says "no console, no log, no tty", so say which of the three the ticket buys).
2. **0426** — write `## Plan` **first**, from `## The two shapes` + `## Anchor` + `## Evidence`,
   then write `## Acceptance` against that Plan. If the right answer is that one of the two
   shapes is out of scope, say so under a `## Not in scope` heading rather than silently
   dropping it.
3. Re-run each new arm against the tree **before** committing (see Acceptance arm 4).

## Scope — do NOT touch these

🔴 **`0349`, `0385` and `0386` also return empty from a `^## Acceptance` grep and are all
CORRECT as they stand. Do not "fix" them.**
- `0349` — its contract lives under `## What to do` / `## Scope` / `## Not in scope`.
- `0386` — a design/diagnosis **report**; its deliverable is a document, not a change.
- `0385` — an investigation whose `## Options (as emailed)` awaits a decision from jku.

⭐ A design pass given an Acceptance section is worse than one without. **Read what a ticket IS
before you conclude anything about its headings** — a `^## Acceptance` grep measures a heading
name, not the presence of a contract.

## Acceptance

1. `todos/0424-*.md` has a `## Acceptance` section whose every arm names a command or an
   observable artifact. No arm is satisfiable by inspection alone.
2. `todos/0426-*.md` has **both** a `## Plan` and a `## Acceptance`, and the Acceptance arms
   trace to Plan steps. If a shape is dropped, a `## Not in scope` heading says which and why.
3. `todos/0349`, `todos/0385`, `todos/0386` are **byte-identical** to their state at this
   ticket's filing — prove it with `git diff --stat` naming those three paths and showing no
   change.
4. 🔴 **Each new arm is run against the CURRENT tree and the already-TRUE ones are marked as
   such**, with the ticket that discharged them named. An arm that is already green certifies
   nothing about the lane that later executes the ticket, so it must be labelled rather than
   left to read as work owed. (Coordinator lesson **(FA)**; measured on `0432`, whose
   `hostKeys:'mac'` arm was already green via the closed `todos/done/0135`.) State the count:
   how many arms written, how many already TRUE.
5. `node todos/queue.js check` exits 0 and the todos suite is green, with the numbers stated.

## Notes

Both tickets are netsurf work and sit in the band jku ruled **less urgent than the Rust and
codex work** ("*And yea those all seem less urgent than the rust and codex work*"), which is why
this is filed P2 `[light]`. It blocks nothing. It exists so the contract is written **before**
either ticket is spawned, not improvised by whoever spawns it.

Prose in the two edited tickets follows **ASD-STE100** (jku standing instruction): one word one
meaning, active voice, short sentences, keep the article. This does not apply to code or to
commit messages.
