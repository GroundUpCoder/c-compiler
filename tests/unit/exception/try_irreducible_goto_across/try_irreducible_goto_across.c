// Cross-region gotos inside an irreducible function with try/catch:
//   - goto from outside any try → label inside another try's body
//     (control enters the try mid-body; throws there go to that try's catch).
//   - mode=0/1 also exercise the goto-into-loop irreducibility trigger.
// Verifies that per-segment handler stamping correctly reflects where each
// label was *lexically* defined, not where gotos enter from.

#include <stdio.h>

__exception Err(int);

static int events;
static void log_event(int code) { events = events * 10 + code; }

static int run(int mode) {
    events = 0;
    log_event(1);
    int i = 2;
    goto inside;        // irreducible trigger
    while (i > 0) {
        i--;
        inside:
        log_event(2);
        if (mode == 1) goto entry_b;   // jump into try B's body from outside any try
        __try {
            log_event(3);
            if (mode == 2) __throw Err(20);
        } __catch Err(v) {
            log_event(4);
            return 100 + v;
        }
        __try {
            entry_b:
            log_event(5);
            __throw Err(30);
        } __catch Err(v) {
            log_event(6);
            return 200 + v;
        }
    }
    log_event(9);
    return 0;
}

int main(void) {
    printf("noop:  r=%d ev=%d\n", run(0), events);  // falls into try B, throws, caught: 230
    printf("goto:  r=%d ev=%d\n", run(1), events);  // jumps into B mid-body, throws, caught: 230
    printf("throw: r=%d ev=%d\n", run(2), events);  // throws in try A, caught: 120
    return 0;
}
