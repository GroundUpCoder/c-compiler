/* usleep() must actually suspend under the block-FS backend (no JSPI). */
#include <stdio.h>
#include <unistd.h>
#include <sys/time.h>

int main(void) {
    struct timeval t0, t1;
    gettimeofday(&t0, 0);
    int ret = usleep(50000);
    gettimeofday(&t1, 0);
    long elapsed_us = (t1.tv_sec - t0.tv_sec) * 1000000L + (t1.tv_usec - t0.tv_usec);
    printf("ret: %d\n", ret);
    /* One-sided ON PURPOSE (todos/0361). The lower bound IS the property
       ("the sleep really suspends") and is contention-monotone: load can
       only make elapsed_us larger, so it cannot go red because the box is
       busy. The upper bound it used to carry (`< 500000`) was the opposite
       — a statement about the machine — and it bought nothing the runner
       does not already give: a 1000x oversleep is 50 s, well past
       run-unit.js's 30 s per-test timeout. The exact requested duration is
       pinned without any clock in tests/host/test_sleep_clamp.js. */
    printf("elapsed_ok: %d\n", elapsed_us >= 40000);
    return 0;
}
