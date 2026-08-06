# C Compiler

`compiler.js` is the primary compiler in this repo — a C → WebAssembly compiler in a single file. All other files (host.js, serve.js, tools/, vendor/) are auxiliary.

**North star** (see `todos/OS.md`): a WebAssembly-native, almost-POSIX OS in a
browser tab — every binary a real wasm module from this compiler, with
persistence (BlockFS), a shell, and eventually a compositor/window manager.
"Almost" because `fork()` is deliberately replaced by the owner-brokered
`posix_spawn` model (decision + rationale in `todos/OS.md` — don't re-litigate).

## CORE PRINCIPLE — build to the goal, not to the demo (NO "not used yet" shortcuts)

**If a capability naturally pertains to the goal and scope, IMPLEMENT it —
properly, elegantly, cleanly, at the right (extended) level of generality. NOT
the minimum needed to make a demo pass.** "There's no current customer",
"nothing uses it yet", "all current apps happen to be CPU-rendered", "we can
revisit later" are NOT valid reasons to cut scope, drop generality, special-case
the easy path, or recommend against a clean design. Build the general case:
GPU-surface apps are FIRST-CLASS, not a CPU path with a GPU asterisk; transport
(shm vs GPU/ImageBitmap), rendering backend, and similar axes must be handled
uniformly, not assumed away.

The escape hatch is narrow and explicit: if the complexity is **genuinely high
AND it does not actually align with the north-star goals**, then don't do it. If
you are **unsure** whether it's in scope or worth the cost, **surface it and
discuss** — do not silently cut it or ship the minimal-to-hide-a-demo version.
When something obviously should be implemented, implement it cleanly. This
applies to design reviews too: do not justify a recommendation with "no current
customer" — that is the exact anti-pattern being rejected here.

## Portability

`compiler.js` MUST work in both browser and Node.js environments. Never use `process.env`, `process.stderr`, `process.exit`, `process.hrtime`, or any other Node.js-specific API without a `typeof process !== 'undefined'` guard and a browser-compatible fallback. No environment variables — use compiler options and CLI flags instead.

## Tickets & the work queue (`cc-meta ticket`)

**🎯 THE PRIMARY EPIC (jku, 2026-08-04): game development inside gucOS —
C + SDL3 + gcode — is the north star every batch of work falls under.
Read `todos/GAMEDEV-EPIC.md` before selecting or filing work.** The backlog
is being rescrubbed against it; unrelated work is deprioritized (not
deleted). A queued Epic 2 (CPython/cpython-clang + pygame) starts only when
jku says.

**The authoritative work queue is the cc ticket tracker** — per-project,
DB-backed work items driven with the `cc-meta ticket` CLI. This repo's
project is **c-compiler** (project id `019d77d8-f894-7d09-9099-4e747aa20bfb`).
The old file-based queue (`todos/NNNN-<slug>.md` + `todos/queue.json` +
`todos/queue.js`) was **retired 2026-07-30**; its open items were migrated
1:1 into cc tickets, and `todos/done/` remains as the read-only archive of
everything that shipped under the old system (see `todos/README.md`).

- **Ticket numbers are per-project `#N`.** Reference tickets as `#N` in
  commits and dev logs. A bare number is ambiguous across projects — pass
  `--project 019d77d8-f894-7d09-9099-4e747aa20bfb` when addressing a ticket
  by number; the full ticket id is unambiguous everywhere. Historical
  `todos/NNNN` citations resolve into `todos/done/` or git history, not into
  the ticket tracker — the two id spaces are unrelated.
- **Canonical flow** (there is no engine — the coordinator is the engine):
  `cc-meta ticket next --project <id>` peeks the top READY ticket → spawn the
  working thread → `cc-meta ticket claim <ref> --thread <chatId>` (atomic;
  refuses an already-claimed ticket so two lanes can't double-drive one) →
  do the work → `cc-meta ticket done <ref> --outcome "…" --commit <sha>`.
  Abandon/reassign with `ticket release`; park with `ticket defer`; won't-do
  with `ticket drop`.
- **Filing work**: `cc-meta ticket create <projectId> --title … --body @file`
  (markdown Goal/Plan/Acceptance body — the same shape the old item files
  had). Ideas that aren't committed work yet stay in the design docs until
  promoted.
- **Order + deps**: effective order is **priority bucket, then queue
  position** (`ticket reorder` moves within a bucket). `--blocked-by` is the
  HARD dependency (not ready until every listed ticket is done);
  `--after` is the SOFT "best sequenced after" hint (never blocks).
  View the queue with `cc-meta ticket list --project <id>` (blocked tickets
  are marked, never hidden) or the cc Tickets tab.
- 🔴 **`--difficulty light|medium|heavy` is MANDATORY on every ticket you
  file.** The *tool* does not sort by it — the key is
  `projectId/priority/orderIndex` and no ordering path reads `difficulty` — but
  **a coordinator does, by hand.** Standing policy (jku, 2026-08-02): weight is
  the OUTER sort key, light → medium → heavy, and Pn only breaks ties *inside*
  a tier, so **a light P3 runs before a heavy P0**. Recorded dependencies still
  outrank both — the weight sort never reorders across a `blockedBy` edge.
  An **unlabeled** ticket cannot be sorted at all, so it silently sinks; 86 of
  222 ready tickets were unlabeled on 2026-08-02 because this line used to read
  "it never affects order" and every filer took that as "the field is
  decorative". If you pick up an unlabeled ticket, run
  `cc-meta ticket update <ref> --difficulty …` before you queue it — never
  guess silently, never skip it. Full policy: `~/git/meta/CLAUDE.md`, section
  "Task WEIGHT outranks priority"; rationale and census:
  `~/git/meta/notes/task-weight-policy-2026-08-02.md`.
- 🔴 **`cc-meta ticket update <ref> --blocked-by <uuid>` IS A SILENT NO-OP.** It
  returns `HTTP 400 {"error":"Nothing to update"}` **with `exit=0`**, so a loop
  over N edges "succeeds" and sets **nothing**. Reproduced directly, 2026-08-04.
  ✅ **The real verb is `cc-meta ticket block <ref> --hard <id,id,…>`.**
  **Verify by RE-READING** — require the `blockedBy` count to equal the number of
  edges you meant to set AND `derived.ready == false`. **Never accept an exit
  code as proof of a mutation.** This is the concrete mechanism that made every
  "recurring" pass in this repo die silently: the chain looked healthy because
  the tool reported success.
- 🔴 **Every ticket you queue needs a WRITTEN epic justification** (jku,
  2026-08-04): *"All work going forward should be justifiable in the context of
  the epic."* Put it in the kickoff and in the coordinator's state note.
  **Queueing a ticket with no articulated justification is itself the error.**
  The test is an **argument**, not the word "game" — anything on the path of a
  developer building a game inside gucOS qualifies (toolchain, text/fonts,
  source control, the in-OS dev loop, platform stability). Full rulings:
  `todos/GAMEDEV-EPIC.md`, section "Epic membership is ARGUED, not
  pattern-matched".
- **Design/topic docs**: `todos/NAME.md` (OS.md, KERNEL.md, SDL3.md, …) —
  long-lived designs and backlogs that tickets reference for detail. These
  stay in the repo; only the queue moved.
- **Liability register**: `todos/LIABILITIES.md` (todos/done/0286) — the
  index of gaps the tree *describes* but nothing schedules. Each entry cites
  a file + a literal anchor line, one line on the gap, and the **live**
  ticket funding it. A *true* gap comment is more dangerous than a false
  one: it reads as known-and-handled, so the documentation is the reason
  nobody looks again. `node todos/liabilities.js check` fails on a
  closed/missing `ticket:`, a `defers-to:` that has already shipped and is
  unpinned (the deferral outlived its premise), a moved/vanished anchor, or
  an empty register — run by the `todos` suite in `tests/run.js` and by the
  pre-commit hook (`git config core.hooksPath todos/githooks` per clone).
  **Enrolment rule**: if a comment's sentence is true and implies work, it
  needs a ticket AND an entry in the same commit (not a `TODO`-marker lint —
  the 12 findings that motivated this carried no markers).

**Priority policy (P0 bugs always come first).** Priorities are 0–3
(P0 urgent … P3 background, default P1); the tracker orders by priority
bucket then position, so P0 items lead the queue by construction — keep it
that way:

- **P0 — correctness bugs in existing/shipped features.** Anything that already
  works but is now broken or wrong is P0 and jumps the queue ahead of all
  feature work. **Any bug found from anywhere — a report, a manual UX sweep, an
  incidental discovery — is filed P0 unless the user explicitly says otherwise.**
- **P1 (default) — feature work, new capabilities, ports, enhancements.** New
  things and "make it better" work sit behind the bug backlog.
- Set with `--priority 0` at `ticket create`, or `cc-meta ticket update <ref>
  --priority 0` later. Don't silently demote an existing user-set priority;
  when in doubt, ask.

Check the ticket queue, the design docs, and the liability register before
starting new work; reference tickets as `#N` in commits and dev logs.

## Dev logs

`logs/YYYY-MM-DD/<topic>.md` is a **committed** engineering journal (folder per
local day, file per topic) capturing the *why* behind non-trivial work —
decisions, trade-offs, gotchas. Add an entry when landing anything
substantial, cross-linking tickets as `#N` (historical entries cite
`todos/NNNN`, which resolves into `todos/done/` or git history). In-repo
convention doc: `logs/README.md`.

## Running tests — `tests/run.js` (unified entry + diff-aware)

`node tests/run.js` (todos/0084) is the ONE dispatcher over the whole
estate — the individual runners (`tests/run-unit.js`, `tests/run.py`
categories, `tests/host/run.js`, `tests/blockfs/run.js`,
`tests/kernel/run.js`, `tests/browser/os-sweep.mjs`) stay independently
invocable; this just knows how to invoke them uniformly and, the point,
**which of them a given diff needs**:

- `node tests/run.js all` — the entire estate, one combined exit code +
  a merged `build/test-run/summary.json`.
- `node tests/run.js unit kernel` — named suites (see `--list`).
- `node tests/run.js --diff [ref]` — map the touched paths → suites and
  run exactly those (default: the working set vs HEAD; pass a ref to diff
  against it). `--dry-run` prints the plan and runs nothing.
- Passthrough: `--filter=STR` (all suites), `-j N`/`--resume`/`--fail-fast`
  (the suite-runner-backed suites), plus `--repeat N`/`--under-load[=N]`
  (kernel/blockfs/sweep — the flake gate, below).

**The record states its own scope (todos/0339).** A full browser sweep does not
fit one tool call, so it is habitually split into two `--filter` halves — and a
`pass` whose scope is unrecorded is not evidence of scope. Every suite-runner
suite's `summary.json` therefore carries `filter`, a `files` block (`total` /
`selected` / `executed` / `resumed` / `carried` / `recorded`) and a `runs` list,
and MERGES across runs, so half 2 no longer deletes half 1 — **`recorded ==
total` is what "the whole suite ran" looks like on disk**, and a filtered run
prints `⚠ N of M files selected` up front. `build/test-run/summary.json` mirrors
the `--filter`, the resolved suite list, and each artifact-backed suite's `files`
block. Carried-in results are tagged `carried` + `carriedFrom`, and `--resume`
deliberately ignores them (a stale pass must never be resumed into a "full" run).
Stale `build/test-browser/*.log` are kept on purpose: carried results cite them,
and counting logs OVERSTATES — the manifest is the count that means anything.

**Suite membership is guarded (ticket #314).** The kernel/blockfs member lists
are hardcoded, which three times produced a test that existed on disk, mapped
to the suite by `planFromDiff`, and executed NOWHERE behind a green gate
(`recorded == total` can't catch it — the list defines `total`). Two guards in
`tests/lib/suite-runner.js` close the class with keys independent of the
runner's own bookkeeping: `assertMemberRegistry` (set equality — an on-disk
`test_*.js` not in the member list, or vice versa, REFUSES the run naming the
file; deliberate exclusions live in a named allowlist carrying their owning
ticket, and a stale entry fails too) and the `evidence` opt (after a run,
every selected member — keyed by the DIRECTORY GLOB — must have an
`<artifactDir>/<name>.log` post-dating the run's start; `--resume` relaxes
resumed files to existence-only, loudly). So: registering a new kernel test in
`tests/kernel/run.js` is not optional bookkeeping — the suite will not run
without it.

### Heavy-suite RAM policy — never run two at once (`tests/lib/heavy-lock.js`)

The **kernel suite** (concurrent full-OS boots, each a nested `os/boot.js`
node at ~4 GB) and the **browser sweep** (a real Chromium per file) are the
RAM-heavy suites. Two of them at once — two lanes, a stray re-run, a
coordinator kicking one while another holds one — stack their process trees
and exhaust memory. On **2026-07-25** that OOM'd a 16 GB box into a jetsam
death spiral → launchservicesd lock convoy → WindowServer watchdog kill (the
GUI died; uptime intact — not a reboot). Two guards now enforce the policy,
both invisible on a normal single run:

- **Host lock (across processes):** kernel + sweep take an exclusive
  `os.tmpdir()/cc-heavy-tests.lock` at startup and **fail fast (exit 3)** if
  another heavy runner owns it — they are mutually exclusive, kernel ⟷ sweep
  included. Self-heals from a stale lock left by a killed holder. Bypass on a
  genuinely isolated host (own container/VM) with `CC_NO_HEAVY_LOCK=1`.
  **Since todos/0342 the lock guards the BOOT, not just the runners:**
  `os/boot.js` itself joins at startup (so a single-file kernel e2e, a bench
  tool, and a bare `node os/boot.js` all participate — exit 3 names the
  holder; `--wait-lock[=SECS]` is boot.js's loud-wait opt-in for an
  interactive reproduce), and `tests/browser/lib/os-harness.mjs` joins before
  any serve.js/Chromium (so a hand-run `os-*.mjs` participates too).
  Re-entrancy rides `CC_HEAVY_LOCK_PID`: a runner's own child boots join only
  when that marker pid is ALIVE **and** equals the recorded holder — every
  failure mode degrades to a refusal, never to silent stacking. **Exit 3 +
  a `[heavy-lock]` stderr marker means LOCK HELD, not a test failure**
  (`driveBoot` propagates it as its own exit 3). The one uncoverable path is
  a human browser tab against a dev `serve.js` (no repo process can lock a
  human's browser — recorded exclusion, todos/done/0342). Control test:
  `tests/kernel/test_heavylock_e2e.js`.
- 🔴 **WHEN A GATE AND A BOOT BOTH WANT THE LOCK, THE GATE GOES FIRST.** The
  asymmetry is structural, not a preference: **`os/boot.js` HAS
  `--wait-lock[=SECS]`** and queues politely, while **`tests/run.js` / `kernel` /
  `sweep` have no such flag and fail fast at exit 3.** ⇒ A boot can wait behind a
  gate; **a gate can never wait behind a boot.** Never release a gating lane into
  the same window a dogfood/boot lane starts — measured live 2026-08-04, where a
  gate lost its whole `kernel` leg to a sibling's bake. **Read the lock file's
  `argv` to learn who holds it** rather than guessing; a wrong guess stands the
  wrong lane down. Writing a heavy-lock **red control**? `acquireHeavyLock`
  exports `CC_HEAVY_LOCK_PID`, so your spawned child's boots join
  **re-entrantly** as the holder's children and the control passes at exit 0 —
  strip the marker from the child env or you are testing nothing.
- **Memory-aware `jobs` (within the kernel pool):** the kernel `-j` (default
  AND explicit) is clamped to `floor(totalmem×0.6 / 4 GB)` so the pool can't
  over-commit RAM — e.g. `-j2` on a 16 GB box regardless of core count.
  `CC_NO_MEM_CAP=1` overrides.

Net: **run heavy suites one at a time.** `tests/run.js all` already does
(suites run sequentially); the guards catch the case where separate
invocations overlap.

### Gate cost + gate batching (ADOPTED rule — jku ruling 2026-08-02, ticket #415)

This section is for LANES, not just the coordinator. It records a ruling jku
has already made ("adopt the gate batching — yes"); do not re-derive it.

**Authority first.** `node tests/run.js --diff origin/main --dry-run` is the
ONLY authority on which suites a diff mandates — never this section's table,
never intuition about "how big" the change is. And an absent
`build/test-run/summary.json` means "did not finish", NEVER a green.

**1. The measured suite-cost table** (real `planFromDiff` run, 2026-08-02):

| Changed paths | Suites pulled in | Cost |
|---|---|---|
| `logs/**.md` | **none** | zero |
| `todos/*.md`, `CLAUDE.md` | `todos` only | ~6.8 s |
| `os/**.{c,h}`, `os/image.json`, `os/os-common.js` | kernel + sweep | heavy |
| `os/os.html`, `os/osk.js`, `os/compositor.js`, `os/kernel-worker.js`, `os/process-worker.js` | **sweep** only (+`host` for os.html) | one heavy suite (ticket #428) |
| `os/boot.js` | **kernel** only | one heavy suite (ticket #428) |
| `compiler.js` | **all 25 suites** | heaviest |

🔴 The two `os/` narrow rows are the ONLY per-host carve-outs, and they are
carve-outs of *blindness*, not of judgement: those six files belong to exactly
one of gucOS's two hosts and are not bake inputs, so the other suite cannot
observe an edit to them at all. **Every other path under `os/` still draws BOTH
heavy suites and that is deliberate** — see rule 5.

**2. The heavy-lock ceiling — worktrees parallelise EDITING, never the GATE.**
`tests/lib/heavy-lock.js` makes the kernel and sweep suites mutually exclusive
machine-wide and CROSS-PROCESS (`os/boot.js` joins too, since todos/0342). A
second lane hitting the lock does not queue — it **exits 3**. So the standard
worktree-per-lane dispatch convention parallelises the editing phase only:
however many worktrees exist, at most ONE heavy gate runs at a time on this
machine. Fan-out past roughly 3–4 concurrent lanes buys nothing on
kernel/sweep tickets — the extra lanes just stack up waiting to gate.

**3. The batching rule (the adopted part).** Tickets that share ONE suite
target may be dispatched as ONE lane with ONE gate. M separate lanes cost M
gates; one batched lane costs 1, and the suite mapper unions the targets
anyway. These guardrails are load-bearing:

- 🔴 **Batch only WITHIN a suite target.** Mixing targets unions them upward
  and gives back the saving.
- 🔴 **NEVER `--resume` across a batch.**

**3a. BEHAVIOUR-CHANGING tickets MAY be batched (jku ruling, 2026-08-03) —
under the non-colliding-instruments discipline below.** This rule used to read
*behaviour-neutral only*. That clause excluded roughly 50 of the 64 ready light
tickets and was the single largest brake on throughput, since the heavy lock
already caps the machine at one gate at a time. jku extended it explicitly.
**The old restriction is GONE; the attribution burden it protected is NOT.**

A batch of behaviour-changing tickets is legitimate only when ALL of these
hold. If you cannot state each one for each member, dispatch separately:

1. 🔴 **Distinct instruments.** Each member's acceptance must be adjudicated by
   a DIFFERENT observable — a different test file, a different suite total, or
   a different in-file leg count. **If two members are judged by the same
   number, they collide and MUST NOT batch**, however unrelated their code is.
2. 🔴 **Evidence pinned IN ADVANCE.** Write each member's expected
   before→after figures into the gate kickoff *before* the run starts, so a
   green cannot be rationalised afterwards. An unpinned batch is un-judgeable.
3. 🔴 **No member may change the test REGISTRY.** A registry change moves suite
   totals, and suite totals are the instrument used to adjudicate every other
   member. Those tickets still gate ALONE, and separately from each other.
4. **No overlapping file regions.** Two members editing the same function (or
   the same export object) reintroduce exactly the ambiguity this discipline
   removes. Merge them into one ticket or dispatch separately.
5. **At most ONE member may touch `os/image.json`.** Two version bumps collide
   *by making the identical edit*, which produces no conflict marker at all.
6. 🔴 **On RED, attribution is the batcher's burden, not the lane's.** Re-run
   the failing suite against each member's own branch rather than guessing, and
   **never let a lane "fix" a product bug on the batch branch.** If a red cannot
   be pinned to a single member within one re-run, SPLIT THE BATCH and re-gate.

**Precedent — batch #1 (`#141` + `#144` + `#434`), 2026-08-03**, the pilot for
this extension: three members with deliberately disjoint instruments (a kernel
in-file leg count, a host in-file leg count, and a new host file), all pinned
before the run. It went **RED**, and the red was attributed to a single member
(`#434`'s reflow, via an os-paint stale desktop probe) and fixed on its own
lane. **That is the discipline working, and it is the evidence the rule is
safe** — a batch is not required to go green to be well-formed; it is required
to be *attributable* when it does not.

Worked example of a good behaviour-neutral batch: **#309 + #307 + #365**.
Worked counter-example (proposed once, and wrong): **#111–#116 is the WORST
possible batch, not the cleanest** — all six edit `compiler.js` (⇒ all 25
suites) plus the same `tests/run.py` skip block, and #113/#116 both edit
`strftime`, so their instruments collide under 3a.1 and 3a.4. Note this is now
the *only* reason to refuse that batch: under 3a it fails on colliding
instruments, not on being behaviour-changing. **#277 / #278 / #279** (the same
change to three different demo apps) is the model behaviour-changing batch —
same suite target, three genuinely separate instruments.

**4. The general form (why the table alone is not enough).** 🔴 The unit of
contention is what the suite map pulls in TRANSITIVELY, not what the ticket's
own diff touches. Verified in source: `tests/browser/os-gcode.mjs` imports
`startServer`/`launchBrowser` from `lib/os-harness.mjs`, and both of those
call `latchHeavyLock()` → `joinHeavyLock`. So a one-file test edit that
imports `os-harness.mjs` is a HEAVY lane, however light its diff looks. **Ask
what a diff GATES, not what repo or how many lines it is.**

**5. The PRE-DEPLOY FULL SWEEP (ticket #428) — the net under every targeted
green.** A targeted `--diff` gate is a statement about ONE change set. A ship is
a statement about the whole tree. So:

- 🔴 **No gucOS image ships without a full `node tests/run.js all` on the exact
  tree being shipped — including `sweep` in full, `--filter` unset.** This holds
  even when every merge in the batch gated green on its own, and even when no
  merge in the batch selected `sweep`. It is the ONLY place the browser sweep is
  guaranteed to see the composed result of a batch.
- 🔴 **Judge it from the artifacts, never from a runner summary line — and the
  RUN-LEVEL artifact first.** `build/test-run/summary.json` is the only record
  that a *dispatcher* run finished, and it is written by atomic rename at the
  very end, so it exists only for a run that completed. Require, from the copy
  **this invocation wrote** (mtime post-dating the run's start — the merged
  record carries `elapsedMs`, not a timestamp):
  - `filter: null`, and `suites` = the full `all` set;
  - every `results[]` entry `status: "pass"` — **all of them, not just the two
    heavy ones**. A failing `unit`/`host`/Python suite is a red ship gate, and
    `pass` is demanded literally: `sweep` is an `optional` suite, so a missing
    Playwright degrades it to a **skip**, which is precisely the state a ship
    must never be judged green in.
  Only then read the per-suite artifacts, which say what the run-level record
  cannot — that each heavy suite covered its WHOLE membership:
  `build/test-kernel/summary.json` and `build/test-browser/summary.json` must
  each show `done: true`, `filter: null`, `files.recorded === files.total`, and
  zero non-`pass` per-file results.
  🔴 **The two child artifacts alone are NOT evidence** — they persist across
  invocations, so a run that was interrupted, never started, or died in an
  earlier suite can leave both of them satisfying every condition above. That is
  the same rule as the "Authority first" note at the top of this section (an
  absent `build/test-run/summary.json` means "did not finish", never a green),
  stated where a shipper is actually looking. A `--filter`ed half-sweep is not a
  pre-deploy sweep either, at either level.
- 🔴 **Never `--resume` a pre-deploy sweep**, and never let it carry results in
  from an earlier tree. `--resume` deliberately ignores carried results for
  exactly this reason; a ship gate must be one run over one tree.
- **A red pre-deploy sweep does not ship.** Bisect within the batch (the merge
  log is the bisect space) and re-run the full pair on the fix — attribution is
  the shipper's burden, the same rule as 3a.6.

This rule says WHAT must be green when a ship happens; **rule 6 below says HOW
OFTEN one happens**. They compose: the cadence decides when, this decides what
must be green when it does.

**Why this is load-bearing rather than belt-and-braces.** #428 narrowed the
`^os/` rule only where the untriggered suite is *structurally* blind, precisely
because the sweep demonstrably catches things the headless suites do not: on
2026-08-03 a Desktop-launcher change under `os/image.json` ran **kernel-green
151/151 and sweep-RED** (`os-paint.mjs`). That is the standing evidence for two
rules at once — why the wide half of `^os/` stays wide, and why a batch that
skips the sweep on its way to main still owes it before a ship.

**6. The SHIP CADENCE — MERGE ≠ SHIP (jku ruling 2026-08-03, ticket #446).**
Rule 5 is what must be green when a ship happens; this is how often one happens.
It supersedes the per-green half of the old "gucOS auto-ships on green" rule.

- 🔴 **A lane merges to main on a TARGETED green** — `node tests/run.js --diff`
  over its own change set. **The full gate is NOT required per merge**, and a
  lane must not run one "to be safe": by rule 2 the heavy lock makes every
  unnecessary full gate a stall for every other lane on the box.
- **The FULL gate runs once per SHIP**, over the whole batch, per rule 5.
- **Cadence — ship when EITHER ~8 behaviour-changing tickets have merged since
  the last ship, OR 24 h have passed with any unshipped merged work**, whichever
  comes first.
- 🔴 **"Behaviour-changing" HERE means it changes the behaviour of the SHIPPED
  ARTIFACT** — observable to a user of the deployed image (decider ruling,
  2026-08-04). **Do not borrow 3a's binary**, under which everything not
  comment/doc-only counts: 3a's exists to answer a question about *gate
  attribution*, this one to answer *when has enough user-visible delta
  accumulated to justify a deploy plus a full gate*. A test-harness or
  test-enrolment change produces zero user-visible delta, so counting it fires a
  ship that cannot deliver anything.
- 🔴 **Establish the BASELINE before counting.** "Since the last ship" is the
  last line of the deploy ledger, confirmed against the live edge (the deployed
  `build-info.json` SHA and `/os/image.json` version) — **never a handoff figure
  and never the last deploy log file**, both of which are snapshots that go
  stale on the next deploy. A stale baseline has twice produced a wrong count
  (`logs/2026-08-04/deploy-231.md`). Then count forward over the merge log.
- 🔴 **Immediate-ship exceptions — the cadence is a FLOOR on batching, never a
  delay on urgent work.** A jku direct ask, a P0 defect fix, or a fix for a live
  regression ships as soon as ITS OWN gate is green, whatever the counter says.
  Precedent: v231 shipped at 6 of ~8 with the 24 h leg still four hours out,
  because `#368` fixed a live regression that had served zero HTTP response
  headers in production for three days.
- **A red full gate does not ship.** Bisect within the batch — the merge log is
  the bisect space — and re-run on the fix; the batch does not ship until green.
  Attribution is the shipper's burden, as in rule 5 and 3a.6.

### Flake / under-load gate (`tests/flake.js`, todos/0147)

Run this **after landing any new e2e/browser test** (and as a periodic
dogfood tripwire): `node tests/flake.js` runs the historically
sleep-sensitive files (`wm_service`/`term`/`os_apps` kernel e2es +
`os-doom`/`os-term` browser sweeps) `--repeat 3` under CPU contention and
prints a per-file flake rate — a `FLAKY` verdict means a fixed-sleep/timing
dependency regressed (the class 0083/0154/0155 retired). Flags:
`--repeat N`, `--no-under-load`, `--under-load=N`, `--kernel-only` (where
Playwright is absent), `--filter=S` (intersect the tripwire set). The
mechanism is generic — any suite-runner suite takes `--repeat N`
(per-file flake rate, comma-OR `--filter=a,b`) and `--under-load[=N]`
(busy-loop generators that peg cores for the run, self-heal if orphaned),
e.g. `node tests/browser/os-sweep.mjs --repeat 5 --filter=os-doom`.

**The path→suite rule table lives in `tests/run.js` (the `RULES` array) and
is the single documented source of "what does this diff need"** — replace
the old "after touching X, run the Y sweep" lore with a rule there, don't
re-encode it as prose. `node tests/run.js --list` prints the table + the
IGNORE set (docs/todos/logs → nothing). A changed CODE path that matches no
rule is reported as **UNMAPPED** (warned, never silently skipped) — that's
the signal to add a rule. run.py categories are BATCHED into one python
process; the browser `sweep` is optional (a missing-Playwright launch
failure degrades to a skip, not a hard fail).

### Test-sync discipline — root cause over quiet symptom (todos/0171)

The estate's timing bugs share one anti-pattern: a **silent symptom**. Hold
the line on these when writing or converting tests:

- **A wait that can't be satisfied must FAIL LOUD, never nap out its
  clock.** `wmctl wait` already prints `wmctl: wait X timed out after Nms`
  to stderr and exits 1 — but a driver that ignores that just burns the full
  timeout and sails on (this is how the 0171 `AQ_GETTEXT`-can't-see-popup
  bug hid: every `wait label <popup item>` ran its whole timeout and the
  test passed anyway on a later assertion; `test_fileman_ops_e2e` was 117s
  of mostly-dead waits, now 27s). **`driveBoot` fails the test on any
  `wmctl: wait ... timed out` in the captured output** — don't defeat it,
  and never add a `wmctl wait` you expect to time out (use `nowin`/`nolabel`
  absence conditions, which SUCCEED on absence, not on the clock).
- **No fixed `sleep`/`pause` as a sync primitive.** Wait on a marker: a
  `wmctl wait` condition, a split-needle shell echo (`echo S""ENT`, wait for
  `SENT` — or the typed echo satisfies its own wait), a `waitPixel`. A
  `pause(400)` is a latent flake; the only allowed fixed sleeps are genuine
  no-marker settles (EV_SCREEN quiesce, coarse wm.c `.icons` re-read tick),
  and each must carry an annotation saying so.
- **After a typed command whose *effect* you assert later, wait for its
  completion marker before moving on** — under load a lost line is otherwise
  indistinguishable from a product hang (the whole 0171 class).
- **A server/boot that never came up must say so, not surface as a
  downstream mystery.** `waitForServer` returning false is fatal — the
  harness throws "server on :PORT never answered (stale serve.js squatting
  the port?)" instead of letting `page.goto` fail with a bare
  `ERR_CONNECTION_REFUSED`. Kill stray `serve.js`/`node -e` procs before a
  sweep.
- When a symptom is confusing, fix the DIAGNOSTIC too — make the failure
  point at its cause. Quieting a red test to green without naming the root
  cause is the bug, not the fix.

## Conformance tests (bug regression corpus)

`tests/unit/conformance/` holds one directory per fixed conformance bug:
minimal C repro + clang-verified `expected.stdout` (programs are ILP32-clean),
with `// BUG:` / `// C11:` / `// EXPECT:` header comments. `diag_*` dirs assert
a *required* diagnostic via `expected.compiler.exitcode` (no stderr golden —
the message wording is free to change). **Fix bugs test-first: add the failing
test here, commit it, then fix.** Verified-but-unfixed findings are tracked in
`todos/CONFORMANCE-REMAINING.md`.

**Pinned known bugs (xfail).** A confirmed-but-unfixed bug can be committed as a
*green* conformance test with `config.json` `"knownBug": "NNNN"` (the open
todo id). The `.c`/`expected.stdout` encode the CORRECT (clang) answer, so the
diff still runs and records expected-vs-actual — but a pinned failure reports as
`xfail` (green, not counted as a failure), so the suite is never permanently red
(the fakegit/0183 anti-pattern). When the bug is fixed the test starts passing:
that's `xpass`, a LOUD failure telling the fixer to delete the `knownBug` tag and
convert the test into a permanent regression guard. Mechanism: `applyKnownBug`
in `tests/run-unit.js` (run.py maps `xfail`→skip, `xpass`→fail). Prefer this over
`CONFORMANCE-REMAINING.md` prose when you have an executable repro.

Semantics decisions already made (don't re-litigate without cause):
- Enum constants in `(INT_MAX, UINT_MAX]` get type `unsigned int` (gcc
  extension, per the `unsigned_consteval` golden); outside 32 bits errors.
- All constant scalar conversions go through `ConstEval.convert` (C11 6.3.1,
  single implementation — PP, sema, inliner, codegen). Float→int folding
  declines out-of-range so `--trapping-float-conversions` keeps its runtime
  semantics; static-initializer emission saturates explicitly.

`tests/run-unit.js` enforces a per-test timeout (default 30s, `--timeout=MS`,
per-test `timeoutMs` in `config.json`) and replaces the killed worker, so
hang-class miscompiles fail fast instead of stalling the suite.

## Vendored projects

`vendor/` contains real-world C codebases already ported to this compiler — each has its own `bin.json`. **Check this list before proposing a "new" port; many obvious candidates are already done.** As of writing:

- **Games / engines**: `doom` (doomgeneric), `quake` (1996 software renderer), `gameboy` (Peanut-GB emulator; the lighter alternate GB core), `sameboy` (SameBoy v1.0.3 — cycle-accurate GB/GBC second core, embedded MIT boot ROMs, the baked `.gb`/`.gbc` openwith default; since todos/0260 a win32 app on the uniform menu facility — GDI-blitted client, File▸Open ROM… via comdlg32, Pause/model/palette menu; patch table in `vendor/sameboy/README.md`), `snake`
- **Interpreters / DBs**: `lua` (5.5), `micropython` (1.28), `sqlite` (3.53)
- **Presentations (0119, X→SDL ports — no Xlib shim, each fork patches its
  display layer to SDL directly)**: `sent` (suckless, ISC; drw rebuilt over
  SDL+freetype2+libpng, `.sent` decks), `magicpoint` (mgp 1.13a; the fork's
  `sdlx.c` implements mgp's Xlib vocabulary over one SDL window, tfont.c
  rewritten FT1→FT2, freetype-only text, PNG/PBM/XBM/XPM images, `.mgp`
  decks; descopes + patch table in `vendor/magicpoint/README.md`). Both
  seeded with demo decks + Demos menu entries + openwith associations;
  tests: `test_present_e2e.js` + `os-present.mjs`
- **Systems**: `tinyemu` (RISC-V 32 emulator, can boot Linux), `busybox`
  (hush as the OS's /bin/sh — NOMMU config over the vfork-on-__spawn
  journaling shim — plus 81 coreutils applets (0010, the 0034 trivial
  batch, 0035's spawn-capable batch: find/xargs/awk/tar/gzip/gunzip/
  zcat/less/diff, and 0043's procps batch over the synthetic /proc:
  ps/top/pgrep/pkill/uptime/free), including vi as /bin/vi, as one multicall
  /bin/coreutils with /bin symlinks; since 0035 the multicall links the
  vfork shim too — find -exec, xargs, awk system()/getline-pipe, tar -z
  and env-exec all really spawn; patch table in
  `vendor/busybox/README.md`)
- **Libraries**: `zlib`, `libpng`, `freetype`, `libgit2` (@44c05e5, core only; builds + `git_index_open` smoke test runs — used as a large-codebase stress test, see `vendor/libgit2/README.md`)
- **Win32 port corpus (0060)**: `winmine`, `notepad`, `calc`
  (ReactOS @1a706d7, UNICODE builds vs the os/win32 veneer; per-dir READMEs
  pin commit + patch tables — only `L"…"`→`u"…"`). Shipping is per-app and
  `os/image.json` + `packages/` are the authority, not this line (ticket
  #143 — the old "NOT seeded" claim here outlived 0048/0068): as of this
  correction **calc and notepad are BAKED** (`/usr/bin/calc`,
  `/usr/bin/notepad` + `.res` sidecars, Accessories menu entries, Desktop
  links; notepad is the `default.gui` openwith) and **winmine is the gucman
  package** `packages/winmine.json` (moved out of the bake by the 0262
  deploy-leg; absent from a minimal bake, folded in by the fat
  `--packages=all` image that tests/serve.js default to).
  `tools/win32ports.js` compile-tests all three and writes
  `os/win32/PORTS.md`, the 0059+ missing-symbol backlog (`--check` runs in
  the kernel suite). Solitaire is C++ → excluded.
- **Frontend infra (JS, not C)**: `xterm` (terminal widget), `codemirror` (editor widget)
- **Project-specific tools**: `disw` (WASM disassembler), `hello` (minimal smoke test)

## Toolchain

- **cmake**: always use the uv-managed install at `~/.local/bin/cmake`
  (`uv tool install cmake`). Do NOT use `/Applications/CMake.app` (shadows
  it on PATH) or any package-manager cmake. Invoke by full path:
  `~/.local/bin/cmake`.

## kernel.js (the process control plane) and its tests

`kernel.js` is the owner-side kernel (design: `todos/KERNEL.md`): process
table, per-process kernel-page SAB, block-RPC transport, spawn/wait/kill
routing. It is per-SYSTEM; `host.js` is per-PROCESS (loaded in every process
worker) — keep that boundary. `KernelClient.spawnHooks()` plugs into
host.js's existing `spawnHooks` seam, so host.js needs no kernel-specific
code. Signal delivery is cooperative: kernel.js posts SIGPEND bits on the
kernel page, host.js claims them at env-import safe points and calls the
wasm `__sig_dispatch` export (so pure-compute loops are uninterruptible by
design — SIGKILL still works). The tty (line discipline, termios, fg-pgroup
signal routing) is a kernel object; ptys (todos/0020) are pairs where the
SLAVE is a full Tty (line discipline reused verbatim, per-Tty read-waiter
queues) and slave→master is a pipe-shaped buffer (echo + ONLCR output;
whole-or-block writes) — termios/pgrp RPCs are fd-aware (`_ttyForFd`),
TIOCSWINSZ→SIGWINCH, master close→SIGHUP+slave EOF (writes EIO), spawn
attaches `pcb.tty` from the child's post-actions fd 0 (a slave there means
that pty's winsize SAB, control chars, SIGTTIN; first attach claims
fgPgid). With `Kernel({fs})` the kernel also owns
the fd layer — per-process fd tables → shared open file descriptions → ONE
kernel-side fs object (a BlockFS, or since todos/0026 the OS hands it a
MountFS over two volumes — the kernel treats it identically), with fs
syscalls as 0x04xx RPCs served to host.js's
RemoteFS (toWasmEnv reused over it); without opts.fs, processes get private
in-process fs (standalone pages keep that path forever — two transports,
one fs; see KERNEL.md "fd/data-plane amendment"). The sealed /usr serves
itself process-side (todos/0180): the embedder ships the system image as
ONE SAB (`Kernel({roImage})`, `BLOCK_FS.storeToSab`), every worker mounts
it locally, and RemoteFS answers absolute /usr paths with ZERO RPCs —
symlink escapes (`/usr/local`) retry brokered, write-intent/mutators/
relative paths stay brokered, local fds live at RO_FD_BASE and promote to
brokered twins at dup2/spawn-action crossings (rules + limits: the
RemoteFS header and KERNEL.md's single-writer section). Spawn caches compiled
Modules (todos/0037; generalized by #188): every binary compiles once
kernel-side and the `WebAssembly.Module` structured-clones in the spawn
message (`procSpec.module`, bytes dropped), keyed by the fs `moduleKey`
after symlink resolution — immutable prefix:ino on a read-only volume,
VALIDATED prefix:ino:size:mtime on a writable one (a rewrite, e.g.
`cc -o a.out` or a gucman upgrade, moves the key and REPLACES that
path's entry — a stale Module can never be hit); ss modules, /proc, and
no-fs kernels keep the bytes path — `kernel.moduleCacheStats()` counts.
Spawn honours `#!` (todos/0065, `_spawnShebang`): a text image starting
`#!` re-dispatches to its interpreter line (execve(2) semantics — one
optional arg, script path replaces argv[0], depth-4 chain cap →
ENOEXEC), checked BEFORE the module cache; `./foo` on a `#!/bin/sh`
script just runs.
Pipes are just
another OFD kind (PIPE_CREATE; kernel-side buffers + wait queues; blocking
read/write as deferred RPCs; EOF/EPIPE + SIGPIPE; select readiness) — and
since todos/0181 they serve themselves through an SPSC ring: RemoteFS.pipe()
posts a 256K ring SAB ahead of PIPE_CREATE (the audio-sab handshake), the
ring is the pipe's buffer in EVERY mode (kernel stream ops use the
_pipeAvail/Take/Put accessors — no demotion drain, no locks), and the
kernel-owned PR_MODE word walks LATENT → FAST (holder-removal promotion:
the hush pipeline goes fast at the parent's post-spawn closes; self-pipes
stay brokered) → DEMOTED (spawn inheritance adds a second holder — one-way).
FAST ends memcpy locally (zero data RPCs; 272→443 MB/s), block via the 0178
FS_WAIT naming the fd, and ring the PIPE_KICK doorbell only when the
kernel-raised PR_RWAIT/PR_WWAIT flag says the peer is parked; close/exit
latch PRF_RGONE/WGONE for local EOF and kicked SIGPIPE; strace pipes never
promote (kernel pseudo-holder). Rules + rationale: KERNEL.md's
single-writer section and the PR_* block in kernel.js. Job
control is cooperative like signals: STOP sets KP_FLAGS bit0 and the
process parks at its next safe point (RPC entry or sigpoll), SIGCONT
clears it; waitpid takes WUNTRACED/WCONTINUED; background brokered tty
readers get SIGTTIN (EIO if ignored/blocked). The kernel can be a native
AF_UNIX peer (`sockServe`) — first user is the WM protocol server on
/run/wm.sock (framed spec in the WMP block, MUST MATCH os/wm_proto.h),
serving /bin/wm (policy: placement, taskbar, minimize) and /bin/wmctl;
`Kernel.service()` spawns parentless auto-reaped service processes (the
wm autostart). The kernel is also the sound server (todos/0017, design in
WM.md "Audio mixing"): per-process source rings register via AUDIO_OPEN
(0x2xxx; SAB rides {type:'audio-sab'} before the RPC — the wm-sabs
handshake), `audioInit()` allocates the one page-owned f32/48k output
ring, `audioPump()` mixes (linear-interp resample, mono fan-out, sum,
clamp — pure deterministic math; the embedder schedules it, 20ms in
kernel-worker, parked while `audioStreamCount()` is 0 and re-armed by the
`onAudioStream` hook at AUDIO_OPEN — the IDLE-POWER audioPump gate).
Lifecycle: close/exit/SIGKILL mark streams dying → drain
dry → reclaim (paused/no-output drop at once — never wedge). Tests:
`node tests/kernel/run.js` — `test_kernel.js`/`test_tty.js`/`test_pipes.js`
drive the real SAB protocol against fake workers (deterministic, no
threads); the `*_e2e.js` files compile real C and run it in
`worker_threads`; `bench_fs.js` is the manual brokered-vs-inprocess
benchmark. The runner (todos/0081, engine `tests/lib/suite-runner.js`)
is parallel by default (`-j`, `--serial`, `--filter`, `--resume`,
`--fail-fast`, `--timeout`); per-file logs + an incrementally
checkpointed `summary.json` land in `build/test-kernel/`, so an
interrupted run keeps a usable partial verdict and `--resume` picks up
from it. When changing the kernel-page layout or opcodes, keep KERNEL.md's
layout comment and the tests in sync.

## os/ (the reference OS build) — gucOS

`os/` is **gucOS** (groundupcoder OS; named in todos/0114), the bootable
reference build (design: `todos/OS.md` "Reference
build"; landed via `todos/done/0004`): `os.html` (thin xterm UI bridge;
VTs per todos/0022 — the tty is VT1, the desktop VT2, exactly ONE visible
at a time via the Terminal/Desktop tab bar (Ctrl+Alt+F1/F2 as aliases),
boot streams on VT1 then a healthy `ready` auto-switches to VT2 — the
desktop is the default tab (todos/0070; a manual switch during boot wins,
boot-error/halt still force VT1), zero kernel change; browser tests must sit on VT2 for canvas pixels/
input and VT1 for shell typing — the `window.__osVtSwitch(n)` probe) →
`kernel-worker.js` (kernel.js + BlockFS-on-OPFS + compiler.js backing
/bin/cc) → `process-worker.js` per pid. One kernel per origin
(todos/0045): kernel-worker takes a Web Lock named after the OPFS image
pair BEFORE any mount and holds it for the tab's lifetime — a second
tab gets `boot-locked` → os.html's guard screen + Retry (`boot-retry`
re-enters; the lock frees when the winner closes; `__osState ===
'locked'` is the probe). `boot.js` is the headless twin — same
kernel/manifest under Node with the tty on stdio
(`echo 'ls /' | node os/boot.js`) — guarded since todos/0293 (the 0045
follow-up): a sidecar lockfile beside the writable root image
(`<root>.img.lock`, stale-stealing, released on exit/signals) makes a
second boot of the SAME pair refuse at exit 5 naming the holder pid —
the headless twin of the Web Lock. Different pairs boot concurrently
(the kernel e2es' per-boot mkdtemp images never contend). The
browser compositor is ONE WebGPU render pass per rAF in the kernel
worker (todos/0055, `os/compositor.js`: shm surfaces seq-gated
`writeTexture` into cached GPUTextures, gpu surfaces
`copyExternalImageToTexture` per ImageBitmap, chrome as white-texture
flat quads, title/'x'/Exposé-caption text as cached label textures
rasterized by the ksvc kernel text service — todos/0275: os/ksvc/ksvc.c,
FreeType+fontchain built by OUR compiler to /usr/lib/ksvc.wasm, loaded
sync in the kernel thread by os/ksvc.js over a minimal read-only env,
`Kernel({textService})`; the headless wmScreenshotScreen composite blits
the SAME blob's text via _blitLabel, so browser/headless label text is
byte-identical (WM_LABEL_PX=20, ellipsis not squish; load-fail = loud
boot-error, the Canvas2D label path is DELETED; seam doc: KERNEL.md
"ksvc service seam") — with NO Canvas2D
fallback: kernel-worker probes adapter→device BEFORE the boot lock;
failure → `boot-nogpu` → os.html guard screen (`__osState === 'nogpu'`,
no retry). Boot thus REQUIRES worker WebGPU — every browser os test
launches Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`
(flagless headless gets no adapter); headless boot.js/kernel-suite never
construct a compositor and are unaffected. The OS store is a WRITABLE root
volume at `/` + a READ-ONLY baked system blob at `/usr` (todos/0040,
design `todos/DISK-IMAGE.md`; supersedes 0026's system-at-/ split),
host.js `MountFS` on top: `/bin` is a root-volume symlink → `/usr/bin`
(merged-usr), `/usr/local` a baked symlink → `/var/local` (the admin's
writable territory; `PATH=/usr/local/bin:/bin` everywhere), /etc is
systemd-style (user overrides only; vendor defaults under `/usr/share`;
an EMPTY /etc boots; factory reset = wipe /etc+/var). The blob is a
sealed BlockFS image (superblock SHA-256, fsck_v4-checked) baked by
`tools/mkimage.js` — or on demand: boot.js re-bakes when the blob's
`/usr/share/os-release` `VERSION_ID` < `image.json version`
(`--fresh-system` forces); the browser (OPFS `os-system.v5.img` /
`os-root.v5.img` — pre-flip v4 images orphaned) first tries fetching a
prebaked `os/os-system.img` (mkimage output, gitignored), else bakes
in-worker. A NEWER blob than the manifest is kept — upgrade = swap the
blob, rollback = keep the old one; user territory is never written by
an upgrade. `image.json` is split `system`/`user`: paths map to **C
sources compiled at bake time** by the cc driver in `os-common.js` (no
build step), vendor `project` builds, `bin` blobs (repo-relative game
data), raw `text`, and `link` symlinks; the `user` section (gameboy ROMs,
Desktop links) seeds ONCE onto a freshly created root volume
(no version gate — `/etc/.image-version` is gone). Staleness (todos/
0082): every Node-side gate is version AND input-fresh — a blob at the
manifest version whose mtime is older than any bake input (compiler.js,
host.js, os/ tree, the manifest's vendor project/bin closure —
`newestBakeInput` in os-common.js) re-materializes; boot.js prefers
INSTALLING the prebaked fixture (file copy; `--fixture=`/`--no-fixture`/
`--stale-ok`), serve.js re-runs mkimage before listening, and the
kernel/browser suite runners prebake once up front
(`tests/lib/image-fixture.js`). Bakers stamp the blob's mtime with the
bake START time; mkimage publishes via atomic rename. Still bump
`image.json`'s `version` after editing seeded sources (`wm.c`, `cc.c`,
…): a PERSISTENT browser OPFS image only re-fetches on a version bump
(the in-browser gate can't stat inputs). Writes under /usr fail EROFS (host.js `readonly`
volume flag, decided AFTER the path walk so `/usr/local/...` escapes to
the rw volume). pid 1 is busybox hush (`/bin/sh`, baked from
`vendor/busybox/bin.json`); `protoshell.c` stays as `/bin/psh`; `/bin/wm`
autostarts as a kernel service (killing it falls back to kernel-chrome;
`wm &` respawns) and reads its Start menu from `/etc/menu` if that dir
exists, else `/usr/share/menu` (first-existing-dir wins). Windowed vendor apps are seeded in-OS (todos/0015):
`doom` (a gucman package and the first real `defaultPackages` member
since #420 — a fresh networked boot installs it via `sync-defaults`, the
fat image folds it under `/usr/opt/doom`; the launcher keeps the
caller's CWD and passes `-iwad`), `/bin/gameboy` (ROMs under `/root/roms` — the ROM
files are gitignored, so their entries are `optional`: missing binary
assets log a skip instead of failing the boot; bare `gameboy` runs a
built-in test ROM), `/bin/snake` (tty game; needs two paced `q`s to quit
— its exit-prompt read loop spins on EOF), `/bin/quake` (todos/0018 —
pak0.pak + autoexec.cfg at `/root/id1`; requests relative mouse at
VID_Init: SURFACE_SET_FLAGS bit1 → kernel wanted-state → os.html pointer
lock, the lock gesture being a kernel-hit-tested client click; ESC
unlocks, click re-locks; `wmctl relmove` injects rel deltas headless).
The REPLs are seeded too (todos/0036): `/bin/lua`, `micropython`,
`/bin/sqlite3` — piped use exits cleanly on EOF, interactive use works
at the hush prompt and over ptys (`tests/kernel/test_repl_pty_e2e.js`);
sqlite3 file-backed DBs exposed the brokered-fsync crash fixed in 0036
(FS_FSYNC RPC, fsync as a dispatched fs method).
MicroPython is a real script runner since todos/0117 R1 (it ships as the
`micropython` gucman PACKAGE, not an image.json entry — `micropython`
lands in `/usr/local/bin`, and since todos/0338 the name `python` is a
cmdalt CLAIM rather than a second symlink): `python foo.py a b` runs
the file with `sys.argv` set and its exit status propagated, `-c cmd`
and stdin-as-script work, `open()`/`io`/`sys.std*` are real file objects
over the kernel fd layer (`vendor/micropython/file.c`, upstream's POSIX
file object lifted OUT of MicroPython's VFS — the kernel owns mounting),
uncaught tracebacks go to **stderr**, and the heap is 32 MB (the GC
pause tracks live data at ~1.7 ms/MB, not heap size — table in
`vendor/micropython/README.md`). todos/0117 **R2** (un-parked as a decider
call — the todos/0313 M0 park condition never fired; reasoning in the
ticket) gave it a real SEARCH PATH and a curated stdlib. `sys.path` is
`[<script's dir> | "", ".frozen", /usr/local/lib/micropython,
<dir of the real binary>/lib]`: entry 0 is the SCRIPT's directory as in
CPython (so a two-file program imports its sibling from any cwd), the
writable site dir is under `/usr/local` because `/usr` is sealed
read-only, it precedes the package's own lib the way `/usr/local/bin`
precedes `/bin`, and that package lib is DERIVED by chasing argv[0]'s
trailing symlinks (micropython is a package: `/opt/micropython`
installed, `/usr/opt/micropython` on a fat bake, reached through a
`bin` symlink either way — the user32 `res_chase` trick). Built-in
modules are `math`/`cmath`/`sys`/`io`/`gc`/`micropython`/`builtins` +
`array`/`collections`/`struct`/`errno` (all four were MISSING before R2
despite being in bin.json — ROM_LEVEL_MINIMUM gated them) +
`os` (with a real `os.path` SUBMODULE — upstream's modos.c is
VFS-shaped, so `portmodos.c` supplies the POSIX bodies, the file.c
precedent) + `json`/`time`/`re`/`random`/`binascii`/`heapq`/`platform`
vendored from upstream `extmod/`, plus `sys.modules` (without the import
cache two modules importing a third get two copies of its state).
`python -m mod` runs a module as `__main__` and falls back to a
package's `__main__.py`. The epoch is 1970 and `mp_hal_ticks_*` are real
clocks (`mphal.c`) — before R2 `ticks_ms` was `return 0`. It is still a
MicroPython DIALECT, not CPython: no `datetime`/`argparse`/`subprocess`/
`hashlib`/`select`/`socket`, `localtime` IS `gmtime` (no timezone db) —
gaps + reasoning in `vendor/micropython/README.md`, register entries
L42/L43. **`vendor/micropython/genhdr/*` is GENERATED** — the
qstr pool, module table and GC root list are a function of
`mpconfigport.h`, so any config/source change wants
`node tools/mkmpgenhdr.js` (its `--check` is the
`micropython/genhdr-sync` test; this replaced the hand-maintained
headers that used to cap the config). NB a `MICROPY_PY_*_INCLUDEFILE`
port source reached through `-I.` used to have its qstrs SILENTLY
dropped by upstream's generator (the split bucket lands as a dotfile,
which the collecting glob skips); mkmpgenhdr un-dots them. Tests:
`tests/kernel/test_micropython_script_e2e.js` (R1 CLI) +
`test_micropython_stdlib_e2e.js` (R2 sys.path/stdlib, spawned through
the real `/usr/local/bin/python` symlink) + the 639-file upstream
corpus in run.py's `micropython`/`micropython-upstream` categories
(537→580 passing, 108→65 skipped at R2).
`/bin/term` (todos/0020, `os/term/`) is the wasm terminal: kernel pty +
freetype (vendored lib, font at `/etc/fonts/mono.ttf` with the baked
`/usr/share/fonts/mono.ttf` as fallback) + an escape
parser scoped to hush/vi; `term &` runs hush interactive in a window
(640x432 = 80x24), `term cmd...` runs that instead; drag-resize reflows
via TIOCSWINSZ, close = SIGHUP. Resize is gated on
`SDL_WINDOW_RESIZABLE` (todos/0021): host.js maps it to kernel
surface-flag bit2; without it `wmResize`/WMP RESIZE/`wmctl resize`
refuse (fixed-res doom/quake/gameboy can't be sheared; winbox/gpubox/
term declare it; WMP record bit4, `R` in `wmctl list`). Fixed-size
windows SCALE instead (todos/0024): a per-surface dst viewport —
`wmSetDst`/WMP SET_DST/`wmctl scale`, dst dims in the 80-byte record +
a DST list column, NN compositing in both flavors, input inverse-maps
(agent injection stays buffer-coords), frame drags rubber-band and emit
EV_SCALE_REQ answered by wm.c's aspect-fit integer-snap policy (no-WM
fallback: kernel applies the raw box); SET_DST on a resizable surface
refuses — scaled and configurable are exclusive modes. `winbox fixed`
(title "fixbox") is the fixed-size acceptance app. Maximize/restore
(todos/0025): the kernel detects a title-bar double-click (400ms + 4px
slop, event timestamps threaded from the page) and emits WMP
EV_TITLE_ACTIVATE — mechanism only; wm.c owns the maximized set + saved
geometry and dispatches on the resizable bit (work-area MOVE+RESIZE vs
centered aspect-fit SET_DST whose integer snap never overflows the work
area), re-fitting on EV_SCREEN; `wmctl max` sends WMP ACTIVATE → the
same event (R_ERR with no WM subscriber — no WM, no maximize). The screen is dynamic (todos/0023): on VT2 the desktop
canvas tracks the viewport (1 CSS px = 1 screen px, no DPR); os.html
sends `screen-resize`, the worker resizes the OffscreenCanvas +
`wmSetScreen` → WMP EV_SCREEN + a kernel one-shot position clamp (the
no-WM fallback); /bin/wm re-lays the taskbar (destroy+recreate) and
re-clamps — browser tests must derive screen-edge geometry from the
LIVE canvas rect (`window.__osScreen` probe), never 800×500 constants.
The desktop shell (todos/0028–0033, 2026-07-08): wm.c owns a Start
button + menu popup (entries from seeded `/etc/menu`; children get own
pgroup, PATH=/bin HOME=/root, cwd /root, WNOHANG-reaped) and a
fullscreen bottom-of-z desktop layer (icon grid from `/root/Desktop`,
dbl-click launches — own timestamp check, NOT e.button.clicks which
accumulates across windows; `wmctl dblclick` injects both clicks on
one connection), all in the one wm process dispatched by windowID;
menu + desktop launch through ONE `activate(path)` (todos/0066):
a file that is runnable after symlink resolution — `\0asm` or `#!`,
told by peeking the first bytes — spawns directly (launchers are
ordinary `#!/bin/sh` scripts; the old first-line-argv menu format
is gone, menu/snake became a real script); anything else opens
through the openwith associations (todos/0072, `os/openwith.h` —
ONE header-only resolver shared by wm.c, fileman and `/bin/open`):
store = `~/.config/openwith` > `/etc/openwith` >
`/usr/share/openwith` overlaid PER KEY (`os/cfgstore.h`, arch CS3 —
highest layer defining a key wins; `KEY<ws>COMMAND` lines,
KEY = lowercase extension or `default.gui`/`default.term`; path
appended as one arg; bare words resolve via /usr/local/bin:/bin),
baked seed: gb/gbc → `/bin/sameboy`, `default.gui → /bin/notepad`,
`default.term → vi`; `open --set KEY CMD` and fileman's "With"
picker ("Always" checkbox) delta-write just the changed key to
`~/.config/openwith`, so new baked defaults keep reaching; the
kernel title bar has [min][max][close] boxes (min = wmMinimize direct,
max = EV_TITLE_ACTIVATE, each box only if it fits the title — 32px
windows stay draggable); the taskbar has a right-aligned HH.MM clock,
launch-order-stable buttons (memmove compaction), and overflow shrink
left of the clock. Taskbar polish round 2 (todos/0101): right-clicking
the strip (empty run / clock / Show-Desktop region — anything past the
Start strip that isn't a drawn button) raises a taskbar-strip menu
(Cascade / Tile / Minimize All / Properties→ctlpanel) over the 0091
popup furniture; Cascade/Tile are wm.c policy loops (resizable → real
MOVE+RESIZE, fixed-size → cascaded positions, never sheared); a narrow
Show Desktop sliver at the far right (`SHOWDESK_W`, so the clock budgets
against `clock_left()`) toggles minimize-all/restore, stashing the sids
it minimized so a second click restores exactly that set; hovering or
clicking the clock raises a "datepop" date tooltip (the Aero-Peek
borderless mechanism — hover idle-dismisses, click pins); right-button
routing lands at `bar_rclick`, left-click byte-identical. Ctrl+Alt+Tab
(Alt+Tab on macOS) is intercepted at
wmKey ONLY with a WM subscribed → WMP EV_CYCLE 0x8B / CYCLE 0x19 /
`wmctl cycle` (wm.c walks LRU stamps forward, previous-window on
Shift; minimized skipped) — no subscriber, the key passes through.
Z layers (todos/0038): per-surface layer -1/0/+1 (WMP SET_LAYER 0x1A /
kernel-JS `wmSetLayer` / `wmctl layer`; record word 11, T/B chars in
`wmctl list` FLAGS), every z-order op stable-sort-normalized within
its layer — wm.c pins taskbar+menu to +1 and the desktop to -1, so
the bar is always-on-top and nothing sinks under the desktop; the
no-WM fallback never sets layers.
Map-on-placement (todos/0069): with a WM subscribed, SURFACE_CREATE
makes the surface UNMAPPED — skipped by compositor + hit test (still
listed/focusable/injectable/SHOT-able) — until the WM's first
geometry/stacking op on the sid (MOVE/RESIZE/SET_DST/SET_LAYER/
RESTACK; wm.c's EV_CREATED MOVE is the map ack, zero wm.c change), so
windows never flash at the cascade default; foreign borderless maps
at create (wm.c ignores those), subscriber-owned borderless (the
start menu) waits for its self-park; WM_MAP_TIMEOUT_MS (200ms) and
last-subscriber-gone map everything pending — no-WM boots are
byte-identical to pre-0069.
Aero effects (todos/0063, WM.md "Aero effects"): per-pixel alpha via
`SDL_WINDOW_TRANSPARENT` → kernel flag bit3 → WMP_F_ALPHA 32 (`A` in
the now-7-char `wmctl list` FLAGS; headless composite blends an exact
integer src-over, `winbox alpha` = "alphabox" acceptance app); drop
shadows (14px reach + 3px drop — browser-test TEAL samples near frames
must clear it) + radius-7 rounded frame corners as a per-quad SDF in
the one compositor pass; Aero Peek (kernel `wmThumbnail`/WMP THUMB
0x32, deterministic box filter → `wmctl thumb`; wm.c hover popup,
driven headless by `wmctl hover`); 200ms minimize/restore fly
animations (transient kernel records, browser-visual only); glass =
WMP GLASS 0x1B/`wmctl glass` backdrop-blur tier (browser-only —
headless composite/goldens never read it, off = byte-identical
pre-0063 pass).
Verified-but-unfixed items live in WM.md "Known issues"
(pointer-lock needs a per-round human check).
/proc is a synthetic kernel-rendered volume (todos/0043: `ProcFS` in
kernel.js, auto-bound by the Kernel ctor via the mount table; Linux
formats — busybox ps/top/pgrep/pkill/uptime/free are seeded coreutils
applets over it; per-process CPU time reads 0 by design; libc grew
getsid over a new GETSID RPC).
strace (todos/0046): the kernel traces any pcb whose spawn spec named a
trace pipe — `__spawn_spec.trace` is a pipe WRITE-end fd in the parent,
host-read only under spawn flags bit1 (`__SPAWN_TRACE`; bit2 = follow
descendants, lines get `[pid N]` prefixes); every RPC appends one
decoded line (the decode table IS kernel.js's OP map), the kernel holds
its own write-end ref so the tracer's EOF is exactly tracee teardown,
and a full pipe drops lines + reports the count at exit (the kernel
never blocks). `/bin/strace [-f] [-o FILE] cmd args...` (os/strace.c)
is just the plumbing: pipe, spawn pre-traced, copy to stderr, propagate
exit status (128+sig on a signaled child).
SDL frame pacing is the kernel's clock (todos/0100): nested workers get
no working rAF, so `Kernel({vsync: true})` (kernel-worker only)
advertises the compositor rAF via two kernel-page TAIL words —
`vsyncTick()` bumps+notifies every live pcb per composite,
`KernelClient.vsyncWait` parks on it with rAF catch-up semantics, and
host.js's surface backend slots that in as its `requestAnimationFrame`
(both flavors — the browser flavor since todos/0167, IDLE-POWER Stage 1).
Tab hidden = no ticks = SDL apps park (honest pause;
cooperative signals defer to the next tick, SIGKILL unaffected). No
vsync source (boot.js, standalone) → the deadline-setTimeout pacer
tier in host.js's frame-loop driver (fixed 0100: the old fixed
`setTimeout(16)`-after-callback pacer silently halved presented fps —
sameboy GBC showed 60 emulated/33 presented). Idle SDL apps can leave
the frame race entirely (todos/0161, IDLE-POWER Stage 2):
`SDL_WaitEvent`/`SDL_WaitEventTimeout` REALLY block on the OS input
ring via `__sdl_pump_wait` in 1s chunks
(import return = cooperative-signal safe point), waking on routed
input/resize/quit instead of 60×/s — mgp parks its settled slides this
way (`sdlx_wait_event`); wm.c's conversion is 0168, wake-counter probes
+ compositor parking 0169. Test: `test_waitevent_e2e.js`; design:
`todos/IDLE-POWER.md`. Multi-source sleeps are the kernel's unified
WAIT since todos/0178 (`FS_WAIT` + the `__wait` import — fds ⊕ input
ring ⊕ timeout ⊕ signal-EINTR, readiness-check+park atomic
kernel-side; KERNEL.md's two-tier wait rule is normative): wm.c parks
in WAIT{sock ⊕ ring} (pre-park select gone), user32's GetMessage in
WAIT{agent socket ⊕ ring ⊕ next timer deadline} (the 25ms chunk is
dead — idle win32 apps park indefinitely, WM_TIMER/wmctl stay prompt),
term in WAIT{pty master ⊕ ring} (frame-loop poll gone; its SIGCHLD
sets a handler flag checked in pure wasm before the park — a signal
claimed mid-frame clears SIGPEND, and dispatch only happens at import
returns, so flag-then-park is gap-free). Test: `test_wait_e2e.js`.
FS_WATCH (ticket #75) is kernel file watching as a new OFD kind:
FS_WATCH_OPEN 0x0422 returns a PATH-KEYED watch fd (one watch per fd,
close = removal) fed from the _fsRpc mutation choke — settled writes
(FSW_CLOSE_WRITE = dirty OFD's last release OR a rename landing content
at the path, so an editor's tmp+rename-over save notifies and the watch
SURVIVES — the inotify per-inode trap is absent), names on dir events,
same-dir rename as ONE two-name record, FSW_MODIFY opt-in, overflow =
clear+latch one FSW_OVERFLOW (writer never blocked). Drains via FS_READ
(packed records, EAGAIN when dry — WAIT-first), readable in
FS_SELECT/FS_WAIT like any fd; C surface os/fswatch.h (__fs_watch
import; must match kernel.js's FSW table). Consumers: mgp live-reload
(the deck watch IS wantreload's source now — upstream's ctime poll
removed; the settled park composes the fd via sdlx_wait_event_fd) and
fileman auto-refresh (todos/0123: watch_cwd re-armed per navigation
over user32's general RegisterFdWake seam — registered fds join
GetMessage's WAIT, drained raw on wake, one posted message per
episode; selection carried by NAME across the refill). Tests:
`test_fswatch_e2e.js` + `test_mgp_livereload_e2e.js` +
`test_fileman_watch_e2e.js`.
The Start menu is a single Win95 column with a gucOS sidebar band
(todos/0098's Win7 two-pane reverted to one column by todos/0132, the
22px gucOS band + bottom All-Programs its follow-up, over the 0078
Win95-classic substrate): the ROOT window ("startmenu") is a fixed 192×274
panel — a vertical gucOS branding BAND (navy→blue gradient, "gucOS" via
`draw_text_vert_s`, the 5×7 font rotated 90° reading bottom-to-top) down
the left, then ONE column of pinned entries (`~/.config/pinned`) + MRU
recents (`~/.config/recent`, pushed by the shared `activate()` on every
real launch, dedup, cap 8), a groove and the fixed places Settings (→
/bin/ctlpanel) and Run… (→ the "startrun" sh -c dialog; Shut Down waits on
0051), then — XP/Vista/7 style — the "All Programs" row pinned to the BOTTOM
row slot (`sm_disp_row` → `SM_ROWS-1`, an empty gap + groove above it),
directly above the live SEARCH box at its foot that filters a flat recursive walk of the
menu tree (Enter launches the top hit; the root holds kernel focus so
typing goes to search; fixed places suppressed in search mode). 0098's
right pane was dropped because the 0078 flyout formula (`mcol[0].x + c->w -
3`) only hangs the "All Programs" cascade snugly beside its row when the
root is one column wide — with a second pane it threw the flyout PAST it;
a bottom All-Programs cascades UPWARD via the work-area clamp (Win7). "All
Programs" cascades the baked Games/
Accessories/Demos GROUP tree as flyout columns off the column's right edge
(startmenu2 lists the groups, startmenu3 a group's leaves; `/etc/menu`
subdirs cascade the same, and the search walks /etc/menu when it wins);
flyouts keep the 0078 rules (borderless per-column windows, only the root
holds focus, hand-back at the create echo, arrows/type-ahead/Left/Esc on
the deepest column). Ctrl+Esc toggles it via WMP EV_MENU 0x8C / MENU
0x1C / `wmctl menu` — the EV_CYCLE pattern (subscriber-gated, keyup
swallowed).
Desktop icons are selectable & movable (todos/0077, wm.c-only): click/
ctrl-click/shift-range/marquee build a 64-bit selection set (navy label
strips; marquee intersects TILES, ctrl adds), drag moves the whole set
grid-snapped all-or-nothing with positions persisted in
`/root/Desktop/.icons` (`col row name`; absent entries auto-flow — a
virgin Desktop keeps the 0029 layout), arrows/Enter/Esc/Ctrl+A drive it
from the keyboard (Enter on a multi-selection is a deliberate no-op —
the multi-launch guard); a desktop left-click sends WMP_FOCUS on the
desktop sid (kernel's borderless exemption stands; policy asks) and
modifiers are tracked by KEYSYM from key events since pointer records
carry no mod word; wmctl grew keydown/keyup/down/up/drag for headless
gestures; right-button routing landed with 0091 (below).
Desktop icons rename in place (todos/0103, wm.c-only): F2 on a lone
selection — or the icon menu's Rename row — opens an inline editor over
the label (sunken white box + caret; printable insert, Backspace, Enter
commits `rename(2)` on `/root/Desktop`, Esc cancels, click-away/focus-loss
commits — the Win95 rule). Empty / `/`-bearing / EEXIST (existing target,
both kept) leave the editor open; the `.icons` cell is carried to the new
name (`desk_icons_rename`); the Recycle Bin is not renamable. A
`desk_edit_armed` flag gates the focus-loss commit so the transient
focus-fall when the icon menu dismisses can't close the editor early.
The system clipboard (todos/0090) is ONE kernel-held slot ({fmt, bytes};
fmt 1 = UTF-8 text, tagged so 0092's file lists can ride later) behind
the CLIP_SET/CLIP_GET RPCs — cross-process, survives the writer exiting
(Win95: one slot, no history). The C surface is the real SDL3 clipboard
API (`SDL_SetClipboardText`/`SDL_GetClipboardText`/`SDL_HasClipboardText`/
`SDL_ClearClipboardData` in __SDL.c over host.js `createClipboard`'s
`__clip_set`/`__clip_get` imports; usable without SDL_Init; no kernel →
a process-local slot with the same semantics). Consumers: user32's
clipboard API + EDIT WM_COPY/CUT/PASTE (^C/^X/^V/^A) ride it (the 0048
`$HOME/.clipboard` file is gone), term grew drag-selection (screen-coord
cell range, inverted render) with Ctrl+Shift+C copy / Ctrl+Shift+V paste
(\n→CR on the wire; plain ^C stays SIGINT), and `/bin/clip` (os/clip.c)
is the shell bridge — `cmd | clip` sets, `clip -o` prints (exit 1 when
empty; also the test probe). Host-browser clipboard integration is
deliberately NOT wired (SDL3.md). Tests:
`tests/kernel/test_clipboard_e2e.js` + the os-shell.mjs notepad leg.
Right-click context menus (todos/0091; on the menucore engine since
todos/0259 — "ctxmenu"/"ctxmenu2"/... chain levels to MENU_MAX_DEPTH,
the old one-flyout cap gone) built per open from fixed item lists — empty desktop (New ▸ Folder/
Text File with the Win95 uniquifier, Sort by ▸ Name = forget `.icons`,
Refresh, Display → `ctlpanel Display`; ctlpanel grew applet-by-name
argv), icon (selects-alone-unless-in-set, Open via activate(); 0092 file
ops grow here), taskbar button (Restore/Minimize/Maximize/Close over the
existing chrome ops, inapplicable rows grayed — gray rows never fire and
leave the menu open; Start strip + empty bar reserved for 0101, title
bars for 0102). Start-menu furniture rules apply (top layer, root holds
focus, focus-leave/outside-click/Esc/EV_SCREEN dismiss, arrows/Right/
Left/Enter, one popup at a time — the EV_FOCUS dismissal of the START
menu is now also gated on its root echo, or menu_toggle's ctx_dismiss
focus-fall kills the menu it just opened). user32's EDIT grew the
standard WM_CONTEXTMENU menu (Undo/Cut/Copy/Paste/Delete/Select All,
state-gated per popup; Undo always grayed — no undo buffer, 0048 scope)
over the 0068 TrackPopupMenu primitive, which grew modal keyboard nav
(Up/Down/Enter/Esc, the rest swallowed) + right-down-outside close;
popup items stay agent targets, which is how tests drive them. Tests:
`tests/kernel/test_ctxmenu_e2e.js` + `tests/browser/os-ctxmenu.mjs`
(gotchas: `wmctl list` is z-ordered — pick windows by sid; `wmctl tree`
lists menu BARS before the `popupmenu` section; browser legs must
quiesce ~1.5s after the VT2 settle or a late EV_SCREEN dismisses the
popup under test).
File manager operations (todos/0092): the ONE file-ops core is
`os/fileops.h` (header-only, the openwith.h precedent — shared by
BOTH fileman and wm.c): recursive `fo_copy` (symlinks copy AS links —
a Desktop launcher copies like a shortcut; refuses dir-into-itself),
`fo_move` (rename(2) + EXDEV copy-delete, refuses an existing dest =
EEXIST, no silent overwrite), recursive `fo_delete`, the "Copy of"/
"Copy (N) of" paste uniquifier + the "New Folder N" new-dest one, and
the CLIPBOARD FILE LIST — a format-2 payload on the ONE 0090 kernel
slot ("cut\n"/"copy\n" header + one absolute path per line; fmt 1 text
still last-write-wins across formats), so cut/copy/paste crosses
processes (fileman↔fileman↔desktop). shell32 re-exports it as the
VENEER-LOCAL `SHFile*`/`SHClip*` helpers (NOT real SHFileOperation —
no corpus consumer for the double-NUL struct). fileman.c grew the
right-click menu (Open/Open With[dir-gray]/Cut/Copy/Rename/Delete/
Properties on a row; Paste[clip-gated]/New Folder/Refresh on the pane)
over TrackPopupMenu, F2/Del/^C/^X/^V via a runtime accelerator table
(GetFocus()==listbox gated so the path EDIT keeps its text chords),
a rename dialog (the "Open with" picker pattern; Enter/Esc route from
the message loop, EEXIST keeps it open), delete confirm (MB_YESNO) +
Properties (stat facts) MessageBoxes, and EROFS surfaced as
strerror(errno). wm.c's icon menu grew Cut/Copy (the selection set),
the desktop menu grew Paste (both over fileops.h). NEW user32 surface:
`AppendMenuA`, `CreateAcceleratorTableA`+ACCEL/FVIRTKEY, `LB_ITEMFROMPOINT`,
and AQ_CLICK now prefers an ENABLED match (`agent_find_ex`) so
modal-over-modal — an error box over the rename dialog — is drivable
(a disabled same-labelled button no longer shadows the live one).
Multi-select/details = 0106, desktop-icon rename = 0103, DnD = recorded
non-goal. Tests: `tests/kernel/test_fileman_ops_e2e.js` +
`tests/browser/os-fileman.mjs`.
The Recycle Bin (todos/0093): delete is RECOVERABLE now — the trash
store is fileops.h territory (`/root/.recycle/files/` moved entries,
name clashes uniquified "x", "x 2"; `/root/.recycle/info/` one sidecar
per entry, line 1 = original absolute path, line 2 = delete time; the
split means an entry can't collide with its metadata). `fo_trash`
refuses in-store paths (delete-in-store = permanent) and sweeps the
EXDEV partial copy on failure (EROFS under /usr strands nothing);
`fo_restore` → EEXIST on an occupied target (caller prompts);
`fo_trash_forget` drops a permanently-deleted entry's sidecar;
shell32 re-exports all of it (`SHFileTrash`/`SHTrashEmpty`/...).
fileman: Del/menu Delete = confirmed trash, Shift+Del = confirmed
permanent (FSHIFT accelerator), in the store the row menu becomes
Restore/Delete/Properties + pane Empty Recycle Bin (confirmed,
empty-grayed). wm.c: the bin icon is a REAL `/root/Desktop/Recycle
Bin` launcher script recreated at every wm start (dblclick =
activate() → fileman at the store), pinned to the grid's TAIL by an
entcmp special case (other icons keep their sorted cells — test index
math survives); basket glyph flips white/navy center by store count
(coarse-tick refresh); icon menu grew DELETE (+ the Del key), both
skip the bin, cut/copy skip it too; the bin's own menu is Open/Empty
Recycle Bin. Desktop deletes and the bin-menu Empty deliberately DON'T
confirm (no dialog furniture in wm.c; fileman's flows do). Tests:
`tests/kernel/test_recycle_e2e.js` + `tests/browser/os-recycle.mjs`.
The sound scheme (todos/0094): event sounds through the 0017 mixer.
The ONE core is `os/sounds.h` (header-only — wm.c's SystemStart boot
chime and winmm's PlaySound are the same code): scheme store =
`~/.config/sounds` > `/etc/sounds` > `/usr/share/sounds/scheme`
overlaid per key (cfgstore.h; `EVENT<ws>WAV-PATH` lines;
`none` = per-event silence; reserved `mute on` = silence all), PCM
u8/s16 WAV parse, fire-and-forget playback (open stream at the clip's
spec, push whole, resume, destroy — AUDIO_CLOSE drains dry; pumpless
kernels drop silently; clips must fit the 256K source ring). winmm.c
implements the PlaySound contract over it (one current sound, alias/
file/memory names, SystemDefault fallback vs SND_NODEFAULT, SND_SYNC =
duration-capped usleep poll, NULL/SND_PURGE stop; SND_RESOURCE stays
silent success — corpus .wavs not vendored, winmine must not ding
per-second; SND_LOOP plays once); user32 grew real MessageBeep (icon
nibble → Win95 aliases: Hand/Question/Exclamation/Asterisk/Default)
and MessageBox beeps its icon at open; ctlpanel grew the Sounds applet
(enable checkbox = `snd_set_mute`, a mute-key-only delta write;
Test button). Clips are SYNTHESIZED (`tools/mksounds.js` → committed
`os/sounds/*.wav`, baked to `/usr/share/sounds/`). The 0017 pump grew
spent-tail reclaim: "dry" = can't back another output frame — at
non-integer resample ratios queued never hits 0, which leaked a dead
stream per one-shot clip. Tests: `tests/kernel/test_sounds_e2e.js` +
`tests/browser/os-sounds.mjs` + ctlpanel-e2e Sounds legs.
Aero Snap (todos/0095): drag-to-edge tiling + Win+arrow, the 0025/0032
mechanism/policy split. Kernel: the title drag tracks the POINTER
against 8px edge zones (WM_SNAP_MARGIN) and — subscriber-gated — emits
WMP EV_SNAP_EDGE 0x8D {sid, edge; 0 left-the-zone, 1 L, 2 R, 3 top,
4-7 corners} on zone change and EV_SNAP_DROP 0x8E {sid, edge, preX,
preY} at the release of every title drag that MOVED (past the 4px
WM_SNAP_SLOP — a click, jitter included, is NOT a drag: the dblclick's
first click must not drag-off-restore a maximized window; after its
EV_MOVED; preX/preY = the pre-drag position for the floating save —
scripted-WM tests with a moving title drag must consume the extra
frame); GUI+arrow rides EV_SNAP_KEY 0x8F under the
EV_CYCLE chord rules (SNAP 0x1D / `wmctl snap left|right|up|down` =
the same event; R_ERR with no WM); INJECT_SCREEN 0x22 / `wmctl
sdown|smove|sup|sdrag` injects SCREEN coords through the full
wmPointer chrome path — the ONLY headless driver for title drags
(INJECT_POINTER is post-hit-test client injection; kernel drag state
is global, so separate wmctl calls compose a held-open drag). wm.c:
per-window snapped edge + ONE saved floating rect shared with maximize
(top snap IS the 0025 maximized state; restore_floating serves the
double-click toggle, Win+Down, taskbar-menu Restore); halves split the
work area, quarters drop the bottom row one TITLE_H, fixed-size
letterboxes via the fit_dst SET_DST; the preview is a borderless
SDL_WINDOW_TRANSPARENT "snappreview" window (0x50-alpha white, top
layer, peek-style focus hand-back); drag-off restores the floating
SIZE at release (mid-drag restore = recorded simplification);
Win+Left/Right wrap across when pressed toward the held edge;
EV_SCREEN re-fits snapped like maximized. Tests:
`tests/kernel/test_snap_e2e.js` + mechanism legs in
test_wm.js/test_wm_policy.js + `tests/browser/os-snap.mjs` (NB winbox
flips its fill on the unswallowed Meta keydown — one toggle per chord).
The screensaver (todos/0096): idle-triggered Win95 classics, the same
mechanism/policy split. Kernel: `_wmLastInput` stamps at the wmKey/
wmPointer ENTRIES (all real input incl. INJECT_SCREEN; per-window
INJECT_KEY/INJECT_POINTER deliberately don't — agents can poke apps
without waking it), read via GET_IDLE 0x1E → R_IDLE 0x44 (`wmctl
idle`; own reply type so wm.c's drain can route it, the R_SHOT
precedent); SAVER 0x1F → EV_SAVER 0x90 (`wmctl saver` / ctlpanel
Preview; the EV_MENU rules). wm.c: polls GET_IDLE once a second,
config via os/saver.h (openwith-shaped cfgstore.h per-key overlay:
~/.config/screensaver > /etc/screensaver > baked /usr/share/screensaver;
keys saver none|marquee|starfield, timeout seconds, text; default
starfield/900s — 900 > the 600s test cap so no headless e2e can have
it raise mid-run; sv_set delta-writes serve the ctlpanel
Screen Saver applet's radios/Apply); past the timeout a fullscreen
borderless TOP-layer "screensaver" window raises and — the ONE
exception to the peek focus hand-back — KEEPS focus (the echo's
explicit FOCUS also raises it within the +1 band: SET_LAYER's stable
normalize would leave it UNDER the earlier-created taskbar), so every
pointer/key event lands on it and ANY of them dismisses + restores the
prior focus (the waking input re-stamped the clock by arriving);
marquee (5x7 font zoomed, random height per pass) + starfield (128
stars) repaint per frame tick; EV_SCREEN dismisses (idle re-raises);
Mystify/pipes = todos/0115. Tests: `tests/kernel/test_saver_e2e.js` +
test_wm.js legs + `tests/browser/os-saver.mjs` (VT1 typing is tty
input, NOT wm input — jiggle the mouse on VT2 to arm a fresh idle
interval).
The menu ENGINE is ONE facility (todos/0259, arch A13):
`os/win32/menucore.c` (model + geometry + tracking + freetype raster
over HDC, behind the menucore.h MenuCoreOps vtable) is consumed by BOTH
user32 (HMENU API/bar/agent front-end) and wm.c (Start-menu flyouts +
ctx menus over its own focus-holding furniture windows; the Start ROOT
panel — search/pins/band — stays wm-drawn). wm.c links
`os/win32/menucore.json` (menucore.c + gdi32.c + freetype, NO
user32/kernel32 — gdi32's W wrappers live in gdi32w.c, veneer-side);
the Start tree is the UNION of /etc/menu and /usr/share/menu (/etc wins
same-name clashes — the gucman prerequisite, ex-0244/0250).
gucman (todos/0261, Slice 1) is the package manager: optional apps live
OUT of the baked blob as `packages/<name>.json` definitions →
`tools/mkpkg.js` builds deterministic tar+gzip payloads + `index.json`
into `dist/packages/` (gitignored; served at `/packages/*` by serve.js,
built by the SAME seedEntries/buildProject pipeline as the bake — bytes
identical). **`index.json` + `pool/` are ONE repo and a build REPLACES
it** — the orphan prune deletes every payload the fresh index doesn't
name, so a base build strips the `-clang` entries AND their payload
bytes. Sequentially that's the accepted clang/base thrash; concurrently
it was a race that silently retargeted another builder's repo mid-read
(todos/0388 — it cost a 185 gate a false red). So **two builds must
never share an out dir**: `--pool=DIR` decouples the expensive
content-addressed payload STORE from the index, `<out>/pool` becomes a
HARDLINKED VIEW of just that index's payloads, and a shared store is
**append-only** (both prunes scoped to the private view; reclaim = `rm
-rf`). A `.mkpkg-lock` refuses a second concurrent build of one out dir
(loud exit 1, self-healing). The package e2es build into a per-INSTANCE
`build/test-packages/<test>-XXX/` over the one shared pool —
per-instance, NOT per-file, because `--repeat` runs a file concurrently
with itself. Guardrail: `tests/serve/test_mkpkg_isolation.js` (host
suite), which keeps a RED CONTROL that still reproduces the prune.
`/bin/gucman` (os/gucman/, curl veneer + zlib + cJSON)
install/remove/list: sha256 verified BEFORE extraction, tar members
validated (no `..`/absolute/outside-`opt/<name>/`), staged extract →
atomic rename to `/opt/<name>` → plant declarative bin (/usr/local/bin
symlinks) / openwith (/etc delta keys) / menu (/etc/menu) → DB record
`/var/lib/gucman/<name>.json` written LAST (crash-safe); remove replays
the DB in reverse. A plain mkimage bake is MINIMAL (punes absent);
`--packages=all` folds packages back in (os-release `PACKAGES=` is the
identity axis, os-common bakedPackages) — image-fixture/serve.js/boot.js
default to the FAT image so the estate needs no test changes;
`boot.js --packages=none` is the minimal-boot mode (test_gucman_e2e).
Repo URL: /etc/gucman/repos > baked /usr/share/gucman/repos
(origin-relative `/packages`). punes is the first package (Slice 1);
deploy leg + pulling the other apps are follow-ons.
Command alternatives (todos/0338, design `todos/COMMAND-ALTERNATIVES.md`) make
a command NAME switchable: `/usr/bin/cmdalt` is a MULTICALL binary whose mode
is `basename(argv[0])` — under its own name the admin CLI (`list`/`which`/
`set`/`reset`), under any other name a DISPATCHER that forwards every argument
verbatim to whatever a fourth cfgstore store names (`~/.config/cmdalt` >
`/etc/cmdalt` package claims > baked `/usr/share/cmdalt`; KEY = a command
name, VALUE = an argv prefix; a key may carry SEVERAL lines — that is the
candidate set, and the first wins, so the earliest claim stays the default).
Adding a dispatched name is ONE `link` line in image.json plus one store line,
no C. There is no exec here, so it spawns + waits + exits with the child's
status (`pv_execve`'s contract), IGNORES SIGINT/SIGQUIT (the pgroup already
delivered them; the default disposition would orphan a REPL that survives ^C),
forwards SIGTERM/SIGHUP, and refuses to dispatch to its own inode (the
fork-bomb guard). An unresolvable pick is 127 with a named fix — NEVER a silent
fallback to another candidate. `python` is the first user: `/usr/bin/python`
is a dispatch link, the baked suggestion is `cpython-clang`, and NOTHING python
is baked, so a fresh boot's `python` exits 127 with `gucman install
cpython-clang` (specified, not a bug — "default python" means once INSTALLED).
Packages provide a name through the `commands` control key (gucman APPENDS to
/etc/cmdalt, remove deletes that exact LINE; the fold splices claims ahead of
the baked body) — never through a `bin` alias, which `/usr/local/bin`-precedes-
`/bin` would make a permanent silent SHADOW; mkpkg and gucman both refuse one.
That shadow is diagnosed in four places (`which`, `list`, `set`/`reset`, and
ctlpanel's new Default Programs applet — todos/0130's picker leg) and
deliberately not auto-repaired. Tests: `test_cmdalt_e2e.js` + ctlpanel legs.
Image version: read `os/image.json` (`version`) — do not restate it here. This
line said **v140** for ~39 bumps, was refreshed to v179, and drifted again within
hours; a hand-maintained mirror of machine-readable state only ever tells you how
long since someone last looked.
The Win32 veneer (todos/WIN32.md) lives in `os/win32/` as an app-side
lib.json library: 0057 landed gdi32 — `windows.h` + `gdi32.c`, a CPU
rasterizer over the surface/bitmap RGBA buffers (DCs incl. memory DCs,
objects + stock + leak counters, all 16 ROP2s, shapes with GDI
right/bottom-exclusive and LineTo-endpoint semantics, freetype text —
MULTI-FACE since C1/#281: CreateFont resolves faceName/lfWeight/lfItalic
against the baked mono/sans/serif Noto families (Win32-shaped name
mapper + pitchAndFamily fallback, per-face /etc > /usr file pairs, real
bold/italic files preferred with fontcore embolden/shear synthesis where
none is baked, underline/strikeout as drawn rules, per-face metrics;
NULL face stays mono — no flag day until C2/#282; acceptance app
/bin/fontramp + test_multiface_font_e2e.js) —
BitBlt/StretchBlt/PatBlt, GetDIBits/SetDIBits
B<->R swizzle, IntersectClipRect). 0058 landed user32 (`user32.c`):
window classes + the HWND tree (top-level HWND ↔ SDL window/kernel
surface; child controls drawn IN-PROCESS into the top-level's surface,
Wine-style — a child DC is the surface span offset to its client
origin via the `win32_internal.h` `__gdi_dc_wrap` seam, which replaced
0057's `__gdi_bind_hwnd` scaffold), the CLASSIC blocking message loop
(GetMessage parks in the kernel's unified WAIT since todos/0178 —
agent socket ⊕ input ring ⊕ next timer deadline, drained into the SDL
queue at the import's return; WM_PAINT only when the queue is dry,
WM_QUIT last), input routing (hit-test/capture/focus; SDL3 keysyms are
modifier-applied so TranslateMessage→WM_CHAR is table-free), the
standard controls (BUTTON incl. check/radio/groupbox, STATIC, EDIT
single+multiline, LISTBOX, SCROLLBAR with Windows notify-only
semantics) and MessageBox as a real modal (own surface, owner
disabled). The agent tree records OS.md's agent-target pillar: every
user32 process serves `os/wm_agent.h`'s protocol on
/run/win32/agent.<pid>.sock from the GetMessage idle loop — `wmctl
tree` dumps every window (class/id/rect/live text), `wmctl click
"OK"` presses BY LABEL ('&' stripped; "CLASS:n" addresses text-less
controls), gettext/settext round-trip WM_GETTEXT/WM_SETTEXT — no
pixel coordinates. `/bin/gdidemo` (Petzold GDI scene + `selftest`,
now a real message-loop app) and `/bin/ctldemo` (controls +
MessageBox) are the acceptance apps; tests
`tests/kernel/test_gdi32_e2e.js` + `test_user32_e2e.js` +
`tests/browser/os-gdi.mjs` + `os-user32.mjs`. 0060 landed the port
corpus + harness: vendored ReactOS winmine/notepad/calc compile
UNICODE against the veneer (headers grew the A/W split — implemented
entries are ANSI generic names, veneer sources `#undef UNICODE`, W
variants declared with generic→W maps under UNICODE; WCHAR is 2-byte
UTF-16 via `u"…"`/TEXT-paste, NOT libc's 4-byte wchar_t; 16-bit wide
CRT = the `_tcs*` names as real symbols) — `node tools/win32ports.js`
regenerates `os/win32/PORTS.md`, the authoritative 0059+ demand log
(top of the table: W message pump, registry, LoadString/LoadImage
resources, menus, dialogs, GetSystemMetrics); `--check` is
`tests/kernel/test_win32_ports.js`. 0059 landed kernel32 over POSIX
(`kernel32.c` + `advapi32.c` + `crt16.c` in lib.json — all app-side, no
kernel change): handle table (HANDLE↔fd, magic-tagged), CreateFile→open,
FindFirstFile→opendir+wildcard, file mapping as read-copy views
(write-back on unmap), Global/Local/Heap as ONE headered malloc,
CreateProcess→the `__spawn` spec (cmdline tokenizer, PATH search,
STARTF_USESTDHANDLES→fd-actions — DUP2's `fd` is the CHILD fd, `arg` the
source), module identity via /proc/<pid>/cmdline, registry = a text hive
at `$HOME/.win32reg` (tmp+rename write-through; GetProfileIntW maps
win.ini onto it), the 16-bit wide CRT (`_tcs*`/strsafe/wsprintfW over
one wide formatter that renders numerics via narrow snprintf), and
loud-failure stubs (CreateThread/LoadLibrary →
ERROR_CALL_NOT_IMPLEMENTED — single-threaded static-link world). NB
kernel32 is W-NATIVE (no ANSI generics — the corpus is UNICODE-only;
windows.h section note is canonical). `/bin/k32demo` (UNICODE build, 87
self-checks incl. POSIX-twin identity + a redirected spawn) is the
acceptance app; `tests/kernel/test_kernel32_e2e.js` adds
registry-persistence-across-boots. 0068 landed the user32/resource
tail — **winmine is playable** (seeded as `/bin/winmine` at 0068; since
the 0262 deploy-leg it ships as the gucman `winmine` package instead —
`/usr/local/bin/winmine`, absent from a minimal bake): resources
ride a SIDECAR pack `<binary>.res` (the PE-resource-section analog)
compiled by `tools/win32rc.js` from the app's .rc (STRINGTABLE/MENU/
DIALOGEX/ACCELERATORS/BITMAP subset; the WRES format there MUST MATCH
user32.c's `res_*` loader; found via argv0 at first Load* — zero link
coupling) and committed per-port (`vendor/winmine/winmine.res`, seeded
next to the binary). user32 grew the W entry points (per-window A/W
mark; WM_SET/GETTEXT translate at the send_msg choke — NB
MAKEINTRESOURCE detection can't be `< 0x10000` here: the wasm STACK is
the low 64KB, so `is_intres` also requires the value to sit at-or-below
a fresh local's address), menus (HMENU tree; user32 draws the BAR in
the top 20px of the surface at every present, client area offset under
it; popups draw in-surface and clip; items are agent targets — `wmctl
tree` lists them, `wmctl click "Beginner"` posts the WM_COMMAND),
accelerators, DialogBoxParamW over RT_DIALOG templates ("#32770" hosts
both MessageBox and template dialogs), SetTimer/WM_TIMER (queue-dry
delivery), RedrawWindow/AdjustWindowRect (menu height only — chrome is
the kernel's), GetSystemMetrics + a synthetic monitor, and top-level
MoveWindow → the new `SDL_SetWindowSize` → kernel `SURFACE_RESIZE`
(0x1007, the one owner-initiated surface op: NOT gated on the
resizable bit — that bit protects apps from the WM, not from
themselves; reuses the 0019 renegotiation). gdi32 grew W text
wrappers; `shell32.c` (ShellAboutW) + `winmm.c` (PlaySoundW success
stub) are new veneer slices; `os/win32/wwinmain.c` is the wWinMain CRT
entry shim UNICODE GUI ports list in bin.json `sources`. Icons/cursors
are stub handles; the .ico/.wav assets are deliberately not vendored.
After 0068: notepad 27, calc 15 (comdlg32/clipboard/printing +
TrackPopupMenu/keyboard-layout). `tests/kernel/test_winmine_e2e.js` is
the acceptance test (geometry, menus, dialogs, WM_TIMER, cell-reveal
pixels, registry persistence across boots).
`/bin/gpubox` (todos/0016) is
the GPU demo — direct webgpu.h rendering: browser = per-process WebGPU
device + ImageBitmap handoff; headless = the optional Dawn tier (the
`webgpu` devDependency in the root package.json, LAZILY probed by host.js
— never hard-imported, stock Node stays tier 0; present = texture
readback→shm SAB, so `wmctl shot` works identically to CPU apps). GPU
apps must quit via SDL_Quit(), not exit()-in-frame-callback — the runtime
drains pending Dawn work before the EXIT handshake (WM.md spike-S3
caveat). Audio (todos/0017): doom/gameboy sound mixes kernel-side into
one output ring; os.html loads host.js ONLY for `createAudioReceiver`
and resumes the AudioContext on the first user gesture (autoplay
policy); `boot.js` stays silent by design (no `audioInit` — apps
self-pace against SDL_GetAudioStreamQueued, bounded memory). The tty's
`interactiveOut` opt makes fd 1/2
tty-kind (isatty true → hush goes interactive); piped runs stay
byte-clean. Tests: `tests/kernel/test_os_boot.js` +
`test_wm_service_e2e.js` + `test_os_apps_e2e.js` + `test_term_e2e.js`
(0020) + `test_gpubox_dawn_e2e.js` (headless, in the kernel suite; the
gpubox one skips without the webgpu pkg) +
`test_audio.js`/`test_audio_e2e.js` (0017) +
`test_pty.js`/`test_pty_e2e.js` (0020);
`tests/browser/os-boots.mjs` + `os-wm.mjs` (incl. the 0025
double-click maximize/restore leg on resizable winbox, the 0030
title-box legs, and the 0032 cycle-chord legs)
+ `os-doom.mjs` (now asserts the audio pipeline) + `os-gpubox.mjs`
+ `os-quake.mjs` (pointer-lock UX + the 0024 grip-scale leg)
+ `os-term.mjs` (0020) + `os-vt.mjs`
(0022; VT semantics incl. the kill-the-wm maintenance mode)
+ `os-screen.mjs` (0023; viewport-tracking screen, taskbar re-lay,
shrink re-clamp) + `os-scale.mjs` (0024; drag-to-scale, inverse-mapped
input, wmctl scale/unscale; + the 0025 fixed-size scale-to-fit
maximize leg) + `os-shell.mjs` (0028/0029/0031; Start menu, desktop
icons, clock — note: "empty desktop" pixel asserts must tolerate the
icon grid, and the desktop layer's teal equals the compositor
background teal) + `os-aero.mjs` (0063; exact src-over blend, shadow
falloff + corner clip, live Aero Peek popup, minimize-anim settle,
glass round-trip) (real Chromium, manual). The whole sweep is ONE
command since todos/0081: `node tests/browser/os-sweep.mjs`
(discovers `os-*.mjs`, serial by design — 0045 boot lock + contention;
`--filter`/`--resume`/`--fail-fast`; per-file logs + checkpointed
`summary.json` in `build/test-browser/`).

## BlockFS (host.js) and its tests

`host.js` contains **BlockFS** — a POSIX-ish filesystem backed by one byte store
(an OPFS `SyncAccessHandle` in the browser, a `MemoryByteStore` in tests). The
superblock + TLSF allocator + inode table + directories all live in the store.

**MountFS** (also host.js, todos/0026) is a mount table over N BlockFS volumes:
longest-prefix routing with prefix strip, its own fd/dir-handle namespaces,
cross-volume rename/link → `EXDEV`, mount points → `EBUSY`. Symlinks resolve in
the FULL namespace: MountFS wires `_mountPrefix`/`_mountOwns` hooks into each
volume; `_walkHops` resolves targets through them (in-volume → strip and keep
walking; foreign → throw `__mountEscape` with the full-namespace continuation,
which MountFS's dispatch loop catches, rewrites, and retries — parent-dir walks
are always a path prefix of their argument, so the rewrite is unambiguous).
Every BlockFS path op walks all components via `_walkPath` BEFORE mutating, so
an escape aborts with no partial state — keep that ordering when adding ops.
Each volume stays an independently fsck-able image; only the kernel embedders
(`Kernel({fs: mountfs})`) use MountFS — process-side RemoteFS and standalone
single-volume paths are untouched. Tests: `tests/blockfs/test_mounts.js` (walk
mechanics + fsck), `tests/kernel/test_mounts.js` (routing/EXDEV/EBUSY/escape
semantics + the 0040 readonly-/usr layout).

**Read-only volumes + sealed blobs** (host.js, todos/0040):
`createV4(store, {readonly: true})` mounts an EXISTING v4 image read-only —
every mutating op returns `EROFS` via `_setErr`, decided AFTER the path walk
(so a path escaping through a symlink to a writable volume retries on its
owner — that ordering is load-bearing for `/usr/local` → `/var/local`);
the store is wrapped in `ReadOnlyStore` as a throw-on-write backstop, and an
unformatted store throws instead of formatting. `sealVolume`/`verifySeal`
(async, WebCrypto): superblock flags bit 1 + SHA-256 of everything after the
superblock at offset 36 — `fsck_v4.js` re-checks it independently. Tests:
`tests/blockfs/test_readonly.js`.

**Invariant: the store is the single source of truth.** Any metadata that's
persisted in the superblock (inode-table extent/capacity, `nextInodeId`, pool
end, free lists) MUST be read THROUGH the store on each access, never cached on
the JS instance. Caching breaks coherence when **two live BlockFS instances run
over one store** (e.g. an embedder's concurrent headless runner + the workspace
owner): a stale cache hands out a used inode id or reads inodes at a relocated
offset → silent cross-file corruption. (This was a real bug — fixed by making
`InodeTable` extent/cap and `_nextInode` read-through.)

**Test suite** (`tests/blockfs/`, run `node tests/blockfs/run.js [--long]`):
- `test_tlsf.js`, `test_blockfs.js`, `test_e2e.js` — example-based unit/e2e.
- `test_posix.js` — POSIX semantics: unlink/rename-while-open lifetime (inodes
  carry an in-memory, per-instance open-refcount; freeing defers to last
  close), same-inode rename no-op, failed-rename rollback, hole zero-fill,
  TLSF v3 huge-size arithmetic, symlink nlink symmetry, pipe-end refcounts
  across dup/dup2/F_DUPFD. Note: the open-refcount is per-instance only —
  cross-instance unlink-while-open still frees early (documented limitation).
- `fsck.js` — an INDEPENDENT consistency checker (shares no code with host.js;
  re-declares the on-disk format with a version guard; reads the store raw). It
  walks the block map, free lists, inodes/extents, and the directory tree and
  cross-checks every invariant (no overlapping/double-claimed extents, no leaked
  used blocks, free-list ↔ physical-free agreement, dirents → live inodes, file
  `nlink` == dirent refcount, reachability). Detection only (no repair).
- `test_fsck.js` — proves fsck catches hand-crafted corruption (and clean images pass).
- `test_fuzz.js` — model-based differential fuzzer: random valid ops against
  BlockFS vs an in-memory reference model; after EVERY op it asserts a fresh
  instance matches the model, runs `fsck`, and (dual mode) checks two live
  instances over one store stay coherent. Deterministic per seed; prints the
  seed+op on failure. This combo catches the multi-instance-coherence class that
  the read-through invariant protects — verified to fail on the pre-fix host.js.

When adding/changing on-disk format or metadata, update `fsck.js`'s constants
(it guards on superblock VERSION) and make sure new persisted state is
read-through, or the fuzzer's dual mode will (correctly) flag it.
