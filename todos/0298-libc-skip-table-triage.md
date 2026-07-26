# 0298 — tests/run.py skip table: triage the 13 TODO-candidate libc gaps into real items (check fnmatch first)

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #11).

## Goal

Turn a permanent skip table into either coverage or filed items.

`tests/run.py:1388-1407`:

```python
# Library features not implemented (TODO candidates)
"fnmatch": "TODO: fnmatch()",  "search_hsearch": "TODO: search.h",
"random": "TODO: random()/srandom()/initstate()",  "strptime": "TODO: strptime()",
"setjmp": "TODO: sigsetjmp/siglongjmp aliases",  "memstream": "TODO: open_memstream()",
"wcstol": "TODO: wcstol() family",  "fwscanf": "TODO: wide scanf",  …
```

**Every one of these makes the suite report green while skipping the test.** Ticket grep:
`fnmatch` 0, `strptime` 0, `hsearch` 0, `wide scanf` 0.

Individually low blast radius. The **aggregate** is what matters: a green libc suite with 13
documented holes in it. "TODO candidate" is a status that has never advanced to anything.

## Start here — one entry is probably already stale

**`fnmatch` IS available** via the optional `libc-ext.js` (`ext/`). So at least one skip entry
may be obsolete, meaning the table is not only unfunded but partly **wrong** — a skip that hides
working functionality. Not verified; verify it first, since it is the cheapest possible win and
it calibrates how much of the rest of the table to trust.

## Status of the facts

**Inventory-only.** The sweep read the table and grepped tickets; it did not test any of the 13.

## Plan

- Verify each of the 13 against current libc + `ext/`: **already works** / **genuinely missing**.
- Remove skip entries for anything that works (and let the tests run).
- For what is genuinely missing: either implement the cheap ones, or file real items and make the
  skip entry **cite the ticket id** — `0286`'s register rule applied to the skip table.
- Outcome must be that no entry says only "TODO" with nothing behind it.

## Acceptance

- Zero skip entries reading "TODO" without either a ticket id or a removal.
- `fnmatch`'s actual status determined and acted on.
- Any newly un-skipped tests pass (or their failure is filed).
- The libc suite green with a **NUMBER** reported, and the skip count stated before and after.
