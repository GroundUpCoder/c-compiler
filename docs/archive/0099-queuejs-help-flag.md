# 0099 — queue.js: --help must print usage, not scaffold an item

- **Status**: done 2026-07-11 — `-h`/`--help` anywhere in argv prints usage and
  exits 0 BEFORE dispatch (an `add --help` can never scaffold again); every
  subcommand now parses flags against an allowlist and an unknown `--flag`
  exits 2 writing nothing (the root cause — mutation commands no longer
  guess); bonus per HANDOFF's attribution: `list | head` no longer crashes
  with an unhandled EPIPE (early pipe close = normal termination, exit 0).
  Contract documented in queue.js's header + README §1; 3 new tests in
  todos/queue.test.js (22 total), each verified to fail on the pre-fix CLI.
  Follow-ups: none.
- **Design**: `todos/README.md` §1 (the queue CLI contract);
  `todos/queue.js` (single writer + validator).

## Goal

`node todos/queue.js add --help` scaffolds and enqueues a real item
named "untitled" instead of printing usage — `--help` falls through the
flag parser as an unknown flag and `add` treats the invocation as a
slug-less scaffold. This bit the 0078 session (the accidental item was
repurposed as 0098, but only because a follow-up was needed anyway);
the trap is currently documented in HANDOFF.md as a gotcha, which is a
warning sign, not a fix.

## Plan

- `-h`/`--help` anywhere in argv → print the usage block (the same text
  the bare invocation prints) and exit 0, before any command dispatch.
- While there: an UNKNOWN `--flag` on any subcommand should be a usage
  error (exit 2), not silently ignored — that's the actual root cause
  (the mutation commands must not guess).
- Drop the HANDOFF.md gotcha line when this lands.

## Acceptance

- `node todos/queue.js add --help` prints usage, exits 0, and leaves
  queue.json + todos/ untouched (`git status` clean).
- `node todos/queue.js add next --slug x --bogus-flag` exits 2 without
  writing anything.
- `node todos/queue.js check` still passes on the untouched tree.
