// Struct with mixed 32-bit and 64-bit bit-fields. They go in different
// storage units (different declared types — `unsigned int` vs
// `unsigned long long`).
#include <stdio.h>

struct S {
    unsigned int a32 : 7;
    unsigned int b32 : 25;     // a32+b32 fills one u32
    unsigned long long c64 : 33;
    unsigned long long d64 : 17;
    unsigned int e32 : 12;
    unsigned long long f64 : 60;
};

int main(void) {
    printf("sizeof_S=%d\n", (int)sizeof(struct S));

    struct S s;
    s.a32 = 0x7F;
    s.b32 = 0x1FFFFFF;
    s.c64 = 0x1FFFFFFFFull;
    s.d64 = 0x1FFFF;
    s.e32 = 0xFFF;
    s.f64 = 0xFFFFFFFFFFFFFFFull;

    printf("a32=0x%x b32=0x%x e32=0x%x\n", s.a32, s.b32, s.e32);
    printf("c64=0x%llx d64=0x%llx f64=0x%llx\n",
           (unsigned long long)s.c64,
           (unsigned long long)s.d64,
           (unsigned long long)s.f64);

    // Modify only one — verify others survive
    s.c64 = 42;
    printf("after_c=42: a32=0x%x b32=0x%x c64=%llu d64=0x%llx e32=0x%x f64=0x%llx\n",
           s.a32, s.b32,
           (unsigned long long)s.c64,
           (unsigned long long)s.d64,
           s.e32,
           (unsigned long long)s.f64);
    return 0;
}
