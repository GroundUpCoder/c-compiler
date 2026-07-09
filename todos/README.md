# todos/ — design docs + the work queue

Two kinds of files live here. Together with the dev log (`logs/`, see
`logs/README.md`) they answer: where are we, where are we going, and why.

## 1. The work queue: `NNNN-<slug>.md`

One numbered file per unit of work we have actually committed to doing.

- **Numbers are stable IDs**, four digits, allocated sequentially, never
  reused. Reference items as `todos/0001` in commits, dev logs, and other
  docs.
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
- **Done items move to `todos/done/`** (same filename), so
  `ls todos/*.md` is always the open queue. Dropped/superseded items
  whose text is worth keeping move there too, with the DROPPED status
  header intact (0047/0056); ones with nothing to keep are deleted
  outright with the rationale in a dev log (0006). Land a dev-log entry
  when completing anything substantial.
- New work: `node todos/queue.js add next --slug <slug>` scaffolds the file
  **and** slots it into the manifest in one checked step (don't hand-allocate
  numbers or hand-edit two files). Ideas that aren't committed work yet stay in
  the topic docs below until promoted.

### Maintaining the queue: `queue.json` + `queue.js`

`todos/queue.json` is the **ordering manifest** — the authoritative source for
the order of attack and the hard-vs-soft dependency split (which prose can't
express unambiguously). Array order *is* the order. Each entry:

- `blockedBy` — HARD deps: the item isn't ready until every listed id is in
  `todos/done/` (the cc Todos tab renders this as a ⛓ block).
- `after` — SOFT/advisory "best sequenced after" hints; they do **not** gate
  readiness (rendered lighter, as `after ▸`). Use this for "do X before Y is
  nicer" rather than "Y is broken without X".

Everything else (title, status, body) stays in the
`NNNN-<slug>.md` files. Mutate the queue through the CLI — the single writer +
validator — never by hand-editing `queue.json`:

```
node todos/queue.js list                              # resolved order + ready/blocked
node todos/queue.js add next --slug foo [--blocked-by 0057 --after 0058]
node todos/queue.js reorder 0064 --after 0058
node todos/queue.js block 0048 --hard 0058,0060 --soft 0059
node todos/queue.js done 0057                         # git-mv to done/, drop from queue
node todos/queue.js check                             # MUST pass before committing a queue change
```

`node todos/queue.js check` must pass before a queue change is committed (it
verifies every open file is listed exactly once, no ghost ids, deps reference
real todos, no `blockedBy` cycles, and that no open item carries a structured
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

### Themes (orientation only — the queue is the order)

There is deliberately **no ordered roadmap in this file**: a hand-maintained
copy of the manifest drifted every time an item landed. For the live order,
run `node todos/queue.js list` or open the cc Todos tab. What was history
narrative in the old list lives where it always did: `todos/done/` (what
landed) and the dev log (why and how).

For orientation, the standing themes: the **Win32 desktop platform** is the
primary UI toolkit and supersedes microui/MVU (`WIN32.md`); a **drawing /
compositor** track runs alongside (`WM.md`); **networking** has its own
tiered design (`NETWORK.md`); the **wc fork** is the side project (`WC.md`).
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
- `BLOCK_FS.md`, `MISC.md` — filesystem notes; grab-bag.

## Conventions

- Don't re-litigate settled decisions (marked in the design docs) without
  new evidence — record the *why* when deciding anything new.
- Keep the queue-item status headers in sync with reality; together with
  `queue.json` (viewed via `node todos/queue.js list`) and `todos/done/`
  they are the "where are we" of the repo. There is no *Next up* list to
  maintain — hand-copied roadmaps were deleted 2026-07-10 for drifting
  (`logs/2026-07-10/todos-single-source.md`).
