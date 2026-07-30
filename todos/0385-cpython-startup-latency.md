# 0385 — cpython-clang startup latency (~2s for python --version on iPhone)

- **Status**: investigated 2026-07-28 — root cause measured, fix path measured
  (~10× on desktop Safari), options reported to jku by email. Nothing landed in
  the product; the fixes below need a decider/coordinator call (option A is a
  kernel cache-invalidation design, option B changes the standing gucman
  launcher convention).
- **Design**: `logs/2026-07-28/0385-cpython-startup.md` (method, drivers, raw numbers)
- NB: this lane's branch is named `0379-cpython-startup` — the kickoff
  hand-wrote a ticket id that was already taken (0379 is the dup-dirent repair
  ticket). The branch name keeps the stale id by master's ruling; the ticket
  and log carry the real id, 0385. Measurements predate the todos/0374 rename,
  so raw driver output says `python-clang`; the package is `cpython-clang` now.

## The observation

On jku's iPhone, `python --version` (the cpython-clang package via the cmdalt
dispatcher) takes ~2 s. The existing bench
(`tools/bench2x2/results/startup-cpython-clang.txt`, ~96 ms) is whole-process
wall under **Node/V8 on bare host.js** — no OS, no spawn chain, no browser —
so it never measured the user path at all. Reproduced on desktop **Safari**
(same engine family as the iPhone): 645 ms for `python --version`, 1139 ms for
`python -c pass`, against 190/409 ms on desktop Chromium and 260/~150 ms
headless Node. iPhone ≈ 2–4× desktop-Safari CPU ⇒ the ~2 s observation is the
Safari number, not a mystery.

## Root cause (two multiplied factors, both measured)

1. **`python --version` is SEVEN process spawns.** strace -f in-OS:
   hush → cmdalt dispatcher → `/bin/sh` launcher → `$(dirname …)` subshell →
   `$(realpath …)` subshell → realpath → dirname → the python wasm. Four of
   the seven exist only so the launcher can locate its own directory
   (the gucman `$0`-readlink launcher pattern).
2. **On JSC (Safari), a spawn of a NON-shared wasm module costs ~150–230 ms;
   a shared warm one ~20–25 ms** (Chromium: ~25 ms either way). JSC hangs its
   wasm JIT code off the `WebAssembly.Module` object. The kernel module cache
   (todos/0037) shares one Module across spawns — but **only for binaries on a
   read-only volume** (`immutableKey`). A gucman-installed binary lives under
   `/opt` on the rw root volume → bytes path → a fresh Module per spawn →
   every run-once init instruction executes in JSC's interpreter tier, every
   invocation. The python binary is 7.6 MB with a large C init, and
   `-c`/script runs add the Python runtime init + imports at the same cold
   tier.

Ruled out by measurement (each priced): wasm compile itself (7.6 MB = 10–30 ms
in JSC, ~7 ms V8), Worker creation (2 ms; nested workers 2 ms), fs-RPC storm
(`--version` performs **3** RPCs; `-c pass` 180 — the import bootstrap is
frozen into the binary), pyc cache (works as designed; only 4 .pyc exist to
write; cold ≈ warm), OPFS reads, initial memory (10.3 MB), launcher's own
script parse. `--version` exits inside `config_parse_cmdline` before path
config, so it never touches the stdlib — its 2 s were almost pure spawn
mechanics.

## Measured fix endpoints (desktop Safari, minimal image + gucman install)

| user path | baseline | + module cache for /opt (kernel experiment) | + spawn-free launcher too |
|---|---|---|---|
| `python --version` | 645 ms | 151 ms | **68 ms** (warm p50) |
| `python -c pass` | 1139 ms | 209 ms | **109 ms** (warm p50) |

(High rep-to-rep variance is real: JSC re-colds modules under memory churn;
first-run-in-session stays cold-compile+init. All raw runs in the log.)

## Options (as emailed)

- **A — module cache for rw-volume binaries** (the big lever, 4–10×): a
  validated cache key for mutable files (ino + size + mtime read through the
  store), one entry per path, replaced on key change. Hazard to pin with a
  test: the `cc -o a.out && ./a.out` recompile loop must never hit a stale
  Module. Kernel.js `_imageCacheKey`/`_moduleFor` + a host.js key hook.
- **B — spawn-free launcher** (removes 4 of 7 spawns): known-prefix probe
  (`/opt/<name>` else `/usr/opt/<name>`) or install-time prefix substitution,
  replacing the `$(dirname "$(realpath "$0")")` convention. Applies to every
  gucman launcher (micropython too). Sequence with awareness that 0374's
  rename has landed (the package is `cpython-clang`).
- **C — smaller/later**: prewarm the module at install/boot (kills the
  first-run cold spike), in-process cmdalt dispatch, freezing more stdlib.

## Floor

After A+B a session's **first** python run still pays one cold compile+init
(~1–2 s iPhone-scale, once); warm runs ≈ 0.3–0.6 s estimated on-device.
Direct iPhone verification is pending — needs a deployable test build
(coordinator owns image sequencing).

## Acceptance

Ruled 2026-07-30. Options **A** and **B** are filed as their own tickets and do the work; this parent
closes on the on-device record.

- `todos/0443` (**A** — module cache for rw-volume binaries) is merged.
- `todos/0444` (**B** — spawn-free gucman launcher) is merged.
- A **deployable test build** is measured **on jku's iPhone**.
- Warm `python --version` and `python -c pass` are **recorded in the log**, expected **0.3–0.6 s**.
- Close this ticket on that record.

⚠️ **The iPhone measurement is a jku-only action.** No lane can claim it, and this ticket must **not**
be closed on a desktop-Safari number. Ask the user; a coordinator owns the image sequencing.

⚠️ After A+B, a session's **first** python run still pays one cold compile+init (~1–2 s at iPhone
scale, once). That is the known floor recorded above, **not** a regression.

## Option C — PARKED, NOT CUT

Prewarm the module at install/boot, in-process cmdalt dispatch, freeze more stdlib. This is a genuine
cost trade — boot time and memory against a once-per-session spike — whose value is **unmeasured
on-device**, so it is parked rather than dropped.

**Reopen trigger:** on-device warm runs exceed ~0.6 s, **or** the once-per-session cold spike proves a
real annoyance to jku.

⚠️ Note the stale line under "Options (as emailed)": B's *"applies to every gucman launcher
(micropython too)"* is **vacuous** — `packages/micropython.json` ships **no launcher** and already
exhibits the 3-process shape B is chasing. `todos/0444` records the correction and replaces that arm.
