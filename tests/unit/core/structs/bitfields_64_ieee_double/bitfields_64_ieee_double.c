// IEEE 754 double layout via 64-bit bit-fields. This is the exact
// pattern MicroPython's mp_float_union_t uses (sign:1, exp:11, frc:52).
// We avoid %g/%f for portability; everything is checked at the bit level.
#include <stdio.h>

typedef union {
    double f;
    struct {
        unsigned long long frc : 52;
        unsigned long long exp : 11;
        unsigned long long sgn : 1;
    } p;
    unsigned long long i;
} float_union_t;

static void show_bits(const char *label, float_union_t u) {
    printf("%s sgn=%llu exp=%llu frc=0x%llx i=0x%llx\n",
           label,
           (unsigned long long)u.p.sgn,
           (unsigned long long)u.p.exp,
           (unsigned long long)u.p.frc,
           (unsigned long long)u.i);
}

int main(void) {
    float_union_t u;
    printf("sizeof_union=%d\n", (int)sizeof(float_union_t));

    // Build doubles from known bit patterns and read the fields back.
    u.i = 0x0000000000000000ull;  // +0.0
    show_bits("zero", u);
    u.i = 0x3FF0000000000000ull;  // 1.0
    show_bits("one", u);
    u.i = 0xBFF0000000000000ull;  // -1.0
    show_bits("neg_one", u);
    u.i = 0x4000000000000000ull;  // 2.0
    show_bits("two", u);
    u.i = 0x3FE0000000000000ull;  // 0.5
    show_bits("half", u);
    u.i = 0x4010000000000000ull;  // 4.0
    show_bits("four", u);

    // Set bits by hand via .p — should agree with .i.
    u.p.sgn = 1;
    u.p.exp = 1024;
    u.p.frc = 0x4000000000000ull;
    printf("hand-set i=0x%llx\n", (unsigned long long)u.i);

    // Modify just one field, others must survive.
    u.i = 0x3FF0000000000000ull;  // 1.0
    u.p.sgn = 1;                  // flip sign
    printf("flipped i=0x%llx\n", (unsigned long long)u.i);

    u.i = 0x3FF0000000000000ull;
    u.p.exp = 0x7FF;              // +inf (frc=0)
    printf("to_inf i=0x%llx\n", (unsigned long long)u.i);
    return 0;
}
