# Csmith differential corpus

100 randomly generated, UB-free C programs from
[Csmith](https://github.com/csmith-project/csmith) 2.4.0 (BSD license,
see LICENSE), plus the `runtime/` headers they include (`csmith.h` and
the build-generated `safe_math*.h`).

Each program computes a CRC over all its global state and prints one
`checksum = XXXXXXXX` line. `manifest.json` records the checksum
produced by clang-native at generation time — so the test tier needs
only node:

    python3 tests/run.py --types=fuzz

compiles every corpus program with compiler.js, runs it under host.js,
and compares the checksum against the manifest. Any mismatch is a
guaranteed miscompile (Csmith programs avoid all undefined and
unspecified behavior by construction).

If a `csmith` binary is available (checked at `~/git/csmith/build/src/
csmith` or on PATH), the category additionally generates a handful of
fresh seeds each run and differential-tests them against clang,
reporting the seed of any failure so it can be reproduced with
`csmith --seed N <flags>`.

Generation flags (kept moderate so programs stay ~20KB and terminate
quickly): `--max-funcs 4 --max-block-depth 3 --max-array-dim 2
--max-array-len-per-dim 4 --max-struct-fields 6 --max-expr-complexity 8
--no-packed-struct`, seeds 1001-1113 (13 excluded: native runtime over
10s). Regenerate with a newer Csmith by re-running the recipe in this
file and refreshing manifest.json from clang output.
