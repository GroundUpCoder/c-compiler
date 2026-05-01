#include <stdio.h>
#include <stdlib.h>

// _Noreturn function declaration
_Noreturn void fatal(const char *msg);

// _Noreturn before return type
_Noreturn void fatal(const char *msg) {
    printf("Fatal: %s\n", msg);
    exit(1);
}

// _Noreturn with inline
_Noreturn inline void die(void) {
    exit(2);
}

// Multiple specifiers in different orders
static _Noreturn void unreachable(void) {
    exit(3);
}

int maybe_exit(int should_exit) {
    if (should_exit) {
        fatal("exiting");
    }
    return 0;
}

int main(void) {
    printf("_Noreturn is supported\n");
    int result = maybe_exit(0);
    printf("maybe_exit returned %d\n", result);
    return 0;
}
