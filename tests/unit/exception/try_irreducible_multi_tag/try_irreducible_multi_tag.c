// Single try with three catch clauses (three distinct tags) inside a
// function forced into irreducible lowering. Verifies the per-tag
// catch-clause emission in the wrapper and the parent-walk dispatcher.

#include <stdio.h>

__exception A1(int);
__exception A2(int, int);
__exception A3();

static int events;
static void log_event(int code) { events = events * 10 + code; }

static int run(int mode) {
    events = 0;
    log_event(1);
    __try {
        int i = 3;
        goto inside;  // irreducible: goto into loop body
        while (i > 0) {
            i--;
            inside:
            log_event(2);
            if (mode == 1) __throw A1(11);
            if (mode == 2) __throw A2(22, 33);
            if (mode == 3) __throw A3();
        }
        log_event(3);
        return 0;
    } __catch A1(v) {
        log_event(4);
        return v;
    } __catch A2(a, b) {
        log_event(5);
        return a + b;
    } __catch A3() {
        log_event(6);
        return -1;
    }
}

int main(void) {
    printf("noop: r=%d ev=%d\n", run(0), events);
    printf("A1:   r=%d ev=%d\n", run(1), events);
    printf("A2:   r=%d ev=%d\n", run(2), events);
    printf("A3:   r=%d ev=%d\n", run(3), events);
    return 0;
}
