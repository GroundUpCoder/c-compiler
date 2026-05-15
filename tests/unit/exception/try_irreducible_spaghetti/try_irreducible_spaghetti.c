// Spaghetti stress test: a single function with two nested try regions,
// a bytecode-style dispatch switch with cross-case gotos, a shared
// "error_handler" label inside the outer catch, gotos jumping into a
// loop body, and throws from inside both try-bodies and a catch handler.
// Mirrors the worst-case pattern from MicroPython's mp_execute_bytecode
// while staying small enough to trace by hand.

#include <stdio.h>
#include <setjmp.h>

__exception Halt(int);
__exception Trap(int);

static jmp_buf nlr;
static int events;
static void log_event(int code) { events = events * 10 + code; }

// "Program counter": consumed front-to-back from a small bytecode buffer.
static int prog[8];
static int pc;
static int read_op(void) { return prog[pc++]; }

static int execute(const int *p, int n, int via_longjmp) {
    events = 0;
    for (int i = 0; i < n; i++) prog[i] = p[i];
    prog[n] = 0;
    pc = 0;

    log_event(1);
    if (setjmp(nlr) == 0) {
        log_event(2);
        __try {
            int counter = 4;
            goto dispatch;  // irreducibility trigger #1: goto into loop body
            while (counter > 0) {
                counter--;
                dispatch:
                {
                    int op = read_op();
                    switch (op) {
                        case 1:
                            log_event(3);
                            break;
                        case 2: {
                            log_event(4);
                            // Cross-case goto: into case 4's nested label.
                            goto post_check;
                        }
                        case 3:
                            log_event(5);
                            __throw Trap(31);   // caught by inner try's catch
                        case 4:
                            log_event(6);
                            // Cross-case goto: into case 1's label area.
                            goto recheck;
                        post_check:
                            log_event(7);
                            // After the cross-case jump, throw if requested.
                            if (via_longjmp) longjmp(nlr, 81);  // unwinds the if(setjmp)
                            __throw Halt(91);  // not caught by inner — propagates to outer catch.
                        case 5:
                            log_event(8);
                            goto outer_handler;  // goto into the inner catch body
                        default:
                            log_event(9);
                            // Fall through to keep the loop spinning.
                            break;
                        recheck:
                            log_event(11);  // also reached via cross-case goto from case 4
                            break;
                    }
                }
            }
            log_event(12);
            return 1;
        } __catch Trap(v) {
            outer_handler:
            log_event(13);
            return 1000 + v;
        }
    } else {
        // setjmp's "else" branch — longjmp unwind handler.
        log_event(14);
        return 2000 + pc;
    }
}

int main(void) {
    // op=1 then default (0) → loop runs, exits normally.
    int p1[] = { 1, 1, 1, 1 };
    printf("p1:  r=%d ev=%d\n", execute(p1, 4, 0), events);

    // op=2 → jumps to post_check → __throw Halt(91) → escapes inner try
    //   (it only catches Trap), so caught at outer.
    int p2[] = { 2 };
    __try {
        printf("p2:  r=%d (unreached)\n", execute(p2, 1, 0));
    } __catch Halt(v) {
        printf("p2:  Halt at outer v=%d ev=%d\n", v, events);
    }

    // op=3 → throws Trap → caught by inner → goes to outer_handler label.
    int p3[] = { 3 };
    printf("p3:  r=%d ev=%d\n", execute(p3, 1, 0), events);

    // op=4 then op=1 → goto recheck (in case 4's tail) → log 11 → break →
    // continue loop → next op=1 → log 3 → break → continue → counter exhausts.
    int p4[] = { 4, 1, 1, 1 };
    printf("p4:  r=%d ev=%d\n", execute(p4, 4, 0), events);

    // op=5 → goto outer_handler → log 13 → return.
    int p5[] = { 5 };
    printf("p5:  r=%d ev=%d\n", execute(p5, 1, 0), events);

    // op=2 with via_longjmp=1 → goto post_check → longjmp → setjmp's else.
    int p6[] = { 2 };
    printf("p6:  r=%d ev=%d\n", execute(p6, 1, 1), events);

    return 0;
}
