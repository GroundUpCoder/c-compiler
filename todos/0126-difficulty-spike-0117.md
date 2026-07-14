# 0126 — Difficulty spike: right-size (or split) 0117 by attempting Round 1

- **Status**: deferred (mass-deferred 2026-07-12; was: open). Rewritten
  2026-07-15 by the queue reconciliation: the original scope was "spike 0117
  AND 0119", but 0119 (sent + MagicPoint on SDL) has since SHIPPED outright
  (`todos/done/0119-magicpoint-presentations.md`, /bin/mgp at image v80) —
  its half of the spike is moot, which itself proves the spike's thesis (the
  `heavy` tag on these META items overstated per-round effort). What remains
  is the 0117 (MicroPython) half only.
- **Difficulty**: light (timeboxed spike — bail is a valid outcome)
- **Design**: this file. Scoped to `todos/0117` (MicroPython upgrade) ONLY —
  deliberately NOT the `queue.js --difficulty-triage` all-untagged sweep.

## Why

0117 is tagged `heavy`, but it is a **META / multi-round** item and the tag
is really capturing "open-ended arc," not per-round effort. Its *first*
round looks modest: R1 is largely *adopting* MicroPython's upstream
unix-port config ("adopting an existing upstream config, not inventing
objects") plus two POSIX hooks (`mp_lexer_new_from_file`,
`mp_import_stat`) over the veneer libc. The sibling case is now evidence,
not speculation: 0119 was tagged the same way and its R1 ("the small
proof", sent) fell out cheaply enough that the whole item shipped. So
rather than re-tag by opinion, **measure it**: attempt R1, see how far it
gets, and let the right difficulty (and decomposition) fall out.

## Plan

Timeboxed (bail early if it turns into a real port — that is a successful
outcome, not a failure):

1. **Attempt 0117 Round 1** far enough to know its true size — get the
   unix-port config building + argv/script-run wired. Don't chase a fully
   polished, tested, seeded result — this is a probe, not the item.
2. Then do exactly ONE of:
   - **(a) It fell out cheaply** → finish R1 properly under `0117` as its
     own commit, and downgrade 0117's difficulty to match what's left
     (`queue.js set-difficulty`).
   - **(b) It's bigger than one chunk but decomposable** → split the META
     item into concrete sub-items (`queue.js add next`), tag each honestly,
     and leave 0117 as the tracking umbrella (or close it if the sub-items
     fully cover it).
   - **(c) It's genuinely heavy / a rabbit hole** → keep `heavy`, but record
     *why* + how far the spike got + the concrete blockers in 0117's body,
     so the eventual real attempt starts warm.
3. Record lessons-learned either in 0117's body (b/c) or a short `logs/`
   entry — the point is that no probe effort is wasted.

## Acceptance

- 0117 has an **evidence-based** difficulty (downgraded, split, or
  confirmed-heavy-with-a-reason) — not a guessed one.
- Any code actually landed sits under 0117 or a new split sub-item, never
  under this spike.
- `node todos/queue.js check` passes after any tag/split changes.
- This item closes once 0117 has been probed and re-tagged/split —
  regardless of whether any R1 code landed (a "confirmed heavy, here's why"
  outcome closes it).
