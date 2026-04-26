/* Test GNU named variadic macros: #define foo(args...) */
#include <stdio.h>
#include <string.h>

#define print1(args...) printf(args)
#define spr(buf, args...) sprintf(buf, args)

int main(void) {
    char buf[64];

    /* Single arg */
    print1("hello");
    printf("\n");

    /* Multiple args through named variadic */
    print1("%s %d\n", "world", 42);

    /* sprintf with multiple variadic args */
    spr(buf, "%s=%d", "x", 10);
    printf("%s\n", buf);

    spr(buf, "%d+%d=%d", 1, 2, 3);
    printf("%s\n", buf);

    /* Verify correct arg count with strcmp */
    spr(buf, "%c%c%c", 'a', 'b', 'c');
    if (strcmp(buf, "abc") != 0) return 1;

    printf("OK\n");
    return 0;
}
