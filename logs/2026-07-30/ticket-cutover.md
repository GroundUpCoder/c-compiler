# The file-based todo queue is retired — the queue is `cc-meta ticket`

jku's 2026-07-17 order moved the work queue to the cc ticket tracker, but the
cutover never took: this repo's own CLAUDE.md kept teaching `todos/queue.js`
as authoritative, so every fresh thread re-learned the file system — 341
commits to `todos/` later, the file queue had grown to 0460 while the cc
tickets went stale. On 2026-07-30 jku ruled: enforce the cutover properly,
losing no pending work. Two lanes ran in parallel: the router re-migrated all
148 open items into cc tickets (bodies verbatim; priority, difficulty,
blockedBy, after preserved; stale pre-migration tickets reconciled), and this
lane owned every doc and machinery change.

**The lesson the failure teaches: a migration that doesn't change what the
repo teaches is not a migration.** The docs are the durable memory here —
threads are stateless, so whatever CLAUDE.md says IS the workflow. Deleting
the external embedder's todos worked because nothing re-taught them; the c-compiler
queue regrew because `CLAUDE.md`, `todos/README.md`, kickoff notes in the
coordination repo, and the enforcement machinery (pre-commit hook, `todos`
test suite) all still described the file system as live.

What changed (two commits):

1. **Docs + machinery** — CLAUDE.md's queue section rewritten for
   `cc-meta ticket` (flow, `#N` idiom, priority policy, `--blocked-by` vs
   `--after`); todos/README.md restructured with the old convention as a
   historical section for reading `done/`; `queue.js`/`queue.test.js`/
   `queue.json` deleted; the pre-commit hook and `tests/todos/run.js` keep
   only the liability register (+ netsurf patchcheck / idspace) halves.
   Live docs still teaching the recipe were scrubbed (LIABILITIES.md's close
   protocol, CLANG-CPP-EPIC §8, IDLE-POWER, INLINER-WAST-PIPELINE-DESIGN,
   HANDOFF.md bannered as historical).
2. **File deletion + register re-point** — after the router verified the
   1:1 mapping, the 148 open `NNNN-*.md` files were deleted and all 47
   `LIABILITIES.md` funding refs re-pointed to their `#N` cc tickets.

Decisions worth recording:

- **The liability register stays, and stays checked.** `liabilities.js` now
  speaks two ref dialects: `#N` (cc tickets — liveness asked of
  `cc-meta ticket list` in one call) and legacy `NNNN` (resolved against
  `todos/done/`; after the cutover a legacy id can only be archived or
  missing, so it can no longer fund a gap). Without cc-meta (public clone,
  offline) the check degrades LOUDLY — structure and anchors still gate,
  the summary says `#N liveness UNVERIFIED` — because a public clone must be
  able to run the structural half, but silence must never read as verified.
- **`idspace.js` survives**: `Lnn` register ids are still allocated by
  parallel lanes, so the cross-ref allocator stays live for
  `liabilities.js next-id`; the `ticket` space is marked historical.
- **The `todos` suite survives in reduced form** rather than being deleted:
  killing it would have left the register with no gate — the exact
  "validator nobody invokes" failure 0286 was built to prevent.
- Gotcha: `execFileSync` with the default 1 MB `maxBuffer` kills an
  over-producing child with SIGTERM, which is indistinguishable from a
  timeout in the error object. The ticket list carries full bodies (~1.2 MB
  for this project), so the probe needed an explicit 256 MB cap — and the
  error mapping now names the buffer case separately.

Citations: historical items remain citable as `todos/NNNN` (resolving into
`todos/done/` or git history); new work is `#N`. The two id spaces are
unrelated — never map one onto the other by number.
