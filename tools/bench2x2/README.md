# bench2x2 — the (our compiler | clang) x (CPython | MicroPython) profile benchmark

Harness + raw measurements for the Python-runtime decision (does CPython become the
primary Python for gucOS, or does MicroPython stay?). Startup, throughput and GC are
**three separate reports**; they are never blended into a score.

The multi-MB `.wasm` artifacts are deliberately **not** committed. They live in
`~/build/bench2x2` and `~/build/python-clang` on the machine that produced them, and are
identified here by sha256 so a cell can always be traced back to the exact binary that
produced it.

## Artifacts — which binary produced which cell

| cell name | artifact | bytes | sha256 |
|---|---|---|---|
| `cpython-ours` | `~/build/bench2x2/python-ours-v176.wasm` | 7,006,275 | `bd83ef09…cc850e8b` |
| `cpython-clang` | `~/build/python-clang/python-clang-verify.wasm` | 4,523,831 | `303f59be…6d39f87e` |
| `micropython-256k` | `~/build/bench2x2/mp-ours-256k.wasm` | 555,745 | `0134e3e3…f44a9225` |
| `micropython-32m` | `~/build/bench2x2/mp-ours-32m.wasm` | 555,748 | `42c91bfa…21a43651` |

Full hashes:

```
bd83ef099cf9bcacdf8b9d1de0c6bbe82da5f24560b1039a0b380251cc850e8b  python-ours-v176.wasm
303f59be1d9f041b0ca4ebcb6a05966753f9906a3da1ae6265419b466d39f87e  python-clang-verify.wasm
0134e3e392c5f3a114424bdcbe2b1ef59fade83c6c02bf34c6351e5af44a9225  mp-ours-256k.wasm
42c91bfa407e85a53d53fcba90894d3cf384311f70d33acd5f49b6621a43651f  mp-ours-32m.wasm
```

### Build provenance

- **`cpython-ours`** — CPython 3.13.5, all 174 TUs, built by **stock v176 `compiler.js`
  plus a single one-line `todos/0323` diagnostic relaxation at the link step**. That is
  the entire caveat: the older "our side needs three open patches" claim is dead — v176
  compiles every CPython TU as shipped, and 0323 is the only remaining blocker. 0323 is
  **still open**; this is not "it works today".
  The artifact is **byte-identical** to the `python-clang` lane's three-patch build
  (same sha `bd83ef09…`, same 7,006,275 B), which is the proof that the 0323 relaxation
  has no codegen consequence — 0323 is a const-qualifier *diagnostic*, no ABI effect.
- **`cpython-clang`** — the same CPython sources built by clang, from the `python-clang`
  lane (@`1addbcf9`).
- **`micropython-*`** — MicroPython built by our compiler, identical sources, differing
  only in `MICROPY_GC_HEAP_SIZE` (256 KB vs the 32 MB gucOS R1 target). The two binaries
  differ by 3 bytes, which is the heap-size constant.

### The absent cell

There is **no (clang x MicroPython) build**. The 2x2 is therefore 3 cells wide, not 4.
It is absent by measurement, not by omission — see `run-2x2.sh`'s note.

## Layout

- `run-2x2.sh` — drives every cell; writes one raw-sample file per (metric, cell).
- `bench_throughput.py` — steady-state workloads (arith / alloc / call).
- `bench_frames.py` — per-frame allocate-and-drop jitter probe, plus the positive control.
- `analyze.js` — host-side statistics, so both engines are scored by the same code.
- `benchmod.c` / `mk-mp-*.js` / `mp-build.sh` — the MicroPython `bench.now_ns` clock module
  and the MicroPython build scripts.
- `inos-startup.js` — in-OS (gucOS kernel) startup measurement.
- `results/*.txt` — raw samples, **nanoseconds**, one per line, no header.

### The todos/0332 diagnostics

Added by the lane that root-caused and fixed the ~1000x dispatch gap
(`logs/2026-07-27/0332-dispatch-1000x-rootcause.md`). These files read and time
the *emitted wasm*, so they answer "how was this lowered", not just "how fast is it".

- `wasmscan.js` — a dependency-free wasm reader. There is no wabt on this box
  (`wasm2wat`/`wasm-objdump`/`wasm-dis` are all absent, and package managers are
  forbidden), so this is the disassembly substrate.
  `--sections` / `--list [substr]` / `--hist F` / `--dump F [from] [n]` /
  `--brtables F`. A function is addressed by name (needs a name section — clang
  has one, we emit none), by `#index`, or by `@big` = the largest defined
  function, which in both CPython builds IS `_PyEval_EvalFrameDefault`.
- `cmpchain.js` — finds linear `local.get L; i32.const K; i32.eq; br_if` compare
  chains, the shape a switch takes when it is lowered as an O(n) scan instead of
  a `br_table`. This is the probe that found the 5752-entry chain; validate any
  "no chain" result against a pre-fix artifact before believing it.
- `diag_reloop.c` + `mk-reloop.sh` — the minimal repro, no Python. Four builds of
  one source (`-DOPS=256|1024` x `-DIRRED=0|1`) differing only in codegen;
  `sh mk-reloop.sh <outdir> [compiler.js]` builds, runs and reports each cell's
  chain length. 135x before the fix, 4.4x after, against its own structured cell.
- `results/0332-*.txt` — the raw before/after output, including the
  `--trace-wasm-compilation-times` census that localized the *separate* startup
  defect now filed as `todos/0334`.

An empty `results/*.txt` means the cell produced no samples. `run-2x2.sh` discards stderr,
so an empty file records only *that* it failed, never *why* — a zero-byte file is
**NOT RUN / FAILED**, never "about the same as its neighbour".
