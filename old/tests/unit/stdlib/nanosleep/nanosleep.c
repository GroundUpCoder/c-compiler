#include <stdio.h>
#include <time.h>
#include <sys/time.h>

int main(void) {
    struct timeval t0, t1;
    struct timespec req;
    req.tv_sec = 0;
    req.tv_nsec = 50000000L;
    gettimeofday(&t0, 0);
    int ret = nanosleep(&req, 0);
    gettimeofday(&t1, 0);
    long elapsed_us = (t1.tv_sec - t0.tv_sec) * 1000000L + (t1.tv_usec - t0.tv_usec);
    printf("ret: %d\n", ret);
    printf("elapsed_ok: %d\n", elapsed_us >= 40000 && elapsed_us < 500000);
    return 0;
}
