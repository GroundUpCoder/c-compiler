# Work queue + devlog systems made explicit

With the OS campaign now spanning many multi-week efforts (kernel phases,
os page, shell port, threads, WM), "where are we / where next / why" needed
to be readable from the repo itself rather than reconstructed from
conversations.

Added:

- **`todos/NNNN-<slug>.md` work queue** (system doc: `todos/README.md`).
  Numbered items = committed work with stable, never-reused IDs; the
  README's *Next up* list is the order of attack (number ≠ priority); done
  items move to `todos/done/` so `ls todos/*.md` is always the open queue.
  Existing named docs (KERNEL.md, OS.md, SDL3.md, ...) stay as design
  docs/backlogs that items reference — no churn of existing links, and
  ideas live there until promoted to a number.
- **Seeded 0001–0008** from the OS.md/KERNEL.md roadmaps: kernel phases
  2–4, os page + protoshell, busybox shell port, threads/atomics, WM design
  doc, AF_UNIX networking.
- **`logs/README.md`** documenting the dev-log convention in-repo (it
  previously lived only in the machine-local skills library, invisible to
  anyone reading just this repo).
- CLAUDE.md updated to describe both.

Next: `todos/0001` (kernel Phase 2 — async signal delivery, EINTR, exit
handshake).
