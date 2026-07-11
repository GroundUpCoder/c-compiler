# 0099 — queue.js: --help prints usage; unknown flags refuse; EPIPE is quiet

`node todos/queue.js add --help` used to scaffold and enqueue a real item
named "untitled": `--help` fell through `parseFlags` as just another unknown
flag, and `add` treated the slug-less invocation as a scaffold request. That
bit the 0078 session (the accident got repurposed as 0098 only because a
follow-up happened to be needed), and it lived in HANDOFF.md as a gotcha —
a warning sign, not a fix.

## What landed

Three changes in `todos/queue.js`, all at the CLI boundary:

- **Help before dispatch.** `-h`/`--help` anywhere in argv prints the usage
  block and exits 0, checked in `main()` before any command runs. Making the
  check positional-agnostic ("anywhere") is deliberate: the failure mode is a
  human asking for help in whatever position feels natural (`add --help`,
  `add next -h`), and no help request should ever reach a mutation path.
- **Flag allowlists.** `parseFlags` now takes the subcommand's allowed flag
  names and turns anything else into a usage error — exit **2**, distinct
  from validation failures (exit 1), nothing written. This is the actual
  root-cause fix: the scaffold bug was one instance of "mutation commands
  silently guess what an unrecognized flag meant" (a typo'd `--blocked-by`
  would have been just as bad, and quieter). `list`, `done`, and
  `set-priority` parse with empty allowlists, so stray `--flags` fail loudly
  everywhere, not just on `add`.
- **EPIPE = normal termination.** HANDOFF attributed the `list | head`
  crash to this item too: a consumer closing the pipe early surfaced as an
  unhandled `error` event on `process.stdout` and dumped a stack trace.
  Both stdout and stderr now treat EPIPE as exit 0.

Contract documented in the queue.js header comment, the usage block itself,
and README §1.

## Testing notes

Three new cases in `todos/queue.test.js` (22 total), each verified to FAIL
against the pre-fix queue.js before trusting the pass:

- The help sweep drives `--help`/`-h` through every command shape and
  asserts usage output, exit 0, and a byte-identical manifest + no scaffold.
- The unknown-flag sweep covers all seven subcommands (including a realistic
  `--sug` typo) asserting exit 2 and an untouched tree.
- The EPIPE test had two traps worth recording. (1) Output must **overflow
  the OS pipe buffer** (64KB): with a small queue every write lands in the
  buffer before `head` exits and EPIPE never fires — the test passes
  vacuously. Since `list` renders manifest ids with no file as "MISSING
  FILE" instead of dying, an 8001-entry manifest with one real file keeps
  the fixture cheap. (2) stderr must be captured **outside** the pipeline:
  the obvious `cmd 2>&1 | head -3` truncates the crash trace along with the
  listing and hides the bug — `spawnSync` on the pipeline with its own
  stderr capture is the honest structure.

Acceptance re-run in the real repo: `add --help` → usage/exit 0/clean tree;
`add next --slug x --bogus-flag` → exit 2, nothing written; `list | head` →
clean; `check` OK.

Follow-ups: none. (Unknown bare-word positionals were left as-is — they
already fail loudly where they matter: `add` rejects a non-NNNN id, and the
id-taking commands error on ids not in the queue.)
