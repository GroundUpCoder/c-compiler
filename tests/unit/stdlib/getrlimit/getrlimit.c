#include <stdio.h>
#include <sys/resource.h>

int main(void) {
    struct rlimit rl;
    int r = getrlimit(RLIMIT_NOFILE, &rl);
    printf("r=%d cur_inf=%d max_inf=%d\n",
           r, rl.rlim_cur == RLIM_INFINITY, rl.rlim_max == RLIM_INFINITY);

    rl.rlim_cur = 100;
    rl.rlim_max = 200;
    printf("set=%d\n", setrlimit(RLIMIT_NOFILE, &rl));

    struct rusage ru;
    int g = getrusage(RUSAGE_SELF, &ru);
    printf("rusage=%d maxrss=%ld utime=%ld stime=%ld\n",
           g, ru.ru_maxrss, (long)ru.ru_utime.tv_sec, (long)ru.ru_stime.tv_sec);
    return 0;
}
