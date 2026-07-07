# logs/ — the dev log (committed engineering journal)

This folder is durable project memory, not scratch space. It captures the
**why** behind non-trivial work — decisions, trade-offs, dead ends, gotchas —
the things `git log` and the code can't tell you. `todos/` says where we're
going; this says how we got here.

## Convention

- **One folder per local day**: `logs/YYYY-MM-DD/`.
- **One file per topic**: `logs/YYYY-MM-DD/<topic>.md` — topic-scoped, not a
  single running diary, so parallel workstreams don't interleave.
- **Write an entry when landing anything substantial** — same commit as the
  work it describes, ideally.
- **Content**: why this approach, what was rejected and why, what surprised
  us, what's deliberately left broken (and where that's tracked). Not a
  restatement of the diff.
- **Cross-link**: reference queue items as `todos/NNNN`, design docs by
  name, commits by short hash. Backwards too — queue items and design docs
  may point at log entries for the full story.

This README is the convention's home for this repo — self-describing, no
external doc needed.
