/* Test that va_end evaluates its argument for side effects.
 * Previously, va_end was a pure no-op that discarded the argument
 * expression entirely, losing side effects like function calls. */
#include <stdio.h>
#include <stdarg.h>

static int call_count = 0;

static va_list *get_ap(va_list *p) {
    call_count++;
    return p;
}

void f(int n, ...) {
    va_list ap;
    va_start(ap, n);
    int val = va_arg(ap, int);
    /* The get_ap call is a side effect that must be emitted */
    va_end(*get_ap(&ap));
    printf("val=%d count=%d\n", val, call_count);
}

int main(void) {
    f(1, 42);
    if (call_count != 1) return 1;
    printf("OK\n");
    return 0;
}
