// Mirrors mp_execute_bytecode's irreducible pattern: gotos between
// switch cases (one case enters another case's nested label) plus a
// setjmp-protected dispatch loop with longjmp-based error unwinding
// to a handler label inside the else branch.

#include <stdio.h>
#include <setjmp.h>

static jmp_buf nlr;
static int events;

static void log_event(int code) { events = events * 10 + code; }

static int execute(int op_a, int op_b, int trigger_error) {
    events = 0;
    int val = 0;
    if (setjmp(nlr) == 0) {
        log_event(1);
        // Dispatch two ops in sequence.
        for (int i = 0; i < 2; i++) {
            int op = (i == 0) ? op_a : op_b;
            switch (op) {
                case 1: {
                    // case 1 owns the `load_check` label (mirrors MicroPython's
                    // load_check / local_name_error chain inside a single ENTRY).
                    val = 42;
                load_check:
                    log_event(2);
                    if (trigger_error && val == 0) {
                        // longjmp to the catch
                        log_event(3);
                        longjmp(nlr, 7);
                    }
                    break;
                }
                case 2:
                    // case 2 reuses case 1's label — this is the irreducible edge.
                    log_event(4);
                    val = (i == 0) ? 0 : 99;  // i==0 path will trigger the error if trigger_error
                    goto load_check;
                default:
                    log_event(5);
                    break;
            }
        }
        log_event(6);
        return 1;
    } else {
        log_event(7);
        return 2;
    }
}

int main(void) {
    int r;
    // Normal: op 1 then op 2 (both reach load_check, no error)
    r = execute(1, 2, 0); printf("[1,2]:    r=%d events=%d\n", r, events);
    // op 2 first jumps into op 1's load_check; trigger error there
    r = execute(2, 1, 1); printf("[2,1]:    r=%d events=%d\n", r, events);
    // op 2 alone, no error
    r = execute(2, 2, 0); printf("[2,2]:    r=%d events=%d\n", r, events);
    return 0;
}
