#include <stdio.h>
#include <time.h>

int main(void) {
    struct timespec ts;
    int ret = clock_gettime(CLOCK_MONOTONIC, &ts);
    printf("ret: %d\n", ret);
    printf("sec_ok: %d\n", ts.tv_sec >= 0);
    printf("nsec_ok: %d\n", ts.tv_nsec >= 0 && ts.tv_nsec < 1000000000L);
    return 0;
}
