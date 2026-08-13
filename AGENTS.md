# AGENTS.md — pointer only

**This file is a pointer. It carries no rules of its own.** Every agent working in
this repository — Claude, Codex, or any other — follows the same canonical documents:

- **`CLAUDE.md`** — repo rules: build, tests and the gating ladder, the ticket queue
  and priority policy, portability, semantics decisions already made. **Read it first
  and in full.** Despite the filename, it is not Claude-specific; it is this repo's
  operating manual.
- **`todos/PRINCIPLES.md`** — the two principles that govern how work is classified,
  prioritized, designed, and reviewed: **contract-anchored correctness** and **honest
  implementation shape** (jku, 2026-08-13, set in stone). Read before filing a ticket,
  designing an implementation, or reviewing a diff.
- **`todos/GAMEDEV-EPIC.md`** — the primary epic and the selection policy.
- **`todos/OS.md`**, **`todos/LIABILITIES.md`** — north-star architecture and the
  register of gaps the tree describes but nothing schedules.

Normative text lives **only** in the documents above. This file deliberately
duplicates none of it: two copies of a rule are how the two copies silently diverge,
and preferring an existing seam over a novel one is itself one of the principles.

If you find guidance here that is not in those files, that is a bug in this file.
