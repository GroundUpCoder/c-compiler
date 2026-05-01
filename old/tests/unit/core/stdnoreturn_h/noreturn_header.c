#include <stdio.h>
#include <stdlib.h>
#include <stdnoreturn.h>

// Using the 'noreturn' macro from stdnoreturn.h
noreturn void abort_now(void) {
    exit(1);
}

int main(void) {
    printf("stdnoreturn.h works\n");
    return 0;
}
