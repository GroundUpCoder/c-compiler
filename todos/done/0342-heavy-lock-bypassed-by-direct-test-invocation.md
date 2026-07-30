# 0342 — the heavy-suite RAM lock is bypassed by the invocation every test file documents

- **Status**: done
- **Reported by**: the 0330 lane (clang-simplified libc re-vendor), 2026-07-28
- **Evidence**: first-hand — hit while trying to run `todos/0330`'s own named
  acceptance leg against a live kernel suite

## The mechanism

`tests/lib/heavy-lock.js` is acquired in exactly **two** places, both *suite
runners*:

```
tests/kernel/run.js:179       acquireHeavyLock({ name: 'kernel suite' })
tests/browser/os-sweep.mjs:44 acquireHeavyLock({ name: 'browser os sweep' })
```

**No individual test file takes it.** But an individual kernel e2e boots the
same full-OS process trees the lock exists to serialise — `os/boot.js` nodes at
~4 GB each — and every one of them documents being run on its own:

| count | fact |
|---|---|
| 121 | `tests/kernel/test_*.js` files |
| 119 | that document a direct `node tests/kernel/<file>` line in their own header |
| 66 | that boot a full OS (`require('./lib/drive.js')`) |
| **66** | **that do both** — i.e. every full-OS e2e tells you to run it lock-free |

`todos/0330` §Plan step 3 says `node tests/kernel/test_clang_pkgs_e2e.js`;
that file's own header says `Run: node tests/kernel/test_clang_pkgs_e2e.js`.
Both are the documented, correct-looking invocation, and both take no lock.

## Why this matters — it is the exact scenario the policy was written for

`CLAUDE.md` §"Heavy-suite RAM policy" exists because on **2026-07-25** two heavy
runners at once OOM'd a 16 GB box into a jetsam death spiral → launchservicesd
lock convoy → WindowServer watchdog kill. The stated guard is *"kernel + sweep
take an exclusive lock and fail fast (exit 3) if another heavy runner owns it."*

That guarantee holds only for the two runner entry points. Concretely, on
2026-07-28 the kernel suite was running (`pid 58291`, `argv:
["/Users/jku/git/c-compiler/tests/kernel/run.js"]`) while this lane needed
`test_clang_pkgs_e2e.js` — six full-OS install+launch legs. Running it would
have stacked the trees with **no exit 3 and no warning**; the lane only avoided
it by reading the lock file by hand. There is nothing generalisable about
"remember to check the lock manually before every single-file run."

Note the failure mode is strictly worse than the one already guarded: a lane
that hits the guard gets a clean, self-explaining `exit 3`. A lane that
bypasses it gets an OOM that kills the GUI, and the symptom points nowhere near
the cause.

## Goal

Make the guarantee a property of *booting a full OS*, not of *which entry point
you happened to type*.

## Acceptance

- **The lock moves to (or is additionally taken at) the choke point every heavy
  test already funnels through** — `tests/kernel/lib/drive.js`'s boot path — so
  a single-file run is protected without touching 66 files. `run.js`
  acquiring it first must remain correct: its own children must not deadlock
  against it (re-entrancy via an inherited env marker, or an equivalent —
  whichever, the nested case must be demonstrated, not assumed).
  - **[Seam ruled by the 2026-07-30 design pass, under this bullet's own
    escape clause.]** The choke point does not exist: five kernel e2e files
    and one bench tool spawn `os/boot.js` themselves, past `drive.js`. The
    lock joins in `os/boot.js` startup. `drive.js` gets only the exit-3
    propagation. See `## Design`.
- **A positive control in the same log:** with the lock held by a stand-in
  holder, `node tests/kernel/<some full-OS e2e>.js` **exits 3** and names the
  holder. A guard whose failure path was never exercised is not a guard
  (the todos/0341 rule).
- **No behaviour change on the happy path**: `node tests/kernel/run.js` and a
  lone single-file run both still work, with numbers shown for each.
- `CC_NO_HEAVY_LOCK=1` keeps working as the documented isolated-host escape and
  is named in the failure message.
- If the choke point turns out to be the wrong seam, say so and put the lock
  wherever the full-OS boot actually is — the acceptance is "no full-OS boot
  runs unlocked", not "edit drive.js".
- **(Added by the 2026-07-30 design pass — folded in from todos/0303.)** A bare
  `node os/boot.js`, started while another holder owns the lock, exits 3 and
  names the holder. `--wait-lock[=SECS]` is the explicit opt-in wait for an
  interactive reproduce.
- **(Added by the 2026-07-30 design pass.)** A hand-run single
  `tests/browser/os-*.mjs` file joins the lock through
  `tests/browser/lib/os-harness.mjs`. Under a foreign holder it exits 3 before
  it starts a Chromium. Under the sweep runner it joins re-entrantly. The
  human-browser-tab path through a dev `serve.js` stays out of reach and is
  recorded as an exclusion in `## Design`.

## Design (2026-07-30 design pass — the single spec for this item and todos/0303)

### The seam: guard the boot, not a caller list

The lock exists to bound RAM. A full-OS boot spends the RAM. So the guard
must run where the boot process starts. A list of callers is not a seam:
the list rots (the 0303 lesson F).

Two process shapes boot a full OS today. Each shape has one seam.

**Shape 1 — a `node os/boot.js` process.** Eight entry paths reach it.
Source of the survey: `grep -rn 'boot\.js'` over the tree, keep the call
sites that put `os/boot.js` into an argv. Re-run the grep to re-derive the
list; do not trust the table as prose.

| # | entry path | via drive.js? |
|---|---|---|
| 1 | `tests/kernel/lib/drive.js` `driveBoot()` — the funnel for the driveBoot e2es | yes |
| 2 | `tests/kernel/test_os_boot.js` — own `spawnSync`, the bake path | no |
| 3 | `tests/kernel/test_os_apps_e2e.js` — own async spawn | no |
| 4 | `tests/kernel/test_vi_e2e.js` — own paced-tty spawn | no |
| 5 | `tests/kernel/test_jobctl_tty_e2e.js` — own paced-tty spawn | no |
| 6 | `tests/kernel/test_curl_e2e.js` — own async spawn (a sync spawn would deadlock its fake server) | no |
| 7 | `tools/bench2x2/inos-startup.js` — `execFileSync` | no |
| 8 | a shell: `node os/boot.js` — documented in boot.js's own header | no |

`drive.js` covers 1 of 8 paths. That is why the choke-point bullet loses.
The only seam downstream of all eight is `os/boot.js` startup. The guard
joins there, after argument parsing and before any store, bake, or mount
work. (When todos/0357 adds the tree guard to boot.js, the tree guard runs
first — refuse before you take the machine-wide lock, the 0341 order.)

**Shape 2 — an os.html boot in a Chromium.** The funnel is
`tests/browser/lib/os-harness.mjs`. All 42 `os-*.mjs` sweep files import it
(`grep -L os-harness tests/browser/os-*.mjs` returns nothing), and so do
`tools/os-drive.mjs`, `tools/idlemeter.mjs`, and `tools/peek-repro.mjs`.
A hand-run single file starts a Chromium with no lock today — the sweep's
own header says so. The guard joins in os-harness, latched once, at the
first of `startServer`/`launchBrowser` (os-harness already requires the
CJS `drive.js`; `heavy-lock.js` rides the same interop). One path stays
uncovered: a human browser tab against a dev `serve.js`. No repo process
can lock a human's browser. The 0045 Web Lock guards image coherence
there, not RAM. This is a recorded exclusion, not silent scope loss.

No single seam covers both shapes. The minimum set is two seams:
`os/boot.js` startup and `os-harness.mjs`. The two runner acquisitions
stay: a runner still fails fast before it spawns any work, and it now also
sets the re-entrancy marker.

### Re-entrancy: a verified holder-pid marker

`acquireHeavyLock()` sets `process.env.CC_HEAVY_LOCK_PID` to its own pid
on success. Children inherit it: suite-runner spreads `process.env`
(`tests/lib/suite-runner.js:370`), and `driveBoot`, the direct-spawn e2es,
and the bench tool pass no `env`, so Node inherits by default.

A new `joinHeavyLock({name, waitMs})` in `heavy-lock.js` runs at both
seams:

1. `CC_NO_HEAVY_LOCK=1` → no-op. The escape stays first.
2. The marker is set, the marker pid is alive, and the lock file's holder
   pid equals the marker → re-entrant join. Return without ownership.
   No release duty.
3. Otherwise → `acquireHeavyLock` semantics: own the lock, or exit 3 and
   name the live holder.

Rule 2 is why the kernel suite cannot deadlock against itself: ownership
stays with the runner for the runner's lifetime, so any number of
concurrent child boots join without a count and without an unlock duty.
The marker alone is not trusted. It must match the lock file's holder and
be alive. An orphaned child of a killed runner carries a dead marker,
fails the liveness check, and falls through to a loud acquire. A spawn
site that builds `env` from scratch severs the marker; that boot exits 3
loudly. Every failure mode of the mechanism degrades to a refusal, never
to silent stacking.

The nested case is demonstrated, not assumed: control leg 3 below boots
with the marker aimed at a live stand-in holder and requires exit 0. The
kernel suite's own fan-out is the same shape at scale and must stay green.

### Policy: one rule — fail fast; wait only on request

Every non-re-entrant contender, at every seam, exits 3, names the holder,
and names `CC_NO_HEAVY_LOCK=1`. This resolves the 0303/0342 policy
contradiction in favour of this item, for three reasons:

- The runtime cannot tell a human reproduce from an agent one-liner. Both
  arrive with piped stdin (`echo 'ls /' | node os/boot.js`). An isTTY
  split would misclassify the majority caller. A split the code cannot
  implement is not a policy, so it is not designed.
- A default silent wait turns a refusal into an invisible stall inside a
  bounded tool call. The estate's sync discipline (todos/0171) is: fail
  loud, never nap out a clock.
- One exit-3 semantics estate-wide keeps one contract for drive.js, the
  runners, and readers.

The interactive case gets an explicit flag, not a default:
`node os/boot.js --wait-lock[=SECS]` polls the lock, prints the holder and
the elapsed time every 30 s (a loud wait), acquires when the lock frees,
and exits 3 at the deadline. A bare `--wait-lock` has no deadline.

Test caveat: init can exit 3 legitimately (`sh -c 'exit 3'`). A lock
assertion must match exit 3 AND the `[heavy-lock]` stderr marker.

### drive.js: diagnostic propagation only

`driveBoot` checks the child result. Status 3 plus `[heavy-lock]` on
stderr → print the child's stderr and `process.exit(3)`. So
`node tests/kernel/<file>` exits 3 and names the holder — this item's
acceptance leg — with zero per-file edits. The five direct-spawn e2es fail
loudly with the boot's refusal in their own captured stderr; that is
accepted and recorded here, not silently different.

### The positive control: `tests/kernel/test_heavylock_e2e.js`

The control redirects the lock scope per-child through `TMPDIR`:
`os.tmpdir()` honors it on darwin and linux, so the test needs no code
seam and never touches the real host lock. The stand-in holder is the
test's own pid — alive by construction, no second 4 GB boot.

| leg | setup (all under a private TMPDIR) | expect |
|---|---|---|
| 1 | no lock file | boot runs an echo, exit 0 |
| 2 | lock file held by the test's pid; marker stripped from env | exit 3 fast; stderr names the holder and `CC_NO_HEAVY_LOCK=1`; no image work happened |
| 3 | same lock file, plus `CC_HEAVY_LOCK_PID=<test pid>` | re-entrant join: exit 0 — the nested proof |
| 4 | lock file held by a dead pid (a finished `spawnSync` child) | stale steal: exit 0 |
| 5 | foreign-held lock; a `node -e` script calls `driveBoot` | that process exits 3 and names the holder |
| 6 | foreign-held lock, plus `CC_NO_HEAVY_LOCK=1` | exit 0 — the escape works |
| 7 | foreign-held lock; spawn `node tests/browser/os-minimal.mjs` | exit 3 before any serve.js or playwright import |

Leg 2 is the RED this item's acceptance demands; legs 1/3/4/6 are the
GREEN. Leg 7 needs no playwright: the join runs before the lazy import.
The file registers in `tests/kernel/run.js`'s explicit list and lands in
the kernel suite.

### Out of scope, and why

- In-process kernel e2es (fake workers; worker_threads C runs) build no
  full OS image. Their RAM is one test process; the pool cap governs them.
- `tools/mkimage.js` bakes, it does not boot. A bake is one node process.
- todos/0293 is adjacent, not this: the per-image-pair coherence flock.
  Same insertion point in boot.js, different lock, different failure mode.
  It stays its own ticket.
- The light-suite line in heavy-lock.js is ruled **permission** — the
  ruling and its reasons live in todos/0303 `## Design`.

### Implementation plan

| file | change |
|---|---|
| `tests/lib/heavy-lock.js` | set the marker in `acquireHeavyLock`; add `joinHeavyLock({name, waitMs})`; allow a caller hint line in the refusal text |
| `os/boot.js` | parse `--wait-lock[=SECS]`; call `joinHeavyLock` after arg parsing, before any store/bake/mount work |
| `tests/kernel/lib/drive.js` | propagate a child's heavy-lock refusal as exit 3 |
| `tests/browser/lib/os-harness.mjs` | `joinHeavyLock` latch at the first of `startServer`/`launchBrowser` |
| `tests/kernel/run.js` | register `test_heavylock_e2e.js` |
| `tests/kernel/test_heavylock_e2e.js` | new — the seven control legs |
| `CLAUDE.md` §heavy-suite policy, heavy-lock.js header | state the new coverage: every full-OS boot joins the lock |
| `todos/LIABILITIES.md` | retire or re-anchor L65 in the same landing commit |

Difficulty: light-to-medium. Medium only for the os-harness latch
placement. One lane, one commit.

Suite routing of that diff, derived from `node tests/run.js --list`:
`os/boot.js` → kernel, sweep; `tests/lib/` → unit, blockfs, kernel, sweep,
host; `tests/kernel/` → kernel; `tests/browser/` → sweep; `CLAUDE.md`
(L12), `tests/kernel/lib/drive.js` (L06), and `tests/lib/heavy-lock.js`
(L65) are LIABILITIES-cited → todos. Union: **unit, host, blockfs, kernel,
sweep, todos**. The two heavy suites run one at a time, as always.

### Subsumption ruling

This item subsumes todos/0303. After this design, 0303 holds no work this
item does not do: the bare-boot guard is the same code as the single-file
guard (the seam is the boot), the register entry exists (L65, added by the
design pass), the light-suite question is ruled in 0303's body, and 0303's
block-and-wait default is overruled above. Precedent: 0373 subsumed 0363.
Coordinator: at the merge of the design pass, close 0303 as
subsumed-by-0342 (`node todos/queue.js done 0303` — its body is
annotated); implement and close this item alone.

## Implementation note (2026-07-30 lane)

The implementation follows the design table. Two recorded deltas:

- **Control leg 7 uses `os-boots.mjs`, not `os-minimal.mjs`.** The design
  named os-minimal as the vehicle. But os-minimal runs a real
  `tools/mkpkg.js` build BEFORE it reaches the harness. A refusal control
  must not start a package build: the build mutates `dist/packages`, and
  the `.mkpkg-lock` makes it racy under `--repeat`. The first action of
  os-boots is `startServer`, so the leg asserts the refusal came before
  serve.js through the silent `[serve]` tap. The seam and the assertion
  are the ones the design specifies.
- **Legs 8 and 9 were added for `--wait-lock`.** The design's acceptance
  names the flag but its control table did not exercise it. Leg 8 proves
  the deadline refusal (exit 3, loud status line, "deadline reached").
  Leg 9 proves the acquire after the holder frees. A helper process frees
  the lock, because the test blocks in `spawnSync`.

The entry-path survey was re-derived at implementation time: 7 argv call
sites + the shell = 8 paths, `drive.js` covers 1 (matches the table above).
Kernel suite file count: 135 → 136 (`test_heavylock_e2e.js`, 24 checks).
L65 is retired from `todos/LIABILITIES.md` in the landing commit — the gap
it recorded is closed by this item.

## Priority rationale

P1. Nothing is currently broken *by* it — it is a missing guard, not a
regression, so it is not P0 under the priority policy. But the hazard is live
every time two lanes overlap, the estate runs concurrent lanes as a matter of
course, and the realised cost last time was a killed GUI. Cheap and one-shot,
like `todos/0341`, whose class it shares: *the documented, natural invocation
silently escapes a protection everyone believes is in force.*
