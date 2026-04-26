#include <stdio.h>
#include <stdint.h>

int main(void) {
    // Test exact-width types
    _Static_assert(sizeof(int8_t) == 1, "int8_t");
    _Static_assert(sizeof(uint8_t) == 1, "uint8_t");
    _Static_assert(sizeof(int16_t) == 2, "int16_t");
    _Static_assert(sizeof(uint16_t) == 2, "uint16_t");
    _Static_assert(sizeof(int32_t) == 4, "int32_t");
    _Static_assert(sizeof(uint32_t) == 4, "uint32_t");
    _Static_assert(sizeof(int64_t) == 8, "int64_t");
    _Static_assert(sizeof(uint64_t) == 8, "uint64_t");

    // Test minimum-width types (must be at least as wide)
    _Static_assert(sizeof(int_least8_t) >= 1, "int_least8_t");
    _Static_assert(sizeof(int_least16_t) >= 2, "int_least16_t");
    _Static_assert(sizeof(int_least32_t) >= 4, "int_least32_t");
    _Static_assert(sizeof(int_least64_t) >= 8, "int_least64_t");

    // Test fast types
    _Static_assert(sizeof(int_fast8_t) >= 1, "int_fast8_t");
    _Static_assert(sizeof(int_fast16_t) >= 2, "int_fast16_t");
    _Static_assert(sizeof(int_fast32_t) >= 4, "int_fast32_t");
    _Static_assert(sizeof(int_fast64_t) >= 8, "int_fast64_t");

    // Test pointer types
    _Static_assert(sizeof(intptr_t) == sizeof(void*), "intptr_t");
    _Static_assert(sizeof(uintptr_t) == sizeof(void*), "uintptr_t");

    // Test max types
    _Static_assert(sizeof(intmax_t) == 8, "intmax_t");
    _Static_assert(sizeof(uintmax_t) == 8, "uintmax_t");

    // Test constant macros
    int64_t a = INT64_C(9223372036854775807);
    uint64_t b = UINT64_C(18446744073709551615);
    intmax_t c = INTMAX_C(123);
    uintmax_t d = UINTMAX_C(456);

    // Test limit macros
    _Static_assert(INT8_MAX == 127, "INT8_MAX");
    _Static_assert(UINT8_MAX == 255, "UINT8_MAX");
    _Static_assert(INT16_MAX == 32767, "INT16_MAX");
    _Static_assert(UINT16_MAX == 65535, "UINT16_MAX");
    _Static_assert(INT32_MAX == 2147483647, "INT32_MAX");
    _Static_assert(SIZE_MAX == UINT32_MAX, "SIZE_MAX");
    _Static_assert(PTRDIFF_MAX == INT32_MAX, "PTRDIFF_MAX");

    printf("All stdint.h types and macros work!\n");
    return 0;
}
