// Three levels of nested try/catch in an irreducible function.
// Verifies the parent-walk dispatcher: a throw with a tag the
// innermost regions don't catch must skip them and land at the
// outermost matching region.

#include <stdio.h>

__exception L1(int);
__exception L2(int);
__exception L3(int);

static int events;
static void log_event(int code) { events = events * 10 + code; }

static int run(int target) {
    events = 0;
    int i = 4;
    goto inside;          // irreducible trigger
    while (i > 0) {
        i--;
        inside:
        log_event(1);
        __try {
            log_event(2);
            __try {
                log_event(3);
                __try {
                    log_event(4);
                    if (target == 1) __throw L1(101);
                    if (target == 2) __throw L2(102);
                    if (target == 3) __throw L3(103);
                } __catch L3(v) {
                    log_event(5);
                    return v;
                }
            } __catch L2(v) {
                log_event(6);
                return v;
            }
        } __catch L1(v) {
            log_event(7);
            return v;
        }
        break;
    }
    return 0;
}

int main(void) {
    printf("L1: r=%d ev=%d\n", run(1), events);   // skips L3, L2 → L1
    printf("L2: r=%d ev=%d\n", run(2), events);   // skips L3 → L2
    printf("L3: r=%d ev=%d\n", run(3), events);   // innermost
    return 0;
}
