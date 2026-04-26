/* Test __minstack intrinsic: request minimum 256KB stack.
 * Without this, 128KB of stack-allocated arrays would overflow
 * the default 64KB stack. */
#include <stdio.h>
#include <string.h>

__minstack(256 * 1024);

int main(void) {
    char buf[128 * 1024];
    memset(buf, 'X', sizeof(buf));
    buf[sizeof(buf) - 1] = '\0';
    printf("%d\n", (int)strlen(buf));
    return 0;
}
