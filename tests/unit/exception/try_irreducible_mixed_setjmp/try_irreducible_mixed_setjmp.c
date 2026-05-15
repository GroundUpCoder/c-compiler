// Function uses both setjmp/longjmp AND a native try/catch in the same
// irreducible body. Native and setjmp share the dispatcher: __LongJump
// (from setjmp lowering) is just another tag in the per-tag catch.

#include <stdio.h>
#include <setjmp.h>

__exception NativeErr(int);

static jmp_buf nlr;
static int events;
static void log_event(int code) { events = events * 10 + code; }

static int run(int mode) {
    events = 0;
    log_event(1);
    if (setjmp(nlr) == 0) {
        log_event(2);
        int i = 2;
        goto inside;            // irreducible
        while (i > 0) {
            i--;
            inside:
            log_event(3);
            __try {
                if (mode == 1) longjmp(nlr, 41);            // unwinds the setjmp
                if (mode == 2) __throw NativeErr(42);       // caught locally
            } __catch NativeErr(v) {
                log_event(4);
                return v;
            }
        }
        log_event(5);
        return 0;
    } else {
        log_event(6);
        return 99;
    }
}

int main(void) {
    int r;
    r = run(0); printf("noop: r=%d ev=%d\n", r, events);
    r = run(1); printf("lj:   r=%d ev=%d\n", r, events);
    r = run(2); printf("nat:  r=%d ev=%d\n", r, events);
    return 0;
}
