// Regression test: `setjmp` invoked inside a comma expression (as the
// last operand of the comma). The setjmp-lowering pass must preserve
// the comma's leading side-effect-producing operands, not just the
// setjmp call.
//
// This is the MicroPython `nlr_push` pattern in miniature:
//   #define nlr_push(buf) (nlr_push_tail(buf), setjmp((buf)->jmpbuf))
//
// Before the fix, lowering threw away `nlr_push_tail(buf)` — so its
// thread-local "push the new buf" side effect was silently dropped,
// and subsequent longjmp landed on a stale buf, hitting the fatal
// `while (1)` in nlr_jump_fail.

#include <stdio.h>
#include <setjmp.h>

static jmp_buf buf;
static int side_effect_count;
static int trace;

static int push(int *bufptr) {
    side_effect_count++;
    return 0;  // value irrelevant — only the side effect matters
}

int main(void) {
    trace = 0;
    // setjmp wrapped inside a comma whose leading operand has a side effect.
    if ((push((int *)&buf), setjmp(buf)) == 0) {
        trace = trace * 10 + 1;
        longjmp(buf, 42);
        trace = trace * 10 + 9;  // unreachable
    } else {
        trace = trace * 10 + 2;
    }
    printf("side_effect_count=%d trace=%d\n", side_effect_count, trace);
    return 0;
}
