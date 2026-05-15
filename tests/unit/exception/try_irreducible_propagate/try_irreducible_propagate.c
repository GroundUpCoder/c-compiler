// An irreducible function throws an unhandled tag (no catch matches);
// the exception propagates out and is caught by the caller's try. Tests
// that the per-tag catch dispatcher's "rethrow" path correctly returns
// the exception's args (carried through the temp bindings).

#include <stdio.h>

__exception Boom(int);
__exception Bang(int);

static int events;
static void log_event(int code) { events = events * 10 + code; }

// Catches Bang locally, lets Boom escape.
static int inner(int mode) {
    events = 0;
    log_event(1);
    __try {
        int i = 2;
        goto inside;   // irreducible
        while (i > 0) {
            i--;
            inside:
            log_event(2);
            if (mode == 1) __throw Boom(77);  // not caught here — escapes
            if (mode == 2) __throw Bang(88);  // caught
        }
        log_event(3);
        return 0;
    } __catch Bang(v) {
        log_event(4);
        return v;
    }
}

int main(void) {
    int r;

    r = inner(0); printf("noop: r=%d ev=%d\n", r, events);
    r = inner(2); printf("Bang: r=%d ev=%d\n", r, events);

    // Boom escapes inner — caught here.
    __try {
        r = inner(1);
        printf("Boom: <unreached>\n");
    } __catch Boom(v) {
        printf("Boom: caught at outer v=%d ev=%d\n", v, events);
    }
    return 0;
}
