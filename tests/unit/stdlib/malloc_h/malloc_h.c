#include <stdio.h>
#include <string.h>
#include <malloc.h>

int main(void) {
    char *p = malloc(32);              /* malloc.h forwards to <stdlib.h> */
    strcpy(p, "via malloc.h");
    printf("%s\n", p);
    printf("mallopt=%d\n", mallopt(M_TRIM_THRESHOLD, 4096));
    printf("trim=%d\n", malloc_trim(0));
    printf("usable=%lu\n", malloc_usable_size(p));
    free(p);
    return 0;
}
