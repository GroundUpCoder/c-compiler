# 0379 — cpython-clang startup latency (~2 s for `python --version` on iPhone)

- **Status**: investigated 2026-07-28 — root cause measured, fix path measured
  (~10× on desktop Safari), options reported to jku by email. Nothing landed in
  the product; the fixes below need a decider/coordinator call (option A is a
  kernel cache-invalidation design, option B collides with the todos/0374
  rename in flight).
- **Log**: `logs/2026-07-28/0379-cpython-startup.md` (method, drivers, raw numbers)

## The observation

On jku's iPhone, `python --version` (the python-clang package via the cmdalt
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
   `$(realpath …)` subshell → realpath → dirname → python-clang.wasm. Four of
   the seven exist only so the launcher can locate its own directory
   (the gucman `$0`-readlink launcher pattern).
2. **On JSC (Safari), a spawn of a NON-shared wasm module costs ~150–230 ms;
   a shared warm one ~20–25 ms** (Chromium: ~25 ms either way). JSC hangs its
   wasm JIT code off the `WebAssembly.Module` object. The kernel module cache
   (todos/0037) shares one Module across spawns — but **only for binaries on a
   read-only volume** (`immutableKey`). A gucman-installed binary lives under
   `/opt` on the rw root volume → bytes path → a fresh Module per spawn →
   every run-once init instruction executes in JSC's interpreter tier, every
   invocation. python-clang.wasm is 7.6 MB with a large C init, and `-c`/script
   runs add the Python runtime init + imports at the same cold tier.

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
  gucman launcher (micropython too). Collides with todos/0374's rename —
  sequence after it.
- **C — smaller/later**: prewarm the module at install/boot (kills the
  first-run cold spike), in-process cmdalt dispatch, freezing more stdlib.

## Floor

After A+B a session's **first** python run still pays one cold compile+init
(~1–2 s iPhone-scale, once); warm runs ≈ 0.3–0.6 s estimated on-device.
Direct iPhone verification is pending — needs a deployable test build
(coordinator owns image sequencing).
