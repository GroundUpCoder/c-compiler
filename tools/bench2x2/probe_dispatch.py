# bench-2x2 probe: is the CPython/ours 1000x gap per-BYTECODE-DISPATCH or
# per-OBJECT-ALLOCATION?
#
# Two loops with the SAME bytecode count and the SAME iteration count, differing
# only in whether the loop variable is a cached small int:
#
#   small = range(0, 200)              -> ints in CPython's [-5, 256] freelist,
#                                         NO heap allocation per iteration
#   big   = range(1000000, 1000200)    -> outside the cache, one PyLong heap
#                                         allocation per iteration
#
# Same opcodes, same trip count. The difference between the two is allocation;
# what they share is dispatch. If both are ~1000x slower than the clang build,
# the cost is in dispatch. If only `big` is, it is the allocator.
import sys

try:
    import bench
    now_ns = bench.now_ns
except ImportError:
    import time
    now_ns = time.perf_counter_ns

REPS = int(sys.argv[1]) if len(sys.argv) > 1 else 5
OUTER = int(sys.argv[2]) if len(sys.argv) > 2 else 50

N = 200


def loop_small(outer):
    for _ in range(outer):
        for i in range(0, N):
            pass


def loop_big(outer):
    for _ in range(outer):
        for i in range(1000000, 1000000 + N):
            pass


loop_small(2)          # untimed warm-up
loop_big(2)

for name, fn in (("small", loop_small), ("big", loop_big)):
    best = None
    for r in range(REPS):
        t0 = now_ns()
        fn(OUTER)
        t1 = now_ns()
        d = t1 - t0
        if best is None or d < best:
            best = d
    # per inner-loop-iteration nanoseconds
    print("%s %d %.1f" % (name, best, float(best) / (OUTER * N)))
