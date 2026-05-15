// 64-bit bit-field packing: same-storage-unit packing, new-unit on overflow,
// alignment, and sizeof. Multiple sub-fields packed into one u64.
#include <stdio.h>

struct A {
    unsigned long long lo : 32;
    unsigned long long mid : 16;
    unsigned long long hi : 16;   // total = 64, fits one u64
};

struct B {
    unsigned long long a : 40;
    unsigned long long b : 30;    // 70 bits — needs a second u64
};

struct C {
    unsigned long long x : 5;
    unsigned long long y : 5;
    unsigned long long z : 5;     // 15 bits — fits one u64
};

int main(void) {
    printf("sizeof_A=%d\n", (int)sizeof(struct A));
    printf("sizeof_B=%d\n", (int)sizeof(struct B));
    printf("sizeof_C=%d\n", (int)sizeof(struct C));

    struct A a;
    a.lo = 0xDEADBEEFu;
    a.mid = 0xABCD;
    a.hi  = 0x1234;
    printf("A: lo=%llx mid=%llx hi=%llx\n",
           (unsigned long long)a.lo, (unsigned long long)a.mid, (unsigned long long)a.hi);

    struct B b;
    b.a = 0xFFFFFFFFFFull;   // 40 bits set
    b.b = 0x3FFFFFFFu;        // 30 bits set
    printf("B: a=%llx b=%llx\n", (unsigned long long)b.a, (unsigned long long)b.b);

    // Modify one, check the other survives.
    b.a = 0x123456789Aull;
    printf("after_b_a_change: a=%llx b=%llx\n",
           (unsigned long long)b.a, (unsigned long long)b.b);

    struct C c;
    c.x = 1; c.y = 2; c.z = 3;
    printf("C: x=%llu y=%llu z=%llu\n",
           (unsigned long long)c.x, (unsigned long long)c.y, (unsigned long long)c.z);
    return 0;
}
