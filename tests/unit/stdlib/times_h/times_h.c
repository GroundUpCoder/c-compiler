#include <stdio.h>
#include <sys/times.h>

int main(void) {
    struct tms t;
    clock_t r = times(&t);
    printf("nonneg=%d\n", r >= 0);
    printf("utime_eq_ret=%d\n", t.tms_utime == r);
    printf("stime=%ld cutime=%ld cstime=%ld\n",
           (long)t.tms_stime, (long)t.tms_cutime, (long)t.tms_cstime);
    return 0;
}
