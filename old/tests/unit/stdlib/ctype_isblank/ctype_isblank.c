#include <stdio.h>
#include <ctype.h>

int main(void) {
    // isblank returns true for space and horizontal tab only
    printf("isblank(' ') = %d\n", isblank(' ') ? 1 : 0);
    printf("isblank('\\t') = %d\n", isblank('\t') ? 1 : 0);
    printf("isblank('\\n') = %d\n", isblank('\n') ? 1 : 0);  // newline is NOT blank
    printf("isblank('a') = %d\n", isblank('a') ? 1 : 0);
    printf("isblank('0') = %d\n", isblank('0') ? 1 : 0);
    return 0;
}
