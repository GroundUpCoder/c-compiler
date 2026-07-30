# todos/ — design docs, the liability register, and the retired queue archive

> **The file-based work queue was RETIRED on 2026-07-30.** The authoritative
> work queue is the **cc ticket tracker**: `cc-meta ticket` in the c-compiler
> project (id `019d77d8-f894-7d09-9099-4e747aa20bfb`). Open `NNNN-<slug>.md`
> items were migrated 1:1 into cc tickets; `queue.json` + `queue.js` and the
> queue half of the pre-commit hook were removed. See `CLAUDE.md`
> "Tickets & the work queue" for the live workflow (create / claim / done,
> priority, `--blocked-by` vs `--after`).

Three kinds of files still live here, and all three stay:

1. **Design / topic docs** (`NAME.md`) — live, referenced by tickets.
2. **The liability register** (`LIABILITIES.md` + `liabilities.js`) — live,
   checked by the `todos` test suite and the pre-commit hook.
3. **The archive** (`done/` + this file's "Historical" section) — read-only
   history of everything that shipped under the retired queue.

Together with the dev log (`logs/`, see `logs/README.md`) they answer: where
are we, where are we going, and why.

## 1. Design / topic docs: `NAME.md`

Long-lived design decisions and backlogs. Tickets reference them; they
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

For orientation, the standing themes: the **Win32 desktop platform** is the
primary UI toolkit and supersedes microui/MVU (`WIN32.md`); a **drawing /
compositor** track runs alongside (`WM.md`); **networking** has its own
tiered design (`NETWORK.md`). There is deliberately no ordered roadmap in
this file — the ticket tracker is the order.

## 2. The liability register: `LIABILITIES.md` + `liabilities.js`

`todos/LIABILITIES.md` is **the index of gaps the tree describes but nothing
schedules.** Each entry cites a code location (file + a literal anchor line),
one line naming the gap, and the **live** ticket that funds it.

It exists because a *true* gap comment is more dangerous than a false one. A
false comment contradicts behaviour and something eventually breaks; a true one
reads as known-and-handled, and **is itself the reason nobody looks again.**
The 2026-07-27 sweep found 12 such gaps and all 12 had the same cause — they
never entered the scheduling system.

```
node todos/liabilities.js check     # validate the register (exit 1 on failure)
node todos/liabilities.js list      # entries with anchors resolved to file:line
node todos/liabilities.js next-id   # next free Lnn id (surveyed across refs)
```

Funding tickets are cc tickets (`#N`); legacy ids in `defers-to:`/`expired:`/
`provenance:` still resolve against `done/`. The check fails on a closed or
missing funding ticket, a `defers-to:` that is closed and unpinned (*the
deferral outlived its premise*), a pin whose target has reopened, an anchor
that has moved or vanished, an unclassified ticket id inside an anchor, and on
an empty or unparsable register. Full field reference: the register's own
header. Its tests are `todos/liabilities.test.js`.

**Two invokers, neither optional.** The `todos` suite in `tests/run.js` runs
it, with the diff planner routing **every file the register cites** to that
suite, so a code edit that rewrites an anchored comment is caught too
(`tests/run.js --diff` is the gate every lane already runs). And the committed
pre-commit hook (`todos/githooks/pre-commit`) runs it on every commit once you
opt a clone in:

```
git config core.hooksPath todos/githooks
```

**Enrolment rule** — what obliges a gap to appear there: *if a comment's
sentence is true, does it imply work?* Then it is a liability and needs a
ticket plus an entry, in the same commit. Not a `TODO`-marker lint: the
2026-07-27 sweep's 12 findings carried no markers, so a marker lint would have
found none of them. The checker guarantees the register → tree direction; the
tree → register direction is a recurring sweep pass.

Register entry ids (`Lnn`) are still allocated across every ref via
`todos/idspace.js` (`liabilities.js next`), because parallel lanes still add
entries concurrently — the same collision that motivated the survey (`L44`,
`L47`) is still possible for `Lnn` even though `NNNN` allocation is gone.

## 3. Historical: the retired file-queue convention (for reading `done/`)

Everything below describes the RETIRED system. It is kept so the `done/`
archive stays readable; none of it applies to new work.

- One numbered file per unit of work: `NNNN-<slug>.md`. **Numbers were stable
  IDs**, four digits, allocated sequentially across all refs, never reused.
  Commits, dev logs, and docs cite items as `todos/NNNN`; those citations
  resolve into `todos/done/` (or, for deleted items, git history and the dev
  log named beside the citation).
- **`done/` holds completed items** (same filename as when open). Dropped /
  superseded items whose text was worth keeping moved there too, with a
  DROPPED status header; ones with nothing to keep were deleted outright with
  the rationale in a dev log.
- **Each item carries its own status header** (`Status:`, `Design:`) followed
  by goal / plan / acceptance criteria. A committed design doc could be filed
  beside its ticket as `NNNN-<slug>-design.md`; a `-design.md` that is the
  only file with its id is itself the ticket
  (`todos/done/0007-wm-compositor-design.md`).
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
