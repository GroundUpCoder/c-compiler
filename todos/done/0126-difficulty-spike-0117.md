# 0126 — Difficulty spike: right-size (or split) 0117 by attempting Round 1

- **Status**: done (reopened + foregrounded 2026-07-27)
  — on jku's direct instruction to foreground the MicroPython work (see 0117).
  The 2026-07-12 mass deferral was a sweep, not a judgement about this item.
  Note the spike is now scoped to **0117 R1 only** — R2 is parked pending the M0
  CPython probe, so do not right-size R2 here.
  ⚠️ Parser footgun, do not undo this wording: `statusOf` (`todos/queue.js:128`)
  captures only the FIRST line after `Status:` and substring-tests it for
  "deferred", so writing "un-deferred" on that line silently re-defers the
  ticket. Keep the word off line 1. Rewritten
  2026-07-15 by the queue reconciliation: the original scope was "spike 0117
  AND 0119", but 0119 (sent + MagicPoint on SDL) has since SHIPPED outright
  (`todos/done/0119-magicpoint-presentations.md`, /bin/mgp at image v80) —
  its half of the spike is moot, which itself proves the spike's thesis (the
  `heavy` tag on these META items overstated per-round effort). What remains
  is the 0117 (MicroPython) half only.
- **Difficulty**: light (timeboxed spike — bail is a valid outcome)
- **VERDICT (2026-07-27): outcome (a) — R1 fell out, and 0117 is `medium`, not
  `heavy`.** Recorded below.
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

## Outcome (2026-07-27) — outcome (a): R1 landed, 0117 re-tagged `medium`

**Was R1 light or heavy? Neither — it was ONE surprise plus a lot of small,
already-written pieces.** Roughly half a day, landed complete under `0117`
(not here — this spike carries no code, per its own acceptance).

The spike's original thesis ("R1 is largely *adopting* an existing upstream
config") was **half right and half wrong**, and the wrong half is the finding:

- **Right**: every piece the item enumerated was cheap. `mp_import_stat` is
  ten lines of `stat()`. `mp_lexer_new_from_file` needed no code at all —
  `py/lexer.c` already provides it under `MICROPY_READER_POSIX`, over
  `py/reader.c`'s POSIX reader, both already vendored. The file object is
  upstream's `extmod/vfs_posix_file.c` with its VFS half removed. The argv
  grammar follows `ports/unix/main.c`. The heap bump is one constant.
- **Wrong**: you cannot "adopt a config" here at all. `mpconfigport.h` carried
  the comment *"Enable features that don't need QSTR pool regeneration"* — the
  generated headers under `genhdr/` were HAND-MAINTAINED, so every flag that
  introduces an interned string (which is every flag that adds a module, a
  method name, or a builtin) was unreachable. That was the whole item's real
  cost, and it is infrastructure, not MicroPython work: `tools/mkmpgenhdr.js`
  drives upstream's own generator scripts over a `cc -E` pass. It was validated
  by regenerating at the UNCHANGED config first and re-running the 639-file
  corpus to the byte-identical 521/3/123 — only then were flags flipped.

**Lesson for the next vendored-project config change**: check whether the
project GENERATES anything into its own build tree before estimating. A
committed generated file with a hand-edit comment in it is a ceiling, and it
does not look like one from the item description.

**Re-tag**: `0117` heavy → **medium**. R2 (FS-import polish + curated stdlib)
is now mostly "pick modules, flip flags, regenerate, run the corpus" — the
mechanism it would otherwise have had to build is built. It is not `light`
because the module-set choice is a real design decision with a
compatibility surface, and because it is parked pending `todos/0313`.
