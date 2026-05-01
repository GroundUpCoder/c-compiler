#include <stdio.h>
#include <stdalign.h>
#include <stddef.h>

// Test _Alignas on struct members
struct AlignedStruct {
    char c;
    _Alignas(8) int x;  // x should be at offset 8, not 4
};

struct AlignedStruct2 {
    char c;
    _Alignas(4) char d;  // d should be at offset 4
};

// Test _Alignas with type argument
struct AlignedByType {
    char c;
    _Alignas(double) int x;  // aligned like double (8)
};

// Test _Alignas on global variable
_Alignas(8) int g_aligned;

// Test struct alignment propagation
// Struct alignment should be max(member alignments)
struct BigAlign {
    _Alignas(8) char c;
};

int main(void) {
    // Struct member alignment effects
    printf("AlignedStruct size: %lu\n", (unsigned long)sizeof(struct AlignedStruct));
    printf("AlignedStruct align: %lu\n", (unsigned long)alignof(struct AlignedStruct));
    printf("AlignedStruct.x offset: %lu\n", (unsigned long)offsetof(struct AlignedStruct, x));

    printf("AlignedStruct2 size: %lu\n", (unsigned long)sizeof(struct AlignedStruct2));
    printf("AlignedStruct2.d offset: %lu\n", (unsigned long)offsetof(struct AlignedStruct2, d));

    printf("AlignedByType size: %lu\n", (unsigned long)sizeof(struct AlignedByType));
    printf("AlignedByType.x offset: %lu\n", (unsigned long)offsetof(struct AlignedByType, x));

    // Struct alignment propagation
    printf("BigAlign size: %lu\n", (unsigned long)sizeof(struct BigAlign));
    printf("BigAlign align: %lu\n", (unsigned long)alignof(struct BigAlign));

    // _Alignas on local variable - check alignment is correct via address
    _Alignas(8) char local_buf[32];
    unsigned long addr = (unsigned long)local_buf;
    printf("local aligned: %d\n", (addr % 8) == 0);

    // stdalign.h macro
    alignas(8) int y;
    (void)y;
    printf("stdalign works\n");

    return 0;
}
