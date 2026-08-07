# #483 — pin the py gate leg to a hermetic interpreter (never a $PATH python3)

Lane: lane-483, base 030f56d2 (origin/main).

## The bug

`tests/run.js:787` spawned `python3` by `$PATH` lookup — `/usr/bin/python3`,
system Python **3.9.6** on this machine (captured before the fix). That one
invocation backs all 19 `py[…]` categories, i.e. the gate's largest leg, and
since #534 it sits on the gate path of every libc-extension change. The
interpreter was an ambient property of whoever's shell launched the runner;
an interpreter fault presented as a tree fault. It also violated the standing
machine-wide never-system-Python rule.

## Scope: THREE sites, not one

The ticket named one site. An exhaustive sweep (`grep -rn python3` outside
vendor/node_modules) found the hermeticity had to flow to two more:

1. `tests/run.js:787` — the py batch (the ticket's site; its cited `:722` had
   drifted to `:787`, as the kickoff said).
2. `tools/mkmpgenhdr.js:159` — the qstr generator spawns `python3` for
   upstream's `makeqstrdefs.py`; its `--check` runs inside the `micropython`
   category, so it is ON the gate path.
3. `tests/run.py:1146` — the micropython-upstream CPython baseline ran
   `["python3", "-"]`: **570 of 639** upstream tests have no `.exp` file and
   compute expected output from whatever CPython `$PATH` serves. Fixed to
   `sys.executable`, so the pin flows to children. (`:1339` already used
   `sys.executable`; the `build.py` scripts' `#!/usr/bin/env python3` shebangs
   are hand-run affordances only — run.py launches them via `sys.executable`.)

The in-OS `python` (cmdalt/micropython/cpython-clang) and
`tools/bench2x2/inos-startup.js` are a different axis (gucOS binaries), untouched.

## The design

**`tools/host-python.js`** is the ONE resolver; both Node consumers require it
(`tests/run.js`'s new `pythonPreflight` — the `browserPreflight` twin, same
exit-2-before-any-suite shape — and `mkmpgenhdr`). Resolution order, never
`$PATH`:

1. **`$PYTHON`** — explicit caller override, used verbatim, existence-checked.
   ⚠️ **This `process.env.PYTHON` read is the DESIGNED override from the
   ticket's own scope line ("an env override (e.g. PY=/PYTHON=)"), not a gate
   bypass**: it cannot weaken a gate (a dead override REFUSES rather than
   falling through — host-tested), and it is the deliberate
   test-another-interpreter mechanism, the `$CC` override precedent from
   mkmpgenhdr itself. One name only (`PYTHON`, not also `PY`) — one word, one
   meaning.
2. **`<tree>/.venv`** — the uv venv, pinned by the **committed
   `.python-version`** (`3.12`; uv venv reads it natively). The pin is loose on
   patch on purpose: uv rolls patches, and the axis that bit was
   system-3.9-vs-modern, i.e. major.minor. Drift and broken-interpreter states
   REFUSE naming `uv venv --clear` — a present `.venv` claims the slot and is
   never routed around (no zombie fallbacks).
3. **`<main clone>/.venv`** — worktree read-through via `mainTreeOf` (the #559
   gitdir-pointer parse, imported from playwright-pin.cjs rather than
   duplicated).
4. **Refusal** — `{ ok:false, message }` naming the exact `uv venv` command at
   the right tree. Pure decision, callers own the exit (exit 2, the #559 code).

### Rebuttals of the kickoff's leans (both accepted-in-spirit, amended in letter)

- **Module home: NOT `tests/lib/python.js`.** RULES row 377 maps `^tests/lib/`
  to `['unit','blockfs','kernel','sweep','host']` — UNION semantics would put
  **two heavy suites** on every future edit of a resolver no heavy suite
  consumes. `tools/host-python.js` gets a precise row instead (`tools/` rows
  are all file-specific; no catch-all contamination), and mkmpgenhdr reaches it
  as a sibling require.
- **Worktrees: read-through, NOT a third symlink.** The kickoff itself named
  the trap: a gitignored venv that every fresh worktree lacks recreates the
  #559 outage shape, mitigated only by per-worktree manual setup ×N lanes.
  Because this resolver IS the resolution (unlike playwright, where Node's own
  resolver defines what loads and read-through would lie), a worktree can
  resolve the main clone's venv directly — **one `uv venv` in the main clone
  serves every worktree forever; zero per-worktree steps**. A worktree's own
  `.venv` still outranks it (explicit beats implicit), and `$PYTHON` outranks
  both. Direction A's pre-flight + Direction B's override are both in, as the
  kickoff suggested ("not exclusive").

### Decision 2 — the suite mapping

- New rows: `^tools/host-python\.js$` and `^\.python-version$` →
  **`['host','disw']`**. `host` runs the fixture-tree refusal tests
  (`tests/host/test_python_resolve.js`, registered in the guarded member list);
  `disw` is the cheapest real run.py category (~1s, 7 tests, and per
  test_diff_rules.js one that doesn't even execute wasm under host.js) and
  proves an actual interpreter launches and runs run.py under the pin.
- `^tests/run\.js$` **stays `['host']`**, and here is the argument the kickoff
  asked for: after extraction, run.js no longer *chooses* an interpreter — the
  choosing moved to host-python.js (which carries its own py row), and the
  remaining glue (`pythonPreflight`) is exported and host-tested directly, the
  exact `browserPreflight` precedent. The residual uncovered sliver is the
  literal `runProcess(pyPre.python, …)` argv line, which is the same class as
  run.js's argv assembly for kernel/sweep/unit (none of which run under a
  run.js-only edit either) and cannot fail *silently green* — it fails loud red
  on the next py-selecting gate. The fake-green shape the coordinator feared —
  a python-choosing line gated by a suite that never starts a python — is
  dissolved by the refactor, not gated around.

## Measurements

- **CPython-baseline sensitivity: measured ZERO on the current corpus.**
  `micropython-upstream` full category, same tree: **574 passed / 0 failed /
  65 skipped under system 3.9.6 AND under the pinned 3.12.13**. (CLAUDE.md's
  "580 passing" figure predates corpus drift; the live A/B is the evidence.)
  So the 3.9→3.12 baseline flip changes no verdict today — but with 570/639
  tests baseline-computed, the `sys.executable` fix is what keeps that from
  ever becoming an ambient-shell property again.
- `uv venv` in the worktree: reads the committed pin, creates CPython 3.12.13,
  `pyvenv.cfg` carries `version_info = 3.12.13` (the resolver reads
  `version(_info)? =`, covering stdlib venv too).
- The dispatcher banner now prints the resolved path
  (`$ /…/.venv/bin/python tests/run.py --types=…`), so every gate log carries
  interpreter provenance.

## Deliberate-breakage evidence (per the mapping standard of proof; each run
on the committed tree, then reverted — logs under gitignored `build/`)

- **Break A** (`build/breakage-A.log`) — the cargo-cult fix: resolver
  sabotaged to *silently return `/usr/bin/python3`* instead of the final
  refusal. `test_python_resolve.js` → **3 FAILED** (both no-venv refusal legs
  + the `pythonPreflight` glue leg), exit 1. The host instrument catches the
  semantic fallthrough, not just a parse break.
- **Break B** (`build/breakage-B.log`, `build/breakage-B2.log`) — resolver
  sabotaged to return `/usr/bin/false` (exists, executable, not a python):
  `node tests/run.js disw` → **`py[disw]` FAIL, rc=1** (the disw row really
  launches the resolved interpreter end-to-end), and
  `node tools/mkmpgenhdr.js --check` → **rc=1** naming the failed command.
- Reverts verified: zero sabotage lines remained; both instruments re-ran green.

## Merge prerequisite (for @master)

`~/git/c-compiler` has no `.venv` yet. **After merge, run `uv venv` once in
the main clone.** Until then, any main-tree gate selecting a py suite refuses
at exit 2 with that exact command in the message (self-diagnosing, not a red);
a host-only run would fail `test_python_resolve.js`'s integration leg with the
same message. Existing worktrees need nothing — read-through covers them.
lane-483's worktree carries its own `.venv` (created for this gate).
