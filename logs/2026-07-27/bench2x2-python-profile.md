# bench2x2 — the (our compiler | clang) x (CPython | MicroPython) profile benchmark

Gates a real decision: **does CPython become the primary Python for gucOS?**

Harness + raw samples: `tools/bench2x2/` (artifacts stay out of git, pinned by
sha256 in that README). Every number below is rendered by
`tools/bench2x2/mktable.js` straight from `results/*.txt` — nothing is retyped
from a terminal, because a transcription slip and a fabricated measurement look
identical once they are in a markdown table.

## The headline, up front

**Our compiler's CPython executes Python bytecode ~1000x slower than the clang
build of the identical sources.** Not 10%, not 5x. This is not general codegen
quality — the same compiler is within 1.03x of clang on a tight arithmetic loop.
It is specific to the interpreter dispatch path, and it is filed as `todos/0332`.

Until 0332 is understood, **CPython cannot be the primary Python**: the startup
number alone (2.54 s vs clang's 96 ms) disqualifies it, and that startup gap is
itself the same pathology.

## What was measured, and against what

| cell | artifact | bytes |
|---|---|---|
| CPython x ours | `python-ours-v176.wasm` | 7,006,275 |
| CPython x clang | `python-clang-verify.wasm` | 4,523,831 |
| MicroPython x ours, 256 KB heap | `mp-ours-256k.wasm` | 555,745 |
| MicroPython x ours, 32 MB heap | `mp-ours-32m.wasm` | 555,748 |

**Comparability** (the standing rule after the retracted `-g`-vs-non-`-g` size
claim): both CPython builds come from the *same* 174 TUs, the *same* generated
`pyconfig.h`, the *same* defines, the *same* libc and the *same* host ABI —
`cc-build.sh` and `ccjs-build.sh` differ only in which compiler they invoke, and
neither passes an explicit `-O`. Each toolchain is at its own default. The A/B is
therefore comparable, and the compiler is the only variable.

`Py_DEBUG`, `WITH_PYMALLOC` and `USE_COMPUTED_GOTOS` are all `#undef` in that
shared `pyconfig.h` — so both builds are non-debug, both use raw `malloc`, and
both dispatch through the plain `switch`, not computed gotos. None of those is an
asymmetry between the two sides.

**The (clang x MicroPython) cell does not exist.** The 2x2 is three cells wide,
not four. `cc2wasm` cannot compile any TU including `<setjmp.h>`, and
MicroPython's NLR is setjmp-based. Absent by measurement, not by omission.

**The CPython artifact's build caveat is exactly one line:** stock v176
`compiler.js` plus a single one-line `todos/0332`-unrelated `todos/0323`
diagnostic relaxation at the link step. v176 compiles all 174 CPython TUs as
shipped; 0323 is the only remaining blocker and is **still open**. The resulting
binary is byte-identical (sha `bd83ef09…`, 7,006,275 B) to the `python-clang`
lane's three-patch build, which proves the relaxation has no codegen consequence
— 0323 is a const-qualifier *diagnostic*, no ABI effect.

## 1. STARTUP — whole process, **Node host**, `-c pass`

These are **Node numbers, not in-OS numbers.** See §5 for in-OS.

| cell | n | p50 | min..max |
|---|---|---|---|
| CPython x ours | 15 | **2542 ms** | 2494 ms .. 2985 ms |
| CPython x clang | 15 | **96.15 ms** | 94.83 ms .. 97.77 ms |
| MicroPython x ours (256 KB heap) | 15 | **32.03 ms** | 31.43 ms .. 34.31 ms |
| MicroPython x ours (32 MB heap) | 15 | **32.38 ms** | 31.37 ms .. 33.47 ms |

CPython x ours is **26.4x** its clang twin, and **78x** MicroPython.

### Where the ~2.3 s actually goes

- **Not module load.** V8 compiles the 7 MB module in **3.8 ms** p50 (clang's
  4.5 MB: 2.2 ms; MicroPython: 0.4 ms). That is 0.15% of 2.54 s. Ruled out.
- **Not the two heap sizes.** 256 KB and 32 MB start within noise of each other.
- **`-S -I` moves neither build** (clang 0.09→0.09 s, ours 2.53→2.51 s), so this
  probe did **not** isolate how much of startup is bytecode. Reported as
  inconclusive rather than rounded into the story it would have flattered.

What is established: startup is *execution*, not load, and it is 26x the clang
build on identical inputs. Given the same binaries show a 1000–4400x penalty on
bytecode dispatch (§2) while raw C is 1–7x (§6), a startup dominated by CPython's
frozen-importlib bootstrap bytecode is **consistent with** 0332 — but the direct
probe failed, so that attribution is stated as consistent-with, not established.

## 2. THROUGHPUT — steady state, ns per loop iteration (SCALE=20000, n=5)

| cell | arith | alloc | call |
|---|---|---|---|
| CPython x ours | 143.0 us | 134.5 us | 175.0 us |
| CPython x clang | 144.5 ns | 136.6 ns | 110.7 ns |
| MicroPython x ours (256 KB heap) | 2.6 us | 2.6 us | 2.6 us |
| MicroPython x ours (32 MB heap) | 2.6 us | 2.6 us | 2.6 us |

### The suspected defect: tested, and REFUTED

The hypothesis was that `bench_throughput.py` timed a whole process invocation
(including interpreter startup), because each cell's throughput figure sits near
that same cell's startup plus a small delta. **It does not.** The script brackets
`WORK(SCALE)` with two in-process clock reads, and — more to the point — an
**external wall-clock arbiter**, which is immune to any in-guest clock bug,
confirms all three cells independently:

| cell | guest-reported | external slope (Δwall / Δiterations) | agree |
|---|---|---|---|
| MicroPython 32m | 2.58 us/iter | (0.57−0.30)s / 102k = **2.65 us** | ✓ |
| CPython clang | 0.1445 us/iter | (0.22−0.09)s / 1.02M = **0.127 us** | ✓ |
| CPython ours | 143.0 us/iter | (15.93−2.54)s / 102k = **131 us** | ✓ |

Throughput was **re-measured in-process and cross-checked externally** — not
recovered by subtracting startup, which would not have been a measurement.

The near-coincidence that prompted the hypothesis is real but accidental: the
workload happens to cost roughly what startup costs in both cells, because *both*
are paying the same per-bytecode penalty.

### Two honest limitations of this axis

- **The three MicroPython kinds are indistinguishable** (2.6 us across arith,
  alloc and call, within 0.2%). Three different workloads cannot truly cost the
  same. The `for i in range(n)` loop overhead dominates every body, so on
  MicroPython this axis **does not resolve** arith vs alloc vs call. It is one
  number about loop dispatch, reported three times. Do not read the columns as a
  workload breakdown for those rows.
- The naive cross-engine reading — "MicroPython is 55x faster at arithmetic than
  CPython" — is **not** an interpreter-quality result. It is CPython x *ours*
  carrying 0332. Against CPython x *clang*, MicroPython is ~18x **slower**
  (2.6 us vs 144.5 ns).

## 3. GC — as a distribution (p99 and max, never a mean)

### 3a. Collector in default automatic mode (600 frames)

| cell | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| CPython x ours | 600 | 25.60 ms | 26.47 ms | **27.91 ms** | **28.77 ms** |
| CPython x clang | 600 | 39.1 us | 42.9 us | **64.8 us** | **152.3 us** |
| MicroPython x ours (256 KB heap) | 600 | 659.7 us | 686.1 us | **735.1 us** | **857.3 us** |
| MicroPython x ours (32 MB heap) | 600 | 656.9 us | 682.8 us | **744.5 us** | **851.3 us** |

### 3b. Cyclic collector DISABLED — CPython: refcounting only

| cell | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| CPython x ours | 600 | 24.51 ms | 26.96 ms | **32.40 ms** | **33.58 ms** |
| CPython x clang | 600 | 39.5 us | 43.8 us | **66.7 us** | **150.3 us** |
| MicroPython x ours (256 KB heap) | — | **NOT RUN** — `MemoryError`, see §4 | — | — | — |
| MicroPython x ours (32 MB heap) | 600 | 674.6 us | 690.9 us | **734.9 us** | **847.7 us** |

**Refcounting vs the stop-the-world collector.** `auto` and `nogc` are
statistically indistinguishable in *both* CPython builds (clang p99 64.8 vs
66.7 us; max 152.3 vs 150.3 us). On this workload the generational cycle
collector contributes **essentially nothing**; the per-frame cost is refcounting
plus allocation.

That conclusion carries a limitation that must travel with it:
`bench_frames.py`'s garbage is **acyclic** (`[i, [i, i], None]`), so the cycle
collector has little to collect. The correct claim is "**on acyclic garbage** the
cycle collector is not the cost" — **not** "CPython's cycle collector is cheap."
This benchmark does not stress it. A cyclic-garbage workload is unrun work.

### 3c. Positive control — deliberate pause injected at frame 300

| cell | n | p50 | p99 | max |
|---|---|---|---|---|
| CPython x ours | 600 | 25.44 ms | 35.48 ms | **2505 ms** |
| CPython x clang | 600 | 38.8 us | 66.8 us | **8.27 ms** |
| MicroPython x ours (256 KB heap) | — | — | — | **NOT RUN** — `MemoryError` |
| MicroPython x ours (32 MB heap) | 600 | 661.1 us | 746.0 us | **80.07 ms** |

The instrument demonstrably sees a pause where one exists: 124x over p99 (clang),
107x (MicroPython 32m). Every "no large pause observed" statement above is
licensed by these — **except for the 256 KB row**, whose control could not run.

## 4. The two empty 256 KB cells — a heap-size result, not a gap

`run-2x2.sh` discards stderr, so a zero-byte file recorded *that* a cell failed
and never *why*. Re-run with stderr captured:

- `frames-nogc-micropython-256k` → **`MemoryError`**. With the collector
  disabled, a 256 KB heap **cannot survive** 600 frames x 200 allocations.
- `control-micropython-256k` → **`MemoryError: memory allocation failed,
  allocating 32768 bytes`** at `bench_frames.py:58` — the control's deliberate
  20,000-element list does not fit in 256 KB.

Both are **real results about the 256 KB heap**, and the 32 MB sibling on the
identical workloads is the positive control proving the probe is not broken.

Consequence that must not be lost: because the 256 KB **control** could not run,
that cell's instrument was **never validated**, so no "no pause observed" claim
is admissible for `frames-auto-micropython-256k` even though it has 600 samples.

**Finding: 256 KB is not a viable heap for this workload class** — it survives
only with the collector running, and cannot do the control at all. The 32 MB R1
target has no such problem.

## 5. IN-OS startup — and what it is NOT

Measured by differencing whole boots (`tools/bench2x2/inos-startup.js`): gucOS
has no in-guest clock a script can reach, so each quantity is the wall-clock
difference between two boots differing only in how many times the thing runs.

| quantity | n | value |
|---|---|---|
| boot only, no workload | 5 | 190.2 ms p50 |
| in-OS `/bin/python -c pass`, per invocation | 5 | **44.6 ms** |
| in-OS `cat` of one file, per invocation | 5 | 44.2 ms |

**`/bin/python` in gucOS is MicroPython** (the gucman package), not CPython. So:

> **CPython in-OS startup is NOT RUN.** CPython is not in the OS image, and
> seeding a 7 MB binary is an image change this lane is scoped out of. The 2542 ms
> figure in §1 is a **Node** number and is labelled as such everywhere.

In-OS MicroPython starts in 44.6 ms vs 32.4 ms under Node. Note that a bare `cat`
costs 44.2 ms — i.e. in-OS startup is **almost entirely generic spawn overhead**,
with the interpreter's own init a small remainder. That is the kernel module
cache (todos/0037) doing its job: read-only-volume binaries compile once and the
`WebAssembly.Module` structured-clones into each spawn, so repeat launches skip
compilation entirely.

**One figure from that script is retracted as written.** Its "per-read /usr
44216.6 us / per-read /root 44338.4 us" is **not** a filesystem measurement: each
iteration spawns a `cat` (~44 ms), so the read is under 0.3% of what is timed,
and the sealed-vs-brokered delta (0.12 ms/op) is ~1.7σ against boot-to-boot
spread. **The brokered-vs-self-serving `/usr` question is unresolved by this
harness** and needs a probe that does not spawn per read.

## 6. Localizing the 1000x — what it is not

No Python involved (`diag_switch.c`, 2M iterations each):

| shape | ours | clang | ratio |
|---|---|---|---|
| tight arithmetic loop | 3.2 ns/iter | 3.5 ns/iter | **1.03x (ours faster)** |
| 64-case dense `switch` | 2.0 ns/iter | 0.4 ns/iter | 5.2x |
| indirect call through a table | 10.5 ns/iter | 1.5 ns/iter | 6.9x |

General codegen is **1–7x**, matching the known ~5.5x. It cannot produce 1000x.

Dispatch vs allocation (`probe_dispatch.py` — same opcodes, same trip count,
differing only in small-int-cache residency, so the pair isolates allocation):

| loop | ours | clang | ratio |
|---|---|---|---|
| `range(0,200)` — cached ints, **no allocation** | 52,558 ns/iter | 12.2 ns/iter | **4308x** |
| `range(1e6,1e6+200)` — one PyLong alloc/iter | 67,881 ns/iter | 31.4 ns/iter | 2162x |

The **non-allocating** loop is the worse of the two. The cost is in **bytecode
dispatch**, not the allocator — and computed gotos are off, so it is not that
either. Root cause is open as `todos/0332`.

## Verdict for the decision this gates

**CPython does not become the primary Python on this evidence.** 2.54 s startup
and 143 us per loop iteration are both disqualifying, and both are the same
defect. But the defect is **in our compiler, not in CPython**: the clang build of
the identical sources starts in 96 ms and runs the same loop in 144 ns, which is
*faster than MicroPython on our compiler by 18x*.

So the decision is not "CPython is too heavy". It is **blocked on `todos/0332`**.
If 0332 turns out to be one localized codegen pathology, the CPython case is
strong. Re-run this harness after 0332 before deciding.

Unrun work, stated so it is not mistaken for covered: cyclic-garbage GC workload;
CPython in-OS (needs the binary seeded); a `/usr`-vs-`/root` fs probe that does
not spawn per read; and the (clang x MicroPython) cell, which needs setjmp
support in cc2wasm.
