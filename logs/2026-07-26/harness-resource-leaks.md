# Two harness resource leaks that fabricated false test signal

Queue items 7 (abandoned `$TMPDIR/os-*` fixture dirs) and 6 (orphaned
`serve.js` listeners). One bug family, fixed together: **a test run that dies
abruptly leaves its resources behind, and what it leaves behind then produces
failures that look like product regressions.**

Both were moved ahead of feature work for that reason, not for tidiness. The
receipts:

- cont-64 found **779 abandoned `os-*` dirs / 49 GB** and a 100%-full disk.
  ENOSPC does not surface here as ENOSPC — it surfaces as test *timeouts* and
  scattered failures. Somebody debugs the product for a day.
- **70 `serve.js` processes with PPID 1** squatting the sweep's fixed ports in
  one round. The next run's tests then poll those ports and talk to a *stale*
  server.
- **409 MB of `os/os-system.img.tmp-*`** in-tree, dating back to Jul 17.

## Why nobody noticed for months

The in-tree half is the instructive one. `.gitignore:13` matches
`os/os-system.img.tmp-*`, so 409 MB of abandoned 111 MB bake temps were
**invisible to `git status`**. Nothing was hiding them deliberately; nothing was
showing them either. The `$TMPDIR` half had the same property — nobody `ls`es
`/var/folders`.

So the fix is not only "delete the garbage". Every leaked resource this harness
can find is now **printed** at the start of every heavy run, whether or not it
gets reaped. If this regresses, the next person sees a number climbing instead
of discovering 49 GB after the disk fills.

## Confirmed mechanisms

**Leak 1 — fixture dirs.** `tests/kernel/lib/drive.js` `freshImage()` mkdtemp'd
`os-e2e-XXXXXX` and documented the leak as policy: *"the caller owns cleanup;
most e2es leak the tmpdir like they always did and let the OS sweep /tmp"*.
macOS does not sweep `/var/folders` on any useful horizon, and single fixtures
measure 144–197 MB. ~60 kernel e2e files mint one each per run.

**Leak 2 — orphaned listeners.** `tests/lib/suite-runner.js` spawns each test
file `detached: true`. That is *correct* and load-bearing: the file becomes its
own process-group leader, so the per-file timeout can `kill(-pid)` the group and
take the test's `serve.js` + Chromium with it. But detaching also puts the child
**outside the runner's group**, so when the runner is killed *from outside* —
the 600s call-ceiling SIGKILL — nothing reaches the children, and the runner's
own SIGINT/SIGTERM handler never runs either.

Reproduced exactly, on unmodified `origin/main`:

```
PID   PPID  PGID  COMMAND
80942    1  80942  node /tmp/leak-fake/os-leakprobe.mjs … hang 3914
80951 80942  80942  node …/serve.js … 3914          <- still LISTENING
```

The test file is PPID 1 (reparented to init) and PGID 80942 — *its own group*,
not the dead runner's. That is the whole bug in three columns.

The amplifier is `serve.js` `tryListen()`: on `EADDRINUSE` it walks to `port+1`.
So the squatter keeps the port the test polls, the real server quietly moves
aside, and the test talks to the stale one. Measured: asked 3901, bound 3902.
Worse than it looks — sweep ports are reused (3197 belongs to four files) and
3198 is itself another file's port, so the +1 walk lands on a live assignment.

## The fix, mapped to the three deaths

A signal handler alone cannot be the answer: SIGKILL runs none, by definition.
So: prevent where prevention can work, and sweep retroactively for the rest.

| | clean exit | per-file timeout | runner killed from outside |
|---|---|---|---|
| fixture dir | `harness-temp.js` exit hook | graceful group kill → same hook; else reaper | `parent-watch.js` → same hook |
| `serve.js` | test teardown + serve watchdog | existing group kill | `parent-watch.js` group kill; serve watchdog |
| pre-fix / escaped | — | `harness-leaks.js` startup reaper | `harness-leaks.js` startup reaper |

- **`tests/lib/harness-temp.js`** — `mkdtempOwned()` tags each dir with its
  owner's pid (`os-e2e-<pid>-XXXXXX`) and registers it for exit/SIGINT/SIGTERM
  cleanup. The pid tag is the load-bearing part: it lets the reaper distinguish
  *abandoned* from *in use right now* without guessing.
- **`tests/lib/parent-watch.js`** — a `node -r` preload injected into every
  spawned test file. Polls `process.ppid`; when the runner vanishes, cleans its
  fixtures and SIGKILLs its own process group. A **poll, not a handler**,
  because the event it must notice delivers no signal. Preload rather than a
  wrapper process: no extra pid, no stdio rewiring, no exit-code laundering.
  Same idiom the `--under-load` generators already used.
- **`serve.js`** — the same ppid watchdog, so a listener can never outlive its
  owner however the owner died; plus **`--strict-port`** (passed by
  `os-harness.mjs`), which refuses the silent walk and names the squatting pid.
  It carries a bounded 3s same-port retry because sweep files *share* ports and
  the previous file's socket may still be closing — a graceful teardown clears
  in well under a second, a real squatter never does.
- **`tests/lib/suite-runner.js`** — group kills are now SIGTERM → 400ms →
  SIGKILL, so a responsive child cleans up *at death* instead of leaving work
  for the next run's reaper. `timedOut` is latched before the kill, so the
  window cannot relabel a timeout as an ordinary signalled failure.
- **`tests/lib/harness-leaks.js`** — the startup pre-flight, called by both
  heavy runners *after* `acquireHeavyLock`. Reaps abandoned dirs, orphaned
  `serve.js`/test files/Chromium, and dead-pid `os/*.img.tmp-*`; reports
  everything; refuses to start below 3 GB free with an explicit note that a full
  disk presents as timeouts, not as ENOSPC.

## Safety of the reaper (the part worth getting right)

Reaping is never "looks old". It is **"the owner is provably dead"**:

- temp dirs → owner pid parsed from the name, `kill(pid, 0)` (+ a 6h fallback
  for pid reuse; a 2h age cutoff only for pre-fix untagged dirs);
- processes → **PPID 1 only**, i.e. the OS has already declared them
  parentless.

So a hand-run `node tests/kernel/test_wm.js`, which takes **no heavy lock**, is
untouchable: living pid, living parent. And the pre-flight runs *after* the
lock, so a lane that lost the lock exits 3 and never reaches the reaper — no
other heavy suite can be mid-flight while it runs. Verified live: fail-fast
still exits 3 with no pre-flight output before it, and `--list` still bypasses
both.

Deliberately **repo-agnostic**: sweep ports are fixed constants shared by every
worktree, so another worktree's orphan squats our port just as effectively as
our own. An orphan is unowned by construction.

### The self-match trap

First cut matched `serve.js` as a bare substring — and immediately flagged *its
own shell*, whose command line contained `node -c serve.js`. `pgrep -f serve.js`
has exactly this flaw. Every pattern now anchors on argv0 being a node binary
(and Chromium on its executable name). Pinned in
`tests/host/test_harness_leaks.js` with a `zsh -c … pgrep -f serve.js` row —
killing an operator's shell would have been a spectacular own goal for a fix
whose entire purpose is not producing false signal.

## Verification

Every death mode was made to **fail first** on pristine `origin/main` (a
detached worktree) and then pass on the branch, using the real `suite-runner` /
`drive.js` / `serve.js` code paths driven by a stand-in test file (no OS boot,
no Chromium — so no heavy lock and no RAM cost):

| death mode | origin/main | branch |
|---|---|---|
| clean exit | 0 dirs, 0 listeners | 0, 0 |
| per-file timeout | **1 dir**, 0 listeners | 0, 0 |
| runner SIGTERM | **1 dir**, 0 listeners | 0, 0 |
| runner SIGKILL | **1 dir, 1 listener** (PPID 1) | 0, 0 |

`serve.js` in isolation, before → after: survived its parent's SIGKILL and kept
listening → exits within the watchdog window; asked 3901 and silently bound
3902 → `--strict-port` exits 1 naming the holder pid.

## Not done, on purpose

`tools/mkimage.js` was left alone. Its `.img.tmp-<pid>` files are collected by
the reaper (dead-pid rule) and listed loudly; adding an exit hook there would
cover only the error path that a reaper already covers, and this was scoped as a
test/harness change. No `os/` product code was touched and `os/image.json` was
not bumped.
