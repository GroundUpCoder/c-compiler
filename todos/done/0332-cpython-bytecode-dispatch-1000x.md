# 0332 — CPython bytecode dispatch is ~1000x slower than the clang build of identical sources

- **Status**: done — root cause found and fixed on `diag-0332`
- **Design**: `logs/2026-07-27/bench2x2-python-profile.md` (measurement + localization)
- **Root cause + fix**: `logs/2026-07-27/0332-dispatch-1000x-rootcause.md`

## Outcome

The leading hypothesis below was **CONFIRMED**: irreducible control flow lowers to
a loop+switch state machine, and that state machine's switch was emitted as a
**linear compare chain** — 5752 entries for `_PyEval_EvalFrameDefault`, ~2876
compares per bytecode. One constant in `compiler.js` (`MAX_BR_TABLE_RANGE`, was a
bare `512`) excluded it from the `br_table` path, because the *range* of a
perfectly-dense `switch (__irreducible_state)` is the function's block count.

One correction: ceval's own 256-case opcode switch was never the problem — it
already got a `br_table`. The chain was the synthetic state switch.

Measured after the fix (controlled A/B, same build script, compiler the only
variable):

| probe | before | after | clang | after-vs-clang |
|---|---|---|---|---|
| `range(0,200)` loop, no allocation | 45,035 ns/iter | **155.0 ns** | 12.1 ns | **12.8x** |
| `range(1e6,…)` loop, one alloc/iter | 61,710 ns/iter | **219.4 ns** | 31.9 ns | **6.9x** |
| `bench_throughput.py arith` | 142,345 ns/iter | **875.7 ns** | 141.1 ns | **6.2x** |

162x faster; **the stated multiple of clang is 6.2x on arith throughput**, which
is the ~5.5x general-codegen figure the acceptance criterion named.

One of this ticket's own claims is **REFUTED**: "*both* disqualifying numbers are
this one defect" is wrong. Startup did **not** move (2.53 s → 2.50 s). It is a
second, independent defect — V8 spends 2.28 s in TurboFan on our one lowered
function — now filed as `todos/0334`. The >65520-block residue of the fix is
`todos/0333`.

## Goal

Find and fix the codegen pathology that makes `compiler.js`-built CPython execute
Python bytecode **~1000–4300x** slower than the clang build of the *same* sources.

This is filed **P0** under the standing rule that any bug found from anywhere is
P0 unless the user says otherwise. It is a performance defect rather than a
miscompile — the binary is correct, it is merely ~1000x slow — so a demotion is
reasonable if the queue disagrees; it should be an explicit call, not a silent one.

It blocks a real decision: **whether CPython becomes the primary Python for
gucOS**. On today's numbers CPython is disqualified on startup (2.54 s vs 96 ms)
and throughput (143 us vs 144 ns per loop iteration) — but *both* disqualifying
numbers are this one defect, and the clang build of the identical sources is
comfortably viable. The decision is blocked on this ticket, not on CPython.

## What is established

Measured with `tools/bench2x2/`; every claim re-derivable via
`tools/bench2x2/verify.sh`.

**Comparable by construction.** Both CPython artifacts are the same 174 TUs, the
same generated `pyconfig.h`, the same defines/includes, the same libc, the same
host ABI; `cc-build.sh` and `ccjs-build.sh` differ *only* in which compiler they
invoke, and neither passes an explicit `-O`. The compiler is the only variable.

| probe | ours | clang | ratio |
|---|---|---|---|
| CPython `-c pass` startup (Node, n=15) | 2542 ms | 96.15 ms | 26.4x |
| CPython loop iteration, arith | 143.0 us | 144.5 ns | ~990x |
| CPython `range(0,200)` loop, **no allocation** | 52,558 ns | 12.2 ns | **4308x** |
| C: tight arithmetic loop | 3.2 ns | 3.5 ns | 1.03x (ours faster) |
| C: 64-case dense `switch` | 2.0 ns | 0.4 ns | 5.2x |
| C: indirect call through a table | 10.5 ns | 1.5 ns | 6.9x |

Confirmed by an **external wall-clock arbiter** (whole-process wall time vs
workload size), so it does not rest on any in-guest clock: ours 131 us/iter
measured externally vs 143 us self-reported.

### Ruled OUT

- **General codegen quality.** 1–7x on C microbenchmarks; ours is *faster* than
  clang on the arithmetic loop. Cannot produce 1000x.
- **The allocator.** The **non-allocating** dispatch loop is the *worse* case
  (4308x vs 2162x for the allocating one). `WITH_PYMALLOC` is `#undef` on both
  sides, so both use raw `malloc` — not an asymmetry.
- **Computed gotos.** `USE_COMPUTED_GOTOS` is `#undef` in the shared
  `pyconfig.h`; both builds dispatch through the plain `switch`.
- **A debug build.** `Py_DEBUG` is `#undef`, shared by both.
- **Module load.** V8 compiles the 7 MB module in 3.8 ms — 0.15% of startup.
- **Small dense switches.** The 64-case `switch` in `diag_switch.c` costs only
  5.2x, so whatever this is, that diagnostic does not reproduce it.

## Plan

The defect is in the **bytecode dispatch path** and is *not* reproduced by any
existing diagnostic. Next step is a minimal repro:

1. Scale `tools/bench2x2/diag_switch.c` up toward what `_PyEval_EvalFrameDefault`
   actually is — ~250 sparse cases inside a very large function, with backward
   `goto`s into the dispatch point (ceval's `goto dispatch_opcode` /
   `goto error` / `goto resume_frame`). The leading suspicion is **irreducible
   control flow**: wasm has structured control flow only, so a CFG that cannot be
   reduced must be lowered to a loop+switch state machine, and if that state
   machine's switch is large and lowered linearly, every block transition costs
   O(blocks). ceval has thousands of blocks. This fits the magnitude in a way
   that a 250-case linear opcode scan (~60x) does not.
2. If confirmed, inspect the emitted wasm for `_PyEval_EvalFrameDefault` —
   `br_table` vs a compare chain, and how many dispatch hops per bytecode.
3. Fix at the lowering level (`br_table` for the state machine, or a better
   reduction so the state machine is not needed at all).

Guard against a false negative: the probe must be validated on an input known to
be slow (the CPython artifact itself) before a "cannot reproduce" is believed.

## Acceptance

- A minimal C repro, no Python involved, that shows the pathology at
  ≥100x — committed as a diagnostic alongside `diag_switch.c`.
- Root cause named in a dev log, with the emitted-wasm evidence.
- After the fix: `tools/bench2x2/` re-run; CPython x ours bytecode throughput
  within a **stated multiple** of CPython x clang (the ~5.5x general-codegen
  figure is the sane target), and the startup figure re-measured.
- No regression on the existing estate: `node tests/run.js all`.
