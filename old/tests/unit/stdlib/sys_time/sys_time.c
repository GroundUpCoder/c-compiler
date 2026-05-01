#include <stdio.h>
#include <sys/time.h>

int main(void) {
    struct timeval tv;
    int ret = gettimeofday(&tv, (void *)0);
    printf("ret: %d\n", ret);
    /* tv_sec should be a reasonable unix timestamp (after 2020 = 1577836800) */
    printf("sec_ok: %d\n", tv.tv_sec > 1577836800L);
    /* tv_usec should be in [0, 999999] */
    printf("usec_ok: %d\n", tv.tv_usec >= 0 && tv.tv_usec < 1000000);
    return 0;
}
