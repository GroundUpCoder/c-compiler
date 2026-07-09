# todos: single-source the queue — kill the denormalized copies

**2026-07-10.** Follow-up to yesterday's `queue.json` manifest work (see
`logs/2026-07-10` in netguc for the cc side). After the manifest landed, two
structured facts still existed in *two hand-authored places each*, and both
copies had already been caught drifting:

- **Dependency ids**: `queue.json` `blockedBy`/`after` **and** each open
  item's `- **Depends**:` header line.
- **Order of attack**: `queue.json` array position **and** the README's
  hand-numbered "Next up" list (whose sync ritual every closeout had to
  remember — the 0065 closeout dutifully hand-edited it minutes before this
  change deleted it).

The organizing principle for the fix: **a fact may be denormalized only if
the copy is generated or byte-checked — never independently hand-authored.
And never parse prose to validate prose** (that re-creates the fragile
scraper the manifest replaced). So: generate-or-eliminate, not reconcile.
Both copies were eliminated rather than generated, since live generated
views already exist (`queue.js list`, the cc Todos tab).

What changed:

- The `Depends:` line is **gone from all 18 open items**. Ids were already
  in `queue.json`; the rationale parentheticals ("rides the 0052 socket
  surface", the 0064 operator-present requirement, …) moved into each item's
  body prose, where "why" belongs. `done/` files are frozen history, exempt.
- `queue.js check` gained a **lint**: a structured `Depends:` line in an
  open item is an error. The pre-commit hook already runs `check`, so the
  convention can't silently regress as agents churn the queue. The `add`
  scaffold no longer emits the line. Test added (`queue.test.js`, 14 pass).
- The README's "**Next up**" section is **deleted**, replaced by a short
  themes paragraph that names no ids and no order (pointers to `WIN32.md` /
  `WM.md` / `NETWORK.md` / `WC.md`). The landed-history recap that had
  accreted there was redundant with `todos/done/` + the dev log.
- `CLAUDE.md` queue section updated to match.

Result: order, deps, titles, completion each have exactly one writable
owner (`queue.json` position, `blockedBy`/`after`, the `#` heading, the
`done/` dir); prose keeps the rationale and can no longer drift against the
machine-read facts. cc's detail sheet stops rendering the now-dead
`depends:` chip in the same change (netguc side).
