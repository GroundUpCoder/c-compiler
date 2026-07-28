# Csmith differential corpus

101 randomly generated, UB-free C programs from
[Csmith](https://github.com/csmith-project/csmith) 2.4.0 (BSD license,
see LICENSE), plus the `runtime/` headers they include (`csmith.h` and
the build-generated `safe_math*.h`).

Each program computes a CRC over all its global state and prints one
`checksum = XXXXXXXX` line. `manifest.json` records the checksum
produced by clang-native at generation time — so the test tier needs
only node:

    python3 tests/run.py --types=fuzz

compiles every corpus program with compiler.js, runs it under host.js,
and compares the checksum against the manifest. On a width-normalized
program (below), any mismatch is a guaranteed miscompile (Csmith
programs avoid all undefined and unspecified behavior by construction).

## Oracle soundness — literal-suffix width normalization (todos/0404)

The recorded checksums come from host clang, which is LP64 (`long` is
64-bit); compiler.js targets wasm32, which is ILP32 (`long` is 32-bit).
A raw csmith program can therefore be a DIFFERENT program on each side:
`0xD7D41305L` is a signed 64-bit `long` natively but an unsigned 32-bit
`long` under ILP32 (C11 6.4.4.1p5), flipping comparisons against it.
Seed 450020699 (`c450020699.c`, added by todos/0404) is the proof: its
correct ILP32 execution never terminates, which the live tier had
flagged as a hang-class miscompile.

The fuzz tier therefore compiles a width-normalized copy of every
program, on both sides: each `L`/`UL` integer-literal suffix is
rewritten to `LL`/`ULL` (`normalize_long_literals` in tests/run.py). On
LP64 clang the rewrite is a semantic no-op (`long` == `long long`
there), so the recorded raw-source checksums stay valid; the wasm side
then sees the oracle's literal types. ILP32-specific literal typing is
untestable against an LP64 oracle by construction — it is guarded by
`tests/unit/conformance/ilp32_long_literal_typing` instead.

If a `csmith` binary is available (checked at `~/git/csmith/build/src/
csmith` or on PATH), the category additionally generates a handful of
fresh seeds each run and differential-tests them against clang (again
width-normalized on both sides), reporting the seed of any failure so
it can be reproduced with `csmith --seed N <flags>`.

Generation flags (kept moderate so programs stay ~20KB and terminate
quickly): `--max-funcs 4 --max-block-depth 3 --max-array-dim 2
--max-array-len-per-dim 4 --max-struct-fields 6 --max-expr-complexity 8
--no-packed-struct`, seeds 1001-1113 (13 excluded: native runtime over
10s) plus 450020699 (the 0404 regression). Regenerate with a newer
Csmith by re-running the recipe in this file and refreshing
manifest.json from clang output.
