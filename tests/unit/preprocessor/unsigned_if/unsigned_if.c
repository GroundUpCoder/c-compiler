#include <stdio.h>

/* U suffix must produce unsigned semantics in #if */

#if ~0U > 0xffffU
#define TILDE_UNSIGNED 1
#else
#define TILDE_UNSIGNED 0
#endif

#if ~0U < 0
#define TILDE_NEGATIVE 1
#else
#define TILDE_NEGATIVE 0
#endif

#if 0xFFFFFFFFU > 0
#define HEX_U_POSITIVE 1
#else
#define HEX_U_POSITIVE 0
#endif

#if 1U - 2U > 0
#define WRAP_POSITIVE 1
#else
#define WRAP_POSITIVE 0
#endif

int main(void) {
    printf("~0U > 0xffffU: %d\n", TILDE_UNSIGNED);
    printf("~0U < 0: %d\n", TILDE_NEGATIVE);
    printf("0xFFFFFFFFU > 0: %d\n", HEX_U_POSITIVE);
    printf("1U - 2U > 0: %d\n", WRAP_POSITIVE);
    return 0;
}
