// Return inside a try body must skip the catch entirely (no implicit
// "exception" — it's just an early return). Tests that segment-level
// return terminators inside try regions don't trip the dispatcher.

#include <stdio.h>

__exception Err(int);

static int events;
static void log_event(int code) { events = events * 10 + code; }

static int run(int mode) {
    events = 0;
    log_event(1);
    __try {
        int i = 2;
        goto inside;
        while (i > 0) {
            i--;
            inside:
            log_event(2);
            if (mode == 1) {
                log_event(3);
                return 50;          // early return — catch must NOT fire
            }
            if (mode == 2) __throw Err(60);
        }
        log_event(4);
        return 70;
    } __catch Err(v) {
        log_event(5);
        return v;
    }
}

int main(void) {
    int r;
    r = run(0); printf("noop:   r=%d ev=%d\n", r, events);
    r = run(1); printf("return: r=%d ev=%d\n", r, events);  // catch never reached
    r = run(2); printf("throw:  r=%d ev=%d\n", r, events);
    return 0;
}
