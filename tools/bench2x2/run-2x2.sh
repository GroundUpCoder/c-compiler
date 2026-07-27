#!/bin/sh
# bench-2x2: run every cell. Startup / throughput / GC stay SEPARATE outputs --
# they are never combined into a score.
#
#   sh run-2x2.sh <results-dir>
set -eu
OUT=${1:?results dir}
mkdir -p "$OUT"

REPO=$HOME/worktree/c-compiler/bench-2x2
HOST=$REPO/host.js
B=$HOME/build/bench2x2
PC=$HOME/build/python-clang

PYTHONHOME=$PC/cpython
PYTHONPATH=$PC/cpython/Lib
export PYTHONHOME PYTHONPATH

# The three buildable cells. MicroPython x clang is absent BY MEASUREMENT, not
# by omission: cc2wasm cannot compile any translation unit that includes
# <setjmp.h>, and MicroPython's NLR (py/nlrsetjmp.c) is setjmp-based.
cells_wasm() {
  echo "cpython-ours      $B/python-ours-v176.wasm"
  echo "cpython-clang     $PC/python-clang-verify.wasm"
  echo "micropython-256k  $B/mp-ours-256k.wasm"
  echo "micropython-32m   $B/mp-ours-32m.wasm"
}

# ---------------------------------------------------------------- startup ---
# Wall clock of a whole process doing nothing, measured OUTSIDE the guest --
# an in-guest clock cannot see interpreter init, which is the thing being
# measured. n=15 per cell; raw samples kept so spread is reported, not hidden.
echo "### startup (ns, whole-process, -c pass)"
cells_wasm | while read -r name wasm; do
  : > "$OUT/startup-$name.txt"
  i=0
  while [ $i -lt 15 ]; do
    node -e '
      const {execFileSync} = require("child_process");
      const t0 = process.hrtime.bigint();
      execFileSync(process.argv[1], [process.argv[2], "-c", "pass"], {stdio: "ignore"});
      process.stdout.write(String(process.hrtime.bigint() - t0) + "\n");
    ' "$HOST" "$wasm" >> "$OUT/startup-$name.txt" 2>/dev/null || echo "SKIP $name" >&2
    i=$((i + 1))
  done
  node "$B/analyze.js" "startup $name" < "$OUT/startup-$name.txt"
done

# ------------------------------------------------------------- throughput ---
echo
echo "### steady-state throughput (ns per workload, n=5, SCALE=20000)"
for kind in arith alloc call; do
  cells_wasm | while read -r name wasm; do
    node "$HOST" "$wasm" "$B/bench_throughput.py" "$kind" 5 20000 \
      > "$OUT/thru-$kind-$name.txt" 2>/dev/null || true
    if [ -s "$OUT/thru-$kind-$name.txt" ]; then
      node "$B/analyze.js" "throughput/$kind $name" < "$OUT/thru-$kind-$name.txt"
    else
      echo "== throughput/$kind $name == NO SAMPLES"
    fi
  done
done

# ---------------------------------------------------------------------- GC ---
# Reported as a DISTRIBUTION (max + p99), never a mean.
#
# CPython's two collectors are separated by MODE, which is the whole point:
#   auto  = refcounting + the stop-the-world generational cycle collector
#   nogc  = refcounting ONLY (gc.disable() stops cycle collection)
# The difference between the two distributions IS the cycle collector's cost.
# MicroPython has one mark-sweep collector and no refcounting, so only `auto`
# is meaningful there -- `nogc` is still run to show the knob is observed.
echo
echo "### GC / frame-time jitter (per-frame ns, 600 frames)"
for mode in auto nogc; do
  cells_wasm | while read -r name wasm; do
    node "$HOST" "$wasm" "$B/bench_frames.py" 600 200 "$mode" \
      > "$OUT/frames-$mode-$name.txt" 2>/dev/null || true
    if [ -s "$OUT/frames-$mode-$name.txt" ]; then
      node "$B/analyze.js" "gc/$mode $name" < "$OUT/frames-$mode-$name.txt"
    else
      echo "== gc/$mode $name == NO SAMPLES"
    fi
  done
done

# ------------------------------------------------------- positive control ---
# Required before any "no pause observed" claim is allowed to stand.
echo
echo "### POSITIVE CONTROL (deliberate pause injected at frame 300)"
cells_wasm | while read -r name wasm; do
  node "$HOST" "$wasm" "$B/bench_frames.py" 600 200 control \
    > "$OUT/control-$name.txt" 2>/dev/null || true
  if [ -s "$OUT/control-$name.txt" ]; then
    node "$B/analyze.js" "control $name" < "$OUT/control-$name.txt"
  else
    echo "== control $name == NO SAMPLES"
  fi
done
