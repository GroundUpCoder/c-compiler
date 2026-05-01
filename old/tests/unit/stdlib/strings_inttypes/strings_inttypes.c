#include <stdio.h>
#include <inttypes.h>
#include <strings.h>

int main() {
    // strcasecmp
    printf("strcasecmp equal: %d\n", strcasecmp("Hello", "hello") == 0);
    printf("strcasecmp less: %d\n", strcasecmp("abc", "abd") < 0);
    printf("strcasecmp greater: %d\n", strcasecmp("abd", "abc") > 0);
    printf("strcasecmp empty: %d\n", strcasecmp("", "") == 0);
    printf("strcasecmp shorter: %d\n", strcasecmp("ab", "abc") < 0);

    // strncasecmp
    printf("strncasecmp prefix: %d\n", strncasecmp("Hello", "HELP", 3) == 0);
    printf("strncasecmp differ: %d\n", strncasecmp("Hello", "HELP", 4) != 0);
    printf("strncasecmp zero: %d\n", strncasecmp("abc", "xyz", 0) == 0);

    // PRI macros
    int32_t i32 = -100;
    int64_t i64 = -200;
    uint32_t u32 = 300;
    uint64_t u64 = 400;
    printf("PRId32: %" PRId32 "\n", i32);
    printf("PRId64: %" PRId64 "\n", i64);
    printf("PRIu32: %" PRIu32 "\n", u32);
    printf("PRIu64: %" PRIu64 "\n", u64);
    printf("PRIx32: %" PRIx32 "\n", u32);
    printf("PRIX64: %" PRIX64 "\n", u64);

    // intmax_t
    intmax_t mx = -999;
    uintmax_t umx = 999;
    printf("PRIdMAX: %" PRIdMAX "\n", mx);
    printf("PRIuMAX: %" PRIuMAX "\n", umx);

    return 0;
}
