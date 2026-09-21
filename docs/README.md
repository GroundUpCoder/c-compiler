# docs/ — design docs, the liability register, and the retired queue archive

> **Work items are cc tickets, not files.** The authoritative work queue is
> the **cc ticket tracker**: `cc-meta ticket` in the c-compiler project (id
> `019d77d8-f894-7d09-9099-4e747aa20bfb`). The file-based queue was retired on
> 2026-07-30 and its `todos/` directory was dissolved on 2026-09-21: design
> docs moved here, the completed items to `archive/`, the register validator
> to `tools/liabilities/`, the pre-commit hook to `tools/githooks/`. See
> `CLAUDE.md` "Tickets & the work queue" for the live workflow.

Three kinds of files live here:

1. **Design / topic docs** (`NAME.md`) — live, referenced by tickets.
2. **The liability register** (`LIABILITIES.md`) — live, checked by the
   `liabilities` test suite and the pre-commit hook.
3. **The archive** (`archive/` + section 3 below) — read-only history of
   everything that shipped under the retired file queue.

Together with the dev log (`logs/`, see `logs/README.md`) they answer: where
are we, where are we going, and why.

## 1. Design / topic docs: `NAME.md`

Long-lived design decisions and backlogs. Tickets reference them; they
don't duplicate them. Current map:

- `PRINCIPLES.md` — **contract-anchored correctness + honest shape** (jku,
  2026-08-13, set in stone): how work is classified, prioritized, designed
  and reviewed. Read before filing or designing.
- `GAMEDEV-EPIC.md` — **the primary epic** and the ticket-selection policy;
  `PKGDEV-EPIC.md` is the tabled one. `QUEUE-CLASSIFICATION.md` and
  `QUEUE-EPIC-MEMBERSHIP.md` record the queue rulings behind them.
- `OS.md` — **the north star**: the wasm-native browser OS, the
  posix_spawn-not-fork decision, the reference-build (`os/`) layout, the
  phased roadmap the queue is drawn from.
- `KERNEL.md` — the process control plane design (kernel.js): kernel page,
  doorbell, signals, tty, the fd/data-plane amendment, pipes, AF_UNIX
  sockets, settled-decisions table. 0x1xxx is the WM opcode space, 0x2xxx
  the audio mixer's.
- `WM.md` — the compositor/WM design: backend × transport axes, per-process
  WebGPU devices, kernel-worker compositing, surface protocol, WM-as-client
  over AF_UNIX, agent control channel, Aero effects, known issues.
- `WIN32.md` — **the primary UI toolkit**: Win32 (user32 windowing + gdi32
  drawing + a kernel32 subset) over the surface protocol + POSIX kernel.
  `TOOLKIT.md` is the superseded Elm/MVU direction, kept as a redirect.
- `NETWORK.md` — the networking tier model: loopback AF_INET in-kernel,
  curl-easy HTTP over fetch, getaddrinfo-over-DoH, the localhost relay.
- `DISK-IMAGE.md` — the read-only system image & upgrade discipline
  (mkimage-baked sealed volume at /usr, merged-usr, swap-the-blob upgrades).
- `SDL3.md`, `SDL3-MIGRATION.md`, `WEBGPU.md` — runtime API surface plans.
- `IDLE-POWER.md` — SDL frame pacing off the compositor clock and the
  blocking-wait tiers.
- `COMMAND-ALTERNATIVES.md` — the `cmdalt` switchable-command design.
- `PUBLISH-PATH.md`, `SOFTWARE-NATIVE.md` — the package publish path and the
  native software-manager design.
- `CPYTHON.md`, `CLANG-CPP-EPIC.md`, `CPP-LADDER-PROPOSAL.md` — the
  CPython / clang-sibling programme (starts only on a jku ruling).
- `RUST.md`, `RUST-D1-RULING.md` — the Rust programme and its ruling.
- `NETSURF-JS.md`, `W3M-INVESTIGATION.md` — the browser port and the
  text-browser investigation.
- `KEYMAP.md`, `KEYBINDING-OVERRIDE-SYSTEM.md`, `META-ARROW-KEYBIND.md` —
  keyboard mapping and the keybind override system.
- `EMULATORS.md`, `MGBA.md` — the Game Boy emulator pair and the mGBA port.
- `CONFORMANCE-REMAINING.md` — verified-but-unfixed compiler/host findings.
- `INLINER-WAST-PIPELINE-DESIGN.md`, `GOTO-LABELS-AST-REFACTOR.md`,
  `WASM_GC.md`, `EXTERNREF.md` — compiler pipeline and
  wasm feature designs.
- `DOM.md`, `EXPOSE-MISSION-CONTROL.md`, `WINE-CONFORMANCE-SCOPE-335.md`,
  `BAKED-BINARY-AUDIT-2026-08-08.md`, `BLOCK_FS.md`, `MISC.md` — smaller
  designs, audits and notes.
- `CALLBACKS.md` — the host callback ABI (table-index and direct
  function-reference callbacks).
- `NODE_VERSIONS.md` — the Node.js compatibility matrix.
- `test-halfscope-audit.md`, `wasm-dynamic-linking-and-malloc-dso.md` —
  read-only findings (a browser-sweep honesty audit; the shared-library /
  malloc-as-DSO sequencing decision).

There is deliberately no ordered roadmap in this file — the ticket tracker is
the order.

## 2. The liability register: `LIABILITIES.md` + `tools/liabilities/`

`docs/LIABILITIES.md` is **the index of gaps the tree describes but nothing
schedules.** Each entry cites a code location (file + a literal anchor line),
one line naming the gap, and the **live** ticket that funds it.

It exists because a *true* gap comment is more dangerous than a false one. A
false comment contradicts behaviour and something eventually breaks; a true one
reads as known-and-handled, and **is itself the reason nobody looks again.**
The 2026-07-27 sweep found 12 such gaps and all 12 had the same cause — they
never entered the scheduling system.

```
node tools/liabilities/liabilities.js check     # validate the register (exit 1 on failure)
node tools/liabilities/liabilities.js list      # entries with anchors resolved to file:line
node tools/liabilities/liabilities.js next-id   # next free Lnn id (surveyed across refs)
```

Funding tickets are cc tickets (`#N`); legacy ids in `defers-to:`/`expired:`/
`provenance:` still resolve against `archive/`. The check fails on a closed or
missing funding ticket, a `defers-to:` that is closed and unpinned (*the
deferral outlived its premise*), a pin whose target has reopened, an anchor
that has moved or vanished, an unclassified ticket id inside an anchor, and on
an empty or unparsable register. Full field reference: the register's own
header. Its tests are `tools/liabilities/liabilities.test.js`.

**Two invokers, neither optional.** The `liabilities` suite in `tests/run.js`
runs it, with the diff planner routing **every file the register cites** to
that suite, so a code edit that rewrites an anchored comment is caught too
(`tests/run.js --diff` is the gate every lane already runs). And the committed
pre-commit hook (`tools/githooks/pre-commit`) runs it on every commit once you
opt a clone in:

```
git config core.hooksPath tools/githooks
```

(Clones that opted in before 2026-09-21 point at the old `todos/githooks`
path and must re-run this.)

**Enrolment rule** — what obliges a gap to appear there: *if a comment's
sentence is true, does it imply work?* Then it is a liability and needs a
ticket plus an entry, in the same commit. Not a `TODO`-marker lint: the
2026-07-27 sweep's 12 findings carried no markers, so a marker lint would have
found none of them. The checker guarantees the register → tree direction; the
tree → register direction is a recurring sweep pass.

Register entry ids (`Lnn`) are allocated across every ref via
`tools/liabilities/idspace.js` (`liabilities.js next-id`), because parallel
lanes still add entries concurrently — the same collision that motivated the
survey (`L44`, `L47`) is still possible for `Lnn` even though `NNNN`
allocation is gone. The survey reads both the current paths and the
pre-2026-09-21 `todos/` paths, so refs and sibling worktrees that predate the
move still count.

## 3. Historical: the retired file-queue convention (for reading `archive/`)

Everything below describes the RETIRED system. It is kept so the `archive/`
files stay readable; none of it applies to new work.

- One numbered file per unit of work: `NNNN-<slug>.md`. **Numbers were stable
  IDs**, four digits, allocated sequentially across all refs, never reused.
  Commits, dev logs, and code comments cited items as `todos/NNNN`; live code
  now writes `docs/archive/NNNN`, and both forms resolve into `archive/` (or,
  for deleted items, git history and the dev log named beside the citation).
- **`archive/` holds completed items** (same filename as when open; it was
  `todos/done/` until 2026-09-21). Dropped / superseded items whose text was
  worth keeping moved there too, with a DROPPED status header; ones with
  nothing to keep were deleted outright with the rationale in a dev log.
- **Each item carries its own status header** (`Status:`, `Design:`) followed
  by goal / plan / acceptance criteria. A committed design doc could be filed
  beside its ticket as `NNNN-<slug>-design.md`; a `-design.md` that is the
  only file with its id is itself the ticket
  (`archive/0007-wm-compositor-design.md`).
- **Ordering lived in `queue.json`** (array order within a priority bucket;
  `blockedBy` hard deps, `after` soft hints, `priority` 0–3, `difficulty`
  tags), mutated only through `todos/queue.js` — the single writer +
  validator — and enforced by the pre-commit hook. Those semantics carried
  over 1:1 to the cc ticket tracker's fields at the 2026-07-30 migration.
- The queue tooling itself (`queue.js`, `queue.test.js`, `queue.json`) was
  removed at retirement; see git history before 2026-07-30 for the
  implementation.

## Conventions

- Don't re-litigate settled decisions (marked in the design docs) without
  new evidence — record the *why* when deciding anything new.
- Land a dev-log entry when completing anything substantial
  (`logs/YYYY-MM-DD/<topic>.md`), cross-linking the funding ticket.
