#include <stdio.h>
#include <string.h>

/* extern declaration with incomplete const char array */
extern const char greeting[];

/* definition with string literal initializer — must preserve const */
const char greeting[] = "Hello, world!";

/* Same pattern but with static */
static const char secret[] = "hidden";

/* Multiple extern + definition pairs */
extern const char msg1[];
extern const char msg2[];
const char msg1[] = "first";
const char msg2[] = "second";

int main(void) {
    printf("%s\n", greeting);
    printf("%zu\n", sizeof(greeting));  /* 14 including null */
    printf("%s\n", secret);
    printf("%s\n", msg1);
    printf("%s\n", msg2);

    /* Verify they work with string functions */
    printf("%d\n", strcmp(greeting, "Hello, world!") == 0);
    printf("%d\n", strlen(msg1) == 5);

    return 0;
}
