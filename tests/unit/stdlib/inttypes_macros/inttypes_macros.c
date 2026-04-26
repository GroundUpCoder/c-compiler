#include <stdio.h>
#include <inttypes.h>

int main(void) {
    int32_t i32 = 42;
    uint64_t u64 = 18446744073709551615ULL;
    intmax_t imax = -123;
    uintmax_t umax = 456;

    // Test PRId/PRIu macros
    printf("i32 = %" PRId32 "\n", i32);
    printf("u64 = %" PRIu64 "\n", u64);
    printf("imax = %" PRIdMAX "\n", imax);
    printf("umax = %" PRIuMAX "\n", umax);

    // Test hex macros
    printf("u64 hex = %" PRIx64 "\n", u64);
    printf("u64 HEX = %" PRIX64 "\n", u64);

    // Test imaxabs/imaxdiv
    printf("imaxabs(-100) = %" PRIdMAX "\n", imaxabs(-100));
    imaxdiv_t result = imaxdiv(17, 5);
    printf("imaxdiv(17,5) = %" PRIdMAX ", %" PRIdMAX "\n", result.quot, result.rem);

    // Test strtoimax/strtoumax
    printf("strtoimax = %" PRIdMAX "\n", strtoimax("-999", 0, 10));
    printf("strtoumax = %" PRIuMAX "\n", strtoumax("999", 0, 10));

    return 0;
}
