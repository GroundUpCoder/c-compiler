#!/bin/sh
# bench-2x2 VERIFICATION PASS — re-derives every claim in the report from the
# artifacts, capturing raw output so no number in the writeup is hand-transcribed.
#
#   sh verify.sh <out-dir>
#
# Absolute paths throughout: this box's shell resets cwd between calls, and a
# relative `node host.js` silently becomes a module-load error that looks like a
# fast benchmark (that exact failure produced a bogus 0.02s "result" once).
set -eu
OUT=${1:?out dir}
mkdir -p "$OUT"

H=$HOME/worktree/c-compiler/bench-2x2/host.js
B=$HOME/build/bench2x2
PC=$HOME/build/python-clang
OURS=$B/python-ours-v176.wasm
CLANG=$PC/python-clang-verify.wasm
MP32=$B/mp-ours-32m.wasm
MP256=$B/mp-ours-256k.wasm

PYTHONHOME=$PC/cpython
PYTHONPATH=$PC/cpython/Lib
export PYTHONHOME PYTHONPATH

# ---------------------------------------------------------------- liveness ---
# Assert on the ARTIFACT, never the exit code: a binary that prints nothing did
# not run. Every cell must emit "2" before any of its timings are believed.
{
  echo "# each line must be exactly 2"
  node "$H" "$OURS"  -c 'print(1+1)' 2>&1 | tail -1
  node "$H" "$CLANG" -c 'print(1+1)' 2>&1 | tail -1
  node "$H" "$MP32"  -c 'print(1+1)' 2>&1 | tail -1
  node "$H" "$MP256" -c 'print(1+1)' 2>&1 | tail -1
} > "$OUT/liveness.txt" 2>&1

# ------------------------------------------------- codegen shape diagnostic ---
# Is the CPython gap general codegen, or CPython-specific? No Python involved.
{ echo "## ours";  node "$H" "$B/diag-ours.wasm";
  echo "## clang"; node "$H" "$B/diag-clang.wasm"; } > "$OUT/diag-codegen.txt" 2>&1

# --------------------------------------------- dispatch vs allocation probe ---
# Same opcodes, same trip count; only small-int-cache residency differs.
{ echo "## clang (REPS=5 OUTER=50)"; node "$H" "$CLANG" "$B/probe_dispatch.py" 5 50;
  echo "## ours  (REPS=3 OUTER=5)";  node "$H" "$OURS"  "$B/probe_dispatch.py" 3 5;
  echo "## mp32m (REPS=5 OUTER=50)"; node "$H" "$MP32"  "$B/probe_dispatch.py" 5 50;
} > "$OUT/probe-dispatch.txt" 2>&1

# ------------------------------------------------- external wall-clock arbiter ---
# The guest clock cannot be trusted on its own word. Slope of whole-process wall
# time vs SCALE is the true per-iteration cost, immune to any in-guest clock bug.
{
  echo "# real seconds, whole process. slope vs SCALE = true per-iteration cost"
  printf 'mp32m  startup     '; /usr/bin/time -p node "$H" "$MP32"  -c pass 2>&1 | grep real
  printf 'mp32m  arith S=20k '; /usr/bin/time -p node "$H" "$MP32"  "$B/bench_throughput.py" arith 5 20000 2>&1 | grep real
  printf 'mp32m  arith S=40k '; /usr/bin/time -p node "$H" "$MP32"  "$B/bench_throughput.py" arith 5 40000 2>&1 | grep real
  printf 'clang  startup     '; /usr/bin/time -p node "$H" "$CLANG" -c pass 2>&1 | grep real
  printf 'clang  arith S=200k'; /usr/bin/time -p node "$H" "$CLANG" "$B/bench_throughput.py" arith 5 200000 2>&1 | grep real
  printf 'ours   startup     '; /usr/bin/time -p node "$H" "$OURS"  -c pass 2>&1 | grep real
  printf 'ours   arith S=20k '; /usr/bin/time -p node "$H" "$OURS"  "$B/bench_throughput.py" arith 5 20000 2>&1 | grep real
} > "$OUT/external-arbiter.txt" 2>&1

# ------------------------------------------------------- V8 wasm compile cost ---
# Rules module LOAD in or out as an explanation for startup.
node -e '
const fs = require("fs");
const cells = process.argv.slice(1);
(async () => {
  for (let i = 0; i < cells.length; i += 2) {
    const buf = fs.readFileSync(cells[i + 1]), ts = [];
    for (let k = 0; k < 5; k++) {
      const t0 = process.hrtime.bigint();
      await WebAssembly.compile(buf);
      ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ts.sort((a, b) => a - b);
    console.log(cells[i].padEnd(16) + "bytes=" + String(buf.length).padStart(8)
      + "  V8 compile p50=" + ts[2].toFixed(1) + " ms");
  }
})();' cpython-ours "$OURS" cpython-clang "$CLANG" micropython-32m "$MP32" \
  > "$OUT/wasm-compile.txt" 2>&1

# ------------------------------------------------ why the 256K cells are empty ---
# run-2x2.sh discarded stderr, so a zero-byte file recorded THAT a cell failed,
# never WHY. The 32m sibling on the identical workload is the positive control:
# without it, "256K failed" is indistinguishable from "the probe is broken".
{
  echo "## 256K frames-nogc"; node "$H" "$MP256" "$B/bench_frames.py" 600 200 nogc    2>&1 | tail -3
  echo "## 256K control";     node "$H" "$MP256" "$B/bench_frames.py" 600 200 control 2>&1 | tail -3
  echo "## POSITIVE CONTROL — 32m, same workloads, must print numbers"
  node "$H" "$MP32" "$B/bench_frames.py" 600 200 nogc    2>&1 | tail -1
  node "$H" "$MP32" "$B/bench_frames.py" 600 200 control 2>&1 | tail -1
} > "$OUT/empty-256k-cells.txt" 2>&1

echo "verify.sh: wrote $OUT"
ls -l "$OUT"
