# bench-2x2: allocate-per-frame jitter probe.
#
# Runs UNMODIFIED on both CPython and the gucOS MicroPython port. It emits RAW
# per-frame nanosecond samples and nothing else -- every statistic (p50, p99,
# max, histogram) is computed on the host in JS, so the two engines are scored
# by literally the same code path. An engine computing its own percentiles
# would put the stdlib's sort/mean in the measurement.
#
# Usage (argv): FRAMES ALLOC_PER_FRAME MODE
#   MODE = "auto"    -- collector left in its default automatic mode
#          "nogc"    -- cyclic collector disabled (CPython: refcounting ONLY)
#          "control" -- POSITIVE CONTROL: injects a deliberate large pause at a
#                       known frame so the instrument is shown able to see one
import sys

try:                       # gucOS MicroPython: no `time` module at all
    import bench
    now_ns = bench.now_ns
except ImportError:        # CPython
    import time
    now_ns = time.perf_counter_ns

import gc

argv = sys.argv[1:]
FRAMES = int(argv[0]) if len(argv) > 0 else 600
ALLOC = int(argv[1]) if len(argv) > 1 else 200
MODE = argv[2] if len(argv) > 2 else "auto"

if MODE == "nogc":
    gc.disable()

# A frame's work: build ALLOC small short-lived objects and drop them. Lists of
# lists are used rather than ints so the allocation is a real heap allocation on
# both engines (small ints are interned/tagged and would measure nothing).
# `sink` keeps a slowly-growing live set so the heap is not trivially empty --
# a collector with nothing live has nothing to scan and reports flat zeros.
sink = []
samples = []

for f in range(FRAMES):
    t0 = now_ns()

    garbage = None
    for i in range(ALLOC):
        garbage = [i, [i, i], None]
    if f % 16 == 0:
        sink.append(garbage)          # retain ~1/16 of frames' last object
        if len(sink) > 256:
            del sink[0:128]           # bounded live set, causes real churn

    if MODE == "control" and f == FRAMES // 2:
        # POSITIVE CONTROL: a deliberate, unmistakably large pause. If the
        # histogram for this run does not show it, the instrument is broken and
        # every "no pause observed" result elsewhere is worthless.
        big = []
        for i in range(20000):
            big.append([i, i, i])
        gc.collect()
        big = None

    t1 = now_ns()
    samples.append(t1 - t0)

for s in samples:
    print(s)
