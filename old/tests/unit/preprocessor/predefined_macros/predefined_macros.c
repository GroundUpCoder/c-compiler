#include <stdio.h>

int main(void) {
    // Target identification
#ifdef __wasm__
    printf("__wasm__ defined\n");
#endif
#ifdef __wasm32__
    printf("__wasm32__ defined\n");
#endif

    // Data model
#ifdef __ILP32__
    printf("__ILP32__ defined\n");
#endif

    // Endianness
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    printf("little endian\n");
#elif __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    printf("big endian\n");
#else
    printf("unknown endian\n");
#endif
#ifdef __LITTLE_ENDIAN__
    printf("__LITTLE_ENDIAN__ defined\n");
#endif

    // Type sizes
    _Static_assert(__SIZEOF_SHORT__ == 2, "short");
    _Static_assert(__SIZEOF_INT__ == 4, "int");
    _Static_assert(__SIZEOF_LONG__ == 4, "long");
    _Static_assert(__SIZEOF_LONG_LONG__ == 8, "long long");
    _Static_assert(__SIZEOF_FLOAT__ == 4, "float");
    _Static_assert(__SIZEOF_DOUBLE__ == 8, "double");
    _Static_assert(__SIZEOF_POINTER__ == 4, "pointer");
    _Static_assert(__SIZEOF_SIZE_T__ == 4, "size_t");
    _Static_assert(__SIZEOF_PTRDIFF_T__ == 4, "ptrdiff_t");
    printf("all __SIZEOF_*__ macros correct\n");

    // Standard C
    printf("__STDC__ = %d\n", __STDC__);
    printf("__STDC_VERSION__ = %ld\n", __STDC_VERSION__);

    return 0;
}
