# todos/ — design docs + the work queue

Two kinds of files live here. Together with the dev log (`logs/`, see
`logs/README.md`) they answer: where are we, where are we going, and why.

## 1. The work queue: `NNNN-<slug>.md`

One numbered file per unit of work we have actually committed to doing.

- **Numbers are stable IDs**, four digits, allocated sequentially, never
  reused. Reference items as `todos/0001` in commits, dev logs, and other
  docs.
- **Number ≠ priority.** The *Next up* list below is the authoritative order
  of attack; keep it short and current.
- **Each item carries its own status header** (`Status:`, `Depends:`,
  `Design:`) followed by goal / plan / acceptance criteria. Items stay
  thin — detail belongs in the design doc they point at.
- **Done items move to `todos/done/`** (same filename), so
  `ls todos/*.md` is always the open queue. Land a dev-log entry when
  completing anything substantial.
- New work: allocate the next number, add a file, slot it into *Next up*.
  Ideas that aren't committed work yet stay in the topic docs below until
  promoted.

### Next up (order of attack)

1. `0010` busybox coreutils (multicall /bin binaries)
2. `0006` threads + atomics
3. `0007` window manager / compositor — design doc first
4. `0008` networking — AF_UNIX first

(Done: `0001` signals/EINTR/exit handshake; `0002` tty + line discipline;
`0009` kernel-owned fd table + brokered fs; `0003` pipes + job control;
`0004` the os/ reference build; `0005` THE SHELL — busybox hush as
/bin/sh via the vfork-on-__spawn port: pipelines, $( ), redirects,
here-docs, job control, popen/system — the kernel design's acceptance
test, passed. OS.md Phase 1 is complete except coreutils.)

(The compiler-conformance tail in `CONFORMANCE-REMAINING.md` and the SDL3/
WebGPU backlogs run alongside; promote specific chunks into numbered items
when they get scheduled.)

## 2. Design / topic docs: `NAME.md`

Long-lived design decisions and backlogs. Queue items reference them; they
don't duplicate them. Current map:

- `OS.md` — **the north star**: the wasm-native browser OS, the
  posix_spawn-not-fork decision, the reference-build (`os/`) layout, the
  phased roadmap the queue is drawn from.
- `KERNEL.md` — the process control plane design (kernel.js): kernel page,
  doorbell, signals, tty, the fd/data-plane amendment, pipes,
  settled-decisions table. Phases 1–3 + the brokered fs are implemented
  (0001/0002/0009 in done/); `0003` (pipes + job control) is the remainder.
- `CONFORMANCE-REMAINING.md` — verified-but-unfixed compiler/host findings.
- `SDL3.md`, `SDL3-MIGRATION.md`, `WEBGPU.md` — runtime API surface plans.
- `DOM.md` — C-to-DOM bytecode + diffing renderer idea.
- `WASM_GC.md`, `EXTERNREF.md` — wasm GC / externref features.
- `GOTO-LABELS-AST-REFACTOR.md` — control-flow lowering refactor.
- `BLOCK_FS.md`, `MISC.md` — filesystem notes; grab-bag.

## Conventions

- Don't re-litigate settled decisions (marked in the design docs) without
  new evidence — record the *why* when deciding anything new.
- Keep this README's *Next up* list and the queue-item status headers in
  sync with reality; they are the "where are we" of the repo.
