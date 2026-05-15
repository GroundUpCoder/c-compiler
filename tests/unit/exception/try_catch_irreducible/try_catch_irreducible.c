// Native try/catch inside a function that also needs irreducible
// lowering: covers the general (non-setjmp) path through the hoisted
// physical try/catch + handler-region dispatcher.

#include <stdio.h>

__exception ErrA(int);
__exception ErrB(int);

static int events;
static void log_event(int code) { events = events * 10 + code; }

// Goto-into-loop forces irreducible lowering; the try/catches inside
// exercise the per-segment handler stamping + multi-tag dispatcher.
static int run(int mode) {
    events = 0;
    log_event(1);
    __try {
        log_event(2);
        int i = 3;
        goto inside;
        while (i > 0) {
            i--;
            inside:
            log_event(3);
            if (mode == 1 && i == 2) __throw ErrA(91);
            if (mode == 2 && i == 1) __throw ErrB(92);
            if (mode == 3) {
                // Nested try: throws here are caught by inner, rethrown to outer.
                __try {
                    log_event(4);
                    __throw ErrA(93);
                } __catch ErrA(v) {
                    log_event(5);
                    __throw ErrB(v + 1);   // propagates to outer catch ErrB(v)
                }
            }
        }
        log_event(6);
    } __catch ErrA(v) {
        log_event(7);
        return v;
    } __catch ErrB(v) {
        log_event(8);
        return v;
    }
    log_event(9);
    return 0;
}

int main(void) {
    int r;
    r = run(0); printf("noop:  r=%d events=%d\n", r, events);
    r = run(1); printf("ErrA:  r=%d events=%d\n", r, events);
    r = run(2); printf("ErrB:  r=%d events=%d\n", r, events);
    r = run(3); printf("nest:  r=%d events=%d\n", r, events);
    return 0;
}
