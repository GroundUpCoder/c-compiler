/* Test that character constants work in #if expressions (C99 §6.10.1) */
#include <stdio.h>

#if 'a' != 97
#error 'a' should be 97
#endif

#if '\n' != 10
#error '\n' should be 10
#endif

#if '\0' != 0
#error '\0' should be 0
#endif

#if '\\' != 92
#error '\\' should be 92
#endif

#if '\t' != 9
#error '\t' should be 9
#endif

/* Octal escape */
#if '\377' != 255
#error '\377' should be 255
#endif

#if '\100' != 64
#error '\100' should be 64
#endif

/* Bitwise NOT in #if */
#if ~0 != -1
#error ~0 should be -1
#endif

#if ~1 != -2
#error ~1 should be -2
#endif

int main(void) {
    printf("OK\n");
    return 0;
}
