# Handoff — start of thread (updated 2026-07-12; 0084 unified test entry landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0084 (unified test entry point + diff-aware selection) is DONE and
committed.** There is now ONE command over the whole test estate that also
knows which suites a given diff needs.

- **New: `node tests/run.js`** — a thin `spawnSync` dispatcher over the
  existing runners (`tests/run-unit.js`, `tests/run.py` categories,
  `tests/host/run.js`, `tests/blockfs/run.js`, `tests/kernel/run.js`,
  `tests/browser/os-sweep.mjs`); they all stay independently invocable.
  - `node tests/run.js all` — whole estate, one exit code + a merged
    `build/test-run/summary.json`.
  - `node tests/run.js unit kernel` — named suites (`--list` enumerates).
  - `node tests/run.js --diff [ref]` — map touched paths → suites, run
    exactly those (default: working set vs HEAD; pass a ref to diff against
    it). `--dry-run` prints the plan, runs nothing.
  - Passthrough: `--filter=STR` (all), `-j N`/`--resume`/`--fail-fast`
    (suites whose runner accepts them — a per-suite `supports` set).
- **The path→suite rule table lives in `tests/run.js` (the `RULES` array)**
  and is the SINGLE documented source of "what does this diff need."
  UNION semantics (every matching rule contributes); a first IGNORE tier
  drops docs/todos/logs; a changed CODE path matching no rule is warned as
  UNMAPPED, never silently skipped. `node tests/run.js --list` prints the
  table. CLAUDE.md's new "Running tests" section + README's Tests section
  point HERE instead of carrying the old "after touching X run Y" prose.
- run.py categories batch into ONE python process; the browser `sweep` is
  `optional` (a can't-launch degrades to a skip, not a fail).

## Tests / verification

Each dispatch path exercised against the REAL runners (not mocked):

- **Acceptance**: `compiler.js` diff → **unit+kernel+blockfs**; `os/wm.c`
  diff → **kernel+sweep**; `all --dry-run` == the full ordered estate. ✓
- Real runs through the dispatcher: `unit` (filtered), `host`, `blockfs`
  (artifact link surfaced), `kernel` (filtered to test_kernel.js), a batched
  `ast,disw` py run — all aggregate exit codes + write the merged summary.
- `--diff HEAD~1` resolved the last commit's paths correctly (docs ignored).
- **The full `all` was NOT run** (multi-hour: kernel bake + libc + fuzz +
  every vendor project). The dispatcher is a thin orchestrator; every
  dispatch path was proven individually against known-green suites.

Dev log: `logs/2026-07-12/0084-test-entrypoint.md`. Item at
`todos/done/0084-test-entrypoint.md`.

## Gotchas carried forward (trimmed to the live ones)

- **The `os/wm.c` acceptance touch restaled `os/os-system.img`** — this
  session rebaked the prebaked fixture (96s) so warm e2e boots stay ~1-2s.
  Any edit to a seeded `os/*.c/.h/.rc` or `compiler.js`/`host.js`/`vendor/`
  restales it; the suite runners rebake once up front. Bump `image.json`
  `version` on a seeded-source edit or a persistent browser OPFS image won't
  re-fetch. (Image version is currently **v64** per CLAUDE.md;
  `image.json` version was last bumped to 73.)
- **`queue.js done` stages a PRE-EDIT blob** of the done file — after `done`,
  `git add todos/done/<file>` again (done this session; verified the staged
  blob carries the DONE Status line).
- **Concurrent sessions exist: stage ONLY your own files**, re-check HEAD
  before committing.
- **Playwright is not installed here.** The kernel/blockfs/unit/host suites
  and `node --check` run fine; the browser `sweep` needs a separate install.
  Via `tests/run.js` the sweep is `optional` — a can't-launch is a skip.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. Head is now **0154**
(agent-tree waits — `wmctl wait label/text` + the win32-app e2e cluster),
then **0155** (the hard-tail kernel/term/emulator sleeps), **0147** (test
flake gate), **0079/0080**, **0052/0053**, **0064**. No open P0s.

Two natural follow-ons to 0084 already in the queue: **0147** (test flake
gate) and **0148** (test-tightness sweep) can now build on the unified entry.

## Operator-owed (browser, Playwright required)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check).
- **0152** — a `--clang` browser boot confirming the served overlay renders.
- **0153** — run `os-sweep.mjs` to validate the 0146/0083 harness conversions.

Launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan` (0055 —
boot REQUIRES worker WebGPU). `node tests/run.js sweep` (or
`node tests/browser/os-sweep.mjs`) runs the whole sweep serially.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0155's recorded decisions (see todos/done/). **0084's
call: `tests/run.js` is a THIN dispatcher — the individual runners stay the
canonical entry points; the rule table (UNION, IGNORE-first, warn-on-unmapped)
is the single documented source of diff→suite mapping.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0084 unified test entry +
diff-aware selection just landed; `node tests/run.js --diff` runs what a diff
needs, rule table in tests/run.js; head is now 0154/0155 for the 0083 sleep
residue; no open P0s)."
