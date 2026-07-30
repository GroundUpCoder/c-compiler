# todos/ — design docs + the work queue

Two kinds of files live here. Together with the dev log (`logs/`, see
`logs/README.md`) they answer: where are we, where are we going, and why.

## 1. The work queue: `NNNN-<slug>.md`

One numbered file per unit of work we have actually committed to doing.

- **Numbers are stable IDs**, four digits, allocated sequentially, never
  reused. Reference items as `todos/0001` in commits, dev logs, and other
  docs.
- **IDs are allocated across ALL REFS, never from your branch** (0358). Lanes
  branch and push at the END, so the highest id on any single ref — including
  `origin/main` — is a **lower bound** on the id space, not the id space.
  Deriving "next" locally handed `0354` to two lanes at once (both were
  correct when they allocated; master renumbered one to `0356` at merge, and
  four references by hand with it). `queue.js add next` and
  `queue.js next-id` survey every ref through `todos/idspace.js`, print what
  they surveyed, and **refuse** rather than silently fall back to the local
  bound when they cannot reach git (`--local-ids` / `--local` is the explicit
  opt-out). The same rule and the same tool cover the liability register's
  `Lnn` ids — it collided the same way, one field over.
- **You no longer have to remember to `git fetch` first** (0360). "Remote refs
  are as fresh as your last fetch" used to be printed as a reminder, and the
  gap it described fired the day it shipped: a mid-merge main tree assigned
  `L47` in an **uncommitted** file while a worktree allocated `L47` off the
  refs. So the survey now measures itself and prints a `freshness:` line —
  `git ls-remote` proves whether a fetch would move anything (5s timeout,
  degrading LOUDLY on failure, `--offline` to skip it), every **sibling
  worktree**'s uncommitted `todos/` is read from disk, and the local
  fetch clock is the offline fallback. `add next` **refuses to write an id**
  when the remote is shown to contradict the survey; `next-id` only reports,
  since it writes nothing. Refuse on proof, warn on doubt. The one thing no
  probe can see is an id in a **different clone** that was never pushed —
  `todos/0364`, register `L52`.
- **One id, one file.** Two files sharing an id fail `queue.js check` (0358) —
  that is what a landed collision looks like, and before that check the second
  file was simply invisible to every validator. The one exception is a
  committed design doc filed beside its ticket (`NNNN-<slug>-design.md`, e.g.
  `todos/done/0275-*`); a `-design.md` that is the ONLY file with its id is
  itself the ticket (`todos/done/0007-wm-compositor-design.md`).
- **Number ≠ priority.** The order of attack lives in the **`queue.json`
  ordering manifest** (see "Maintaining the queue" below), not in the number.
  The ordered roadmap is a *view*, not a document: `node todos/queue.js list`
  (terminal) or the cc Todos tab (browser) — both render live from the
  manifest. There is deliberately no hand-maintained list of it here.
- **Each item carries its own status header** (`Status:`, `Design:`)
  followed by goal / plan / acceptance criteria. Items stay thin — detail
  belongs in the design doc they point at. Dependency **ids** live only in
  `queue.json` (a structured `Depends:` line in an open item fails
  `queue.js check`); sequencing **rationale** goes in the body prose
  ("best after the Win32 wave because…").
- **The `Status:` line is checked, in both directions** (0353): a ticket in
  `done/` whose line still leads with `open` fails `queue.js check`
  (`check --fix` rewrites it, and `queue.js done` now rewrites it at close
  time), and an OPEN ticket whose line claims a round its own body records as
  `## R<n> — DONE/LANDED` fails too — that one is NOT auto-fixed, because
  which side is stale is a judgement call. ⚠️ The classifier substring-tests
  that line for `deferred`, so a negated phrasing ("un-deferred") would read as
  *deferred*; `check` rejects the phrasing rather than guessing (footgun from
  0126). The directory stays the source of truth for done-ness and
  `queue.json` for priority — these checks only stop the prose contradicting
  them.
- **Done items move to `todos/done/`** (same filename), so
  `ls todos/*.md` is always the open queue. Dropped/superseded items
  whose text is worth keeping move there too, with the DROPPED status
  header intact (0047/0056); ones with nothing to keep are deleted
  outright with the rationale in a dev log (0006, whose surviving record is
  `logs/2026-07-07/threads-atomics-deferral.md`; the ticket was removed from
  the queue on 2026-07-09). Land a dev-log entry when completing anything
  substantial. ⚠️ **A citation of a deleted ticket does not resolve to a file.**
  When you cite one, name the dev log beside the number, so a reader can follow
  it.
- New work: `node todos/queue.js add next --slug <slug>` scaffolds the file
  **and** slots it into the manifest in one checked step (don't hand-allocate
  numbers or hand-edit two files). Ideas that aren't committed work yet stay in
  the topic docs below until promoted.

### Maintaining the queue: `queue.json` + `queue.js`

`todos/queue.json` is the **ordering manifest** — the authoritative source for
the order of attack and the hard-vs-soft dependency split (which prose can't
express unambiguously). Array order *is* the order within a priority. Each
entry:

- `blockedBy` — HARD deps: the item isn't ready until every listed id is in
  `todos/done/` (the cc Todos tab renders this as a ⛓ block).
- `after` — SOFT/advisory "best sequenced after" hints; they do **not** gate
  readiness (rendered lighter, as `after ▸`). Use this for "do X before Y is
  nicer" rather than "Y is broken without X".
- `priority` — optional integer 0–3: **P0 urgent, P1 default, P2 low, P3
  background**. Absent means P1, and the CLI omits the field at P1 to keep
  entries minimal. The **effective order of attack is priority first, then
  array position** — array order remains the only order *within* a priority
  bucket, and the array is never rewritten when a priority changes (the sort
  happens at read time, in `queue.js list` and the cc Todos tab, which marks
  non-P1 items `P0`/`P2`/`P3`).
- `difficulty` — optional tag **`light` / `medium` / `heavy`** (absent =
  untagged). It does **not** affect order or readiness; it lets a cc churn run
  in **light mode** skip `heavy` items (and lets a difficulty-triage pass fill
  the untagged ones in). The cc Todos tab renders a chip; `queue.js list` marks
  it `[heavy]` etc.

Everything else (title, status, body) stays in the
`NNNN-<slug>.md` files. Mutate the queue through the CLI — the single writer +
validator — never by hand-editing `queue.json`:

```
node todos/queue.js list                              # effective order + ready/blocked
node todos/queue.js add next --slug foo [--blocked-by 0057 --after 0058] [--priority 0]
node todos/queue.js set-priority 0064 0               # 0..3; 1 (default) removes the field
node todos/queue.js add next --slug foo --difficulty heavy   # light|medium|heavy
node todos/queue.js set-difficulty 0064 light         # light|medium|heavy|none (none clears)
node todos/queue.js reorder 0064 --after 0058
node todos/queue.js block 0048 --hard 0058,0060 --soft 0059
node todos/queue.js done 0057                         # git-mv to done/, drop from queue
node todos/queue.js check                             # MUST pass before committing a queue change
```

`-h`/`--help` anywhere prints usage and exits 0 — checked before dispatch, so
`add --help` can never scaffold an item. An unknown `--flag` on any subcommand
is a usage error (exit 2, nothing written); validation failures exit 1. `list`
tolerates a consumer closing the pipe early (`| head` is fine).

`node todos/queue.js check` must pass before a queue change is committed (it
verifies every open file is listed exactly once, no ghost ids, deps reference
real todos, no `blockedBy` cycles, any `priority` present is an integer 0–3,
any `difficulty` present is `light`/`medium`/`heavy`,
and that no open item carries a structured
`Depends:` line — deps belong in the manifest, rationale in body prose). Its tests live in `todos/queue.test.js`
(`node todos/queue.test.js`).

A committed **pre-commit hook** (`todos/githooks/pre-commit`) runs that check on
every commit so a drifted manifest can't land. It's off until you point git at
it once per clone (the setting is local, not committed):

```
git config core.hooksPath todos/githooks
```

Bypass a single unrelated commit with `git commit --no-verify`. The hook skips
silently on repos without a `queue.json`.

### The liability register: `LIABILITIES.md` + `liabilities.js` (todos/0286)

`todos/LIABILITIES.md` is the third checked file in this directory (after the
items and the manifest): **the index of gaps the tree describes but nothing
schedules.** Each entry cites a code location (file + a literal anchor line),
one line naming the gap, and the **live** ticket that funds it.

It exists because a *true* gap comment is more dangerous than a false one. A
false comment contradicts behaviour and something eventually breaks; a true one
reads as known-and-handled, and **is itself the reason nobody looks again.**
The 2026-07-27 sweep found 12 such gaps and all 12 had the same cause — they
never entered `todos/`.

```
node todos/liabilities.js check     # validate the register (exit 1 on failure)
node todos/liabilities.js list      # entries with anchors resolved to file:line
```

The check fails on a `ticket:` that is closed or missing, a `defers-to:` that
is closed and unpinned (*the deferral outlived its premise* — a pointer at a
`done/` item reads as handled), a pin whose target has reopened, an anchor that
has moved or vanished, an unclassified ticket id inside an anchor, and on an
empty or unparsable register. Full field reference: the register's own header.
Its tests are `todos/liabilities.test.js`.

**Two invokers, neither optional.** `queue.js check` runs it (so does the
pre-commit hook, and `queue.js done <ID>` names the entries a close just made
stale — that is the moment `0291`/`0293`/`0300` were each missed at). And the
`todos` suite in `tests/run.js` runs it, with the diff planner routing **every
file the register cites** to that suite, so a code edit that rewrites an
anchored comment is caught too. `tests/run.js --diff` is the gate every lane
already runs; the hook is per-clone opt-in, which is why the register does not
rely on it alone.

**Enrolment rule** — what obliges a gap to appear there: *if a comment's
sentence is true, does it imply work?* Then it is a liability and needs a
ticket plus an entry, in the same commit. Not a `TODO`-marker lint: the sweep's
12 findings carried no markers, so a marker lint would have found none of them.
The checker guarantees the register → tree direction; the tree → register
direction is a recurring pass (`todos/0302`), funded rather than noted.

### Themes (orientation only — the queue is the order)

There is deliberately **no ordered roadmap in this file**: a hand-maintained
copy of the manifest drifted every time an item landed. For the live order,
run `node todos/queue.js list` or open the cc Todos tab. What was history
narrative in the old list lives where it always did: `todos/done/` (what
landed) and the dev log (why and how).

For orientation, the standing themes: the **Win32 desktop platform** is the
primary UI toolkit and supersedes microui/MVU (`WIN32.md`); a **drawing /
compositor** track runs alongside (`WM.md`); **networking** has its own
tiered design (`NETWORK.md`).
Per-item sequencing rationale lives in each item's body prose.

(The compiler-conformance tail in `CONFORMANCE-REMAINING.md` and the SDL3/
WebGPU backlogs run alongside; promote specific chunks into numbered items
when they get scheduled — they get a number then, not before.)

## 2. Design / topic docs: `NAME.md`

Long-lived design decisions and backlogs. Queue items reference them; they
don't duplicate them. Current map:

- `OS.md` — **the north star**: the wasm-native browser OS, the
  posix_spawn-not-fork decision, the reference-build (`os/`) layout, the
  phased roadmap the queue is drawn from.
- `NETWORK.md` — the networking tier model (2026-07-09): loopback
  AF_INET in-kernel, curl-easy HTTP over fetch, getaddrinfo-over-DoH,
  the pluggable localhost websockify relay (→ 0052/0053/0054).
- `KERNEL.md` — the process control plane design (kernel.js): kernel page,
  doorbell, signals, tty, the fd/data-plane amendment, pipes, AF_UNIX
  sockets, settled-decisions table. All phases implemented
  (0001/0002/0003/0009/0008 in done/); 0x1xxx is the WM opcode space,
  0x2xxx the audio mixer's (0017).
- `WM.md` — **the compositor/WM design** (0007, 2026-07-07): backend ×
  transport axes, per-process WebGPU devices, kernel-worker compositing,
  surface protocol, WM-as-client over AF_UNIX, agent control channel,
  headless tiers, spike appendix (→ 0012), implementation plan.
- `WIN32.md` — **the primary UI toolkit** (2026-07-09): Win32 (user32
  windowing + gdi32 drawing + a kernel32 subset) over the surface protocol
  + POSIX kernel (→ 0057–0060). Chosen because the HWND tree makes agent-
  drivability structural; supersedes microui/MVU. Includes the windowing-
  vs-drawing (Win7/DWM) split and the POSIX-coexistence model.
- `TOOLKIT.md` — **superseded by `WIN32.md`** (2026-07-09): the former
  Elm/MVU direction (0047/0056), now dropped; kept as a redirect + history.
- `CONFORMANCE-REMAINING.md` — verified-but-unfixed compiler/host findings.
- `SDL3.md`, `SDL3-MIGRATION.md`, `WEBGPU.md` — runtime API surface plans.
- `DOM.md` — C-to-DOM bytecode + diffing renderer idea; its declaration
  encoding is reused by `TOOLKIT.md`'s vtree (browser-DOM as a possible
  alternate backend later).
- `WASM_GC.md`, `EXTERNREF.md` — wasm GC / externref features.
- `SS-INTEROP.md` — running self-service (`.ss`) modules in this runtime
  (proposed 2026-07-09): the flavor-agnostic `runModule`, and ss-as-a-
  loadable-library that C `dlopen`s — GC/externref shared ABI, no PIC. One
  slice landed (`host.js` core-env dispatch, `6b8e385`). ss-loads-into-C
  only; the reverse is a settled no.
- `GOTO-LABELS-AST-REFACTOR.md` — control-flow lowering refactor.
- `DISK-IMAGE.md` — the read-only system image & upgrade discipline
  (0040, LANDED 2026-07-08): mkimage-baked sealed RO volume at /usr,
  merged-usr, /usr/local, systemd-style /etc, swap-the-blob upgrades.
  Design decisions + the in-item decisions record.
- `EMULATORS.md` — the Game Boy emulator pair (2026-07-28): `vendor/gameboy`
  = Peanut-GB **and the shared ROM store**, `vendor/sameboy` = SameBoy and the
  **default** `.gb`/`.gbc` handler; why the `gameboy`→`peanutgb` rename was
  proposed and **rejected**; what blocks `sameboy-clang` (→ 0347).
- `BLOCK_FS.md`, `MISC.md` — filesystem notes; grab-bag.

## Conventions

- Don't re-litigate settled decisions (marked in the design docs) without
  new evidence — record the *why* when deciding anything new.
- Keep the queue-item status headers in sync with reality; together with
  `queue.json` (viewed via `node todos/queue.js list`) and `todos/done/`
  they are the "where are we" of the repo. There is no *Next up* list to
  maintain — hand-copied roadmaps were deleted 2026-07-10 for drifting
  (`logs/2026-07-10/todos-single-source.md`).
