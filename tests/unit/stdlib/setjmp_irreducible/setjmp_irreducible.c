// Exercises setjmp/longjmp inside a function that also needs irreducible
// lowering. Forces irreducibility with a goto INTO a loop body (an
// edge that the structured codegen cannot express without the
// loop-switch state machine).

#include <stdio.h>
#include <setjmp.h>

static jmp_buf buf;
static int events;

static void log_event(int code) {
    events = events * 10 + code;
}

static int run(int do_longjmp) {
    events = 0;
    log_event(1);
    if (setjmp(buf) == 0) {
        log_event(2);
        int i = 3;
        // Goto INTO the while-loop body — classic irreducible edge.
        goto inside;
        while (i > 0) {
            i--;
            inside:
            log_event(3);
            if (do_longjmp && i == 1) {
                log_event(4);
                longjmp(buf, 7);
            }
        }
        log_event(5);
        return 1;
    } else {
        log_event(6);
        return 2;
    }
}

int main(void) {
    int r;
    r = run(0); printf("noop:    r=%d events=%d\n", r, events);
    r = run(1); printf("longjmp: r=%d events=%d\n", r, events);
    return 0;
}
