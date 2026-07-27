# 0332 — the ~1000x CPython bytecode-dispatch pathology: root cause, fix, and what it was NOT

Lane `diag-0332`, off `main@c1b1f47c`. Every number below is measured on this box
today; inferences are labelled. Raw output is committed under
`tools/bench2x2/results/0332-*.txt` — nothing here is retyped from a terminal.

## Verdict

**The ticket's leading hypothesis is CONFIRMED, with one correction, and one of
the ticket's two headline claims is REFUTED.**

- CONFIRMED (measured, read out of the emitted bytes): irreducible control flow
  is lowered to a loop+switch state machine, and that state machine's switch was
  lowered as a **linear compare chain**, so every block transition cost
  O(blocks). `_PyEval_EvalFrameDefault` has **5752** blocks → a **5752-entry**
  chain, ~2876 compares per taken edge.
- CORRECTION to the ticket's phrasing: the opcode switch itself was **never** the
  problem. It is 256 cases and our compiler already gave it a `br_table`. The
  chain is the *synthetic* `switch (__irreducible_state)`, not ceval's `switch
  (opcode)`.
- REFUTED (measured): the ticket says "*both* disqualifying numbers are this one
  defect". They are not. Fixing this makes bytecode throughput **162x** faster
  and leaves whole-process startup **essentially unchanged** (2.53 s → 2.50 s).
  Startup is a **second, independent defect**, localized below and filed as
  `todos/0334`.

## 1. Root cause — one constant, `compiler.js`

`CodeGenerator`'s `SSwitch` arm picks `br_table` vs a linear `br_if` chain:

```js
range = nonDefaultCount > 0 ? maxVal - minVal + 1 : 0;
dense = nonDefaultCount >= 4 && range <= 512 &&
    (nonDefaultCount * 10 / range) >= 4; // density >= 40%
```

`range <= 512`. The irreducible lowering (`synthesizeWrapper`) rewrites a
function into

```
int __irreducible_state = 0;
while (1) switch (__irreducible_state) { case 0: …; case 1: …; /* one per block */ }
```

That switch is *perfectly* dense — ids `0..N-1`, 100% density — but its **range
is the function's block count**. Any lowered function with more than 512 blocks
therefore failed the cap and got the linear chain. This was invisible because the
density test, the thing that looks like the heuristic, always passed.

### The evidence, read out of the shipped artifact

There is no wabt on this box, so `tools/bench2x2/wasmscan.js` (a dependency-free
wasm reader) and `tools/bench2x2/cmpchain.js` (a compare-chain detector) were
written for this. Both artifacts are the pinned ones from
`tools/bench2x2/README.md` (size + sha256 verified).

`_PyEval_EvalFrameDefault` is the largest function in both builds; in the clang
build the name section confirms it is `#4594`, in ours (no name section) it is
`#4513`, 295,002 bytes vs clang's 90,192.

```
$ node tools/bench2x2/cmpchain.js ~/build/bench2x2/python-ours-v176.wasm '#4513'
# #4513: 126859 instrs, 5 chains (len>=3), 5768 compares in chains
  chain len=5752 local=1940 @instr 5769 byte 11540  keys[0..12]=0,1,2,3,4,5,6,7,8,9,10,11,12

$ node tools/bench2x2/cmpchain.js .../python-clang-verify.wasm _PyEval_EvalFrameDefault
# _PyEval_EvalFrameDefault: 35208 instrs, 0 chains (len>=3), 0 compares in chains
```

And the shape, straight from the disassembler — 5752 nested `block`s, the state
copy, then the scan:

```
      6 @     12  i32.const 0
      7 @     14  local.set 1939        ; __irreducible_state = 0
      8 @     17  block
      9 @     19    loop                ; while (1)
     10 @     21      i32.const 1
     11 @     23      i32.eqz
     12 @     24      br_if 1
     13 @     26      block               ) 5752 of these
    ...
   5767 @  11534      local.get 1939
   5768 @  11537      local.set 1940
   5769 @  11540      local.get 1940
   5770 @  11543      i32.const 0
   5771 @  11545      i32.eq
   5772 @  11546      br_if 0             ; …repeated for 1, 2, 3, … 5751
```

Opcode histogram, same function: ours **7330** `i32.eq` against clang's **863**.
Ours emitted **4** `br_table`s (the largest 256 entries — the opcode switch,
which was always fine); clang emitted 15.

**Positive control.** The probe was validated on the input known to exhibit the
thing before any negative was believed: `cmpchain.js` finds the 5752-chain in the
unmodified shipped artifact, and reports zero chains for the clang build of the
same sources.

## 2. The minimal repro — `tools/bench2x2/diag_reloop.c`, no Python

`_PyEval_EvalFrameDefault` in miniature: a `dispatch:` label, a wide opcode
switch, each opcode ending in a backward `goto dispatch`, plus a forward
`goto error` out of the switch to a label the switch body cannot see — that last
edge is the one our structured emitter cannot place (ceval does exactly this with
`goto error` / `goto exit_unwind`). Two compile-time knobs, so the four builds
differ **only** in codegen; `acc` is identical across all four, so the transform
is measurably behaviour-preserving here.

`sh tools/bench2x2/mk-reloop.sh <outdir> [compiler.js]`, 500,000 steps
(`results/0332-reloop-{before,after}.txt`):

| cell | chain (before) | before | after | speedup |
|---|---|---|---|---|
| `OPS=256 IRRED=0` (control, structured) | none | **3.9 ns/step** | 3.8 ns/step | 1.0x |
| `OPS=256 IRRED=1` (state machine) | 524 | 62.5 ns/step | 12.7 ns/step | 4.9x |
| `OPS=1024 IRRED=0` (plain switch over the cap) | 1024 | 262.3 ns/step | 5.4 ns/step | 49x |
| `OPS=1024 IRRED=1` (both) | 2060 + 1024 | **524.7 ns/step** | 16.8 ns/step | 31x |

Against the structured control in the same table, the worst cell was **135x**
before the fix and **4.4x** after — i.e. back inside the known ~5.5x
general-codegen band. `cmpchain.js` reports **zero** chains in all four cells
after the fix; that is an assertion on the artifact, not on an exit code.

The `OPS=1024 IRRED=0` row is worth its own sentence: it is a *plain user switch*
with 1024 cases and no irreducible flow at all, and it was 67x slower than the
same program with 256 cases. The 512 cap was hurting ordinary code too.

## 3. The fix

```js
const MAX_BR_TABLE_RANGE = 65520;
…
dense = nonDefaultCount >= 4 && range <= MAX_BR_TABLE_RANGE &&
    (nonDefaultCount * 10 / range) >= 4;
```

The cap is not a code-size trade-off. The density test already guarantees the
table holds ≤2.5 entries per case, and a table entry is 1–3 LEB bytes against ~8
for a compare-and-branch — so **whenever the density test passes, `br_table` is
smaller than the chain as well as O(1) instead of O(n)**. Confirmed on the real
build: the code section *shrank* by 74,375 bytes and only four functions changed,
all smaller (`#4513` 295,002 → 249,058; `#749/#752/#755` each −9,477).

65520 is not a tuning knob: it is V8's `kV8MaxWasmFunctionBrTableSize`. Measured,
not recalled — a hand-built module with a 65520-entry `br_table` validates and
65521 is rejected with *"invalid table count (> max br_table size)"*.

**Residual, filed as `todos/0333`:** a function with more than 65520 blocks still
degrades to the linear chain. None exists in the CPython build (the largest is
5752), so this is a latent bound, not a live one.

## 4. Effect on CPython — controlled A/B

The committed `python-ours-v176.wasm` is **not** byte-reproducible from
`ccjs-build.sh` today: a rebuild with the *unmodified* v176 compiler gives
7,163,772 B, not 7,006,275 B, differing only in the **data** section (+157,497 B).
So the A/B below is **baseline-rebuilt-today vs fixed-today**, both through the
same script on the same tree, which differ *only* in the code section
(5,120,947 → 5,046,572; data byte-identical). The stale-artifact discrepancy is
noted in `todos/0334`; it does not touch this comparison, and the rebuilt
baseline carries the same 5752-entry chain as the pinned artifact.

`probe_dispatch.py 5 50`, ns per loop iteration
(`results/0332-cpython-ab-dispatch.txt`):

| loop | baseline | **fixed** | clang | before | after |
|---|---|---|---|---|---|
| `range(0,200)`, no allocation | 45,035.1 ns | **155.0 ns** | 12.1 ns | 3722x | **12.8x** |
| `range(1e6,…)`, one PyLong/iter | 61,710.4 ns | **219.4 ns** | 31.9 ns | 1934x | **6.9x** |

`bench_throughput.py arith`, ns per iteration
(`results/0332-cpython-ab-throughput-startup.txt`):

| | baseline | **fixed** | clang |
|---|---|---|---|
| arith loop | 142,345 ns | **875.7 ns** | 141.1 ns |
| vs clang | 1009x | **6.2x** | 1.0 |

**162x faster, and 6.2x of clang — inside the stated ~5.5x general-codegen
target's neighbourhood.** The acceptance criterion asked for a *stated multiple*:
it is **6.2x on arith throughput, 6.9x–12.8x on the dispatch probe**.

## 5. What this did NOT fix — startup, and why (`todos/0334`)

Startup, whole-process wall, `-c pass`, 7 samples, default V8 flags:

```
baseline  2.50 2.53 2.52 2.55 2.54 2.53 2.49
fixed     2.45 2.50 2.54 2.45 2.50 2.51 2.50
clang     0.09 0.09 0.09 0.09 0.09 0.09 0.09
```

Unchanged. The bisection:

- Instrumented host.js: `WebAssembly.Instance` 0.8 ms; `main()` **920.8 ms →
  205.5 ms** (4.5x — the fix *is* working); JS-observable total-to-exit 213 ms —
  against a **2.42 s** wall. So ~2.2 s is spent after the JS `exit` event, in
  native teardown.
- `-X importtime` accounts for only ~24 ms of imports. Module load is not it
  either: sync `new WebAssembly.Module` is 1.3 ms.
- `node --liftoff-only` (V8's optimizing tier disabled entirely):
  `baseline 0.95 → fixed 0.25 s`, clang 0.07 s. The whole gap moves.
- `node --trace-wasm-compilation-times` names the culprit exactly
  (`results/0332-turbofan-census.txt`):

| build | TurboFan on the eval loop | bodysize | TurboFan total |
|---|---|---|---|
| baseline | **2341 ms** | 295,002 | 2381 ms over 43 fns |
| fixed | **2277 ms** | 249,058 | 2274 ms over 43 fns |
| clang | **55 ms** | 90,192 | 63 ms over 33 fns |

**Measured:** V8 spends ~2.28 s optimizing our single lowered
`_PyEval_EvalFrameDefault`, and the process blocks at exit waiting for it. That
is 41x clang's compile cost for 2.8x the bytes — superlinear, and it is the
entire 26x startup gap.

**Inferred (not measured):** the superlinearity is a property of the loop-switch
*shape* — 5752 nested `block`s, ~2000 locals, and one basic block per case, which
gives TurboFan a single function with thousands of live ranges. clang never
builds this shape; LLVM's wasm backend keeps the natural loop structure. Testing
that inference, and the fix directions it implies (a real relooper so fewer
functions need the state machine at all, node-splitting instead of full
flattening, or shrinking the local count), is `todos/0334`.

## 6. Bearing on the decision this gates

The bench2x2 verdict was "CPython does not become the primary Python, and the
decision is blocked on 0332". 0332 is now closed, and the verdict splits:

- **Throughput is no longer disqualifying.** 6.2x of clang on arith, ~7x on
  allocating dispatch. That is ordinary codegen distance, not a pathology.
- **Startup still is** — 2.50 s vs 96 ms — but for a *completely different*
  reason, and one whose cost is paid by the host engine rather than by the
  program. `--liftoff-only` already runs it in 0.25 s, which is a measured upper
  bound on how much of that 2.5 s is engine compile time rather than work.

Re-run `tools/bench2x2/verify.sh` against a fixed-compiler rebuild before the
decision is retaken, and read `todos/0334` first.
