# 0126 — Difficulty spike: right-size (or split) 0117 and 0119 by attempting Round 1

- **Status**: open
- **Difficulty**: light (timeboxed spike — bail is a valid outcome)
- **Design**: this file. Scoped to `todos/0117` (MicroPython upgrade) and
  `todos/0119` (sent/MagicPoint on SDL) ONLY — deliberately NOT the
  `queue.js --difficulty-triage` all-untagged sweep.

## Why

0117 and 0119 are tagged `heavy`, but both are **META / multi-round**
items and the tag is really capturing "open-ended arc," not per-round
effort. Their *first* rounds look modest:

- 0117 R1 is largely *adopting* MicroPython's upstream unix-port config
  ("adopting an existing upstream config, not inventing objects") plus two
  POSIX hooks (`mp_lexer_new_from_file`, `mp_import_stat`) over the veneer
  libc.
- 0119 R1 is `sent` — a ~600 LOC suckless app patched Xlib→SDL, explicitly
  "the small proof."

And the tagging is inconsistent anyway: `0122` (Chibi Scheme, a whole
R7RS impl) is `medium` and `0088` (puNES, ~104 KLOC NES core) is untagged
— both arguably heavier. So rather than re-tag by opinion, **measure it**:
attempt each R1, see how far it gets, and let the right difficulty (and
decomposition) fall out.

## Plan

For EACH of 0117 and 0119, timeboxed (bail early if it turns into a real
port — that is a successful outcome, not a failure):

1. **Attempt Round 1** far enough to know its true size — for 0117, get the
   unix-port config building + argv/script-run wired; for 0119, get `sent`'s
   display layer swapped to SDL+freetype and a first paint. Don't chase a
   fully polished, tested, seeded result — this is a probe, not the item.
2. Then do exactly ONE of:
   - **(a) It fell out cheaply** → finish R1 properly under the *real* item
     (0117/0119) as its own commit, and downgrade that item's difficulty to
     match what's left (`queue.js set-difficulty`).
   - **(b) It's bigger than one chunk but decomposable** → split the META
     item into concrete sub-items (`queue.js add next`), tag each honestly,
     and leave the META item as the tracking umbrella (or close it if the
     sub-items fully cover it).
   - **(c) It's genuinely heavy / a rabbit hole** → keep `heavy`, but record
     *why* + how far the spike got + the concrete blockers in the target
     item's body, so the eventual real attempt starts warm.
3. Record lessons-learned either in the target item body (b/c) or a short
   `logs/` entry — the point is that no probe effort is wasted.

## Acceptance

- Both 0117 and 0119 have an **evidence-based** difficulty (downgraded,
  split, or confirmed-heavy-with-a-reason) — not a guessed one.
- Any code actually landed sits under the real item's number (0117/0119) or
  a new split sub-item, never under this spike.
- `node todos/queue.js check` passes after any tag/split changes.
- This item closes once both targets have been probed and re-tagged/split —
  regardless of whether any R1 code landed (a "confirmed heavy, here's why"
  outcome closes it).
