/* Bug: character array initialized with a shorter string literal
 * does not zero the remaining elements.
 *
 * Per C99 §6.7.8p21: "If there are fewer initializers in a brace-
 * enclosed list than there are elements ... the remainder of the
 * aggregate shall be initialized implicitly the same as objects
 * that have static storage duration."
 *
 * So `char s[2] = ""` should set s[0]='\0' and s[1]='\0'.
 *
 * From GCC torture test: 20000801-4.c (PR c/128)
 */
#include <stdio.h>

int test_empty_string(void) {
    char s[2] = "";
    printf("s[0]=%d s[1]=%d\n", s[0], s[1]);
    return s[0] == 0 && s[1] == 0;
}

int test_short_string(void) {
    char s[4] = "ab";
    printf("s[0]=%d s[1]=%d s[2]=%d s[3]=%d\n", s[0], s[1], s[2], s[3]);
    return s[0] == 'a' && s[1] == 'b' && s[2] == 0 && s[3] == 0;
}

int main(void) {
    if (!test_empty_string()) {
        printf("FAIL empty\n");
        return 1;
    }
    if (!test_short_string()) {
        printf("FAIL short\n");
        return 1;
    }
    printf("OK\n");
    return 0;
}
