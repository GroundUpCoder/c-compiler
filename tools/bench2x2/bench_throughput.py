# bench-2x2: steady-state throughput. Reported SEPARATELY from startup and GC,
# per the spec.
#
# One timing pair around the whole workload, so the ~170us-per-call clock cost
# measured on this platform amortises to nothing (bench_frames.py's per-frame
# pairs cannot do that, which is why the two are different instruments).
#
# Emits one raw nanosecond total per repetition; the host computes statistics.
#
# Usage (argv): KIND REPS SCALE
#   KIND = "arith"  -- integer arithmetic, allocation-light
#          "alloc"  -- allocation-heavy (list construction)
#          "call"   -- function-call overhead
import sys

try:
    import bench
    now_ns = bench.now_ns
except ImportError:
    import time
    now_ns = time.perf_counter_ns

argv = sys.argv[1:]
KIND = argv[0] if len(argv) > 0 else "arith"
REPS = int(argv[1]) if len(argv) > 1 else 5
SCALE = int(argv[2]) if len(argv) > 2 else 100000


def w_arith(n):
    acc = 0
    for i in range(n):
        acc = (acc + i * 3) % 1000003
    return acc


def w_alloc(n):
    last = None
    for i in range(n):
        last = [i, i + 1, i + 2]
    return last


def _leaf(a, b):
    return a + b


def w_call(n):
    acc = 0
    for i in range(n):
        acc = _leaf(acc, i)
    return acc


WORK = {"arith": w_arith, "alloc": w_alloc, "call": w_call}[KIND]

# One untimed warm-up: first-touch page faults and any lazy interning belong to
# startup, not to steady state.
WORK(SCALE // 10 if SCALE >= 10 else 1)

for r in range(REPS):
    t0 = now_ns()
    WORK(SCALE)
    t1 = now_ns()
    print(t1 - t0)
