#include <stdio.h>

int main() {
    // float += double: must promote to double for the add, then demote
    float a = 12.34;
    a += 56.78;
    printf("%f\n", a);

    // float -= double
    a = 12.34;
    a -= 56.78;
    printf("%f\n", a);

    // float *= double
    a = 12.34;
    a *= 56.78;
    printf("%f\n", a);

    // float /= double
    a = 12.34;
    a /= 56.78;
    printf("%f\n", a);

    // Via pointer: *p += double
    float b = 12.34;
    float *p = &b;
    *p += 56.78;
    printf("%f\n", b);

    // Via array subscript: arr[i] += double
    float arr[2] = {12.34, 0.0};
    arr[0] += 56.78;
    printf("%f\n", arr[0]);

    // Via struct member: s.f += double
    struct { float f; } s;
    s.f = 12.34;
    s.f += 56.78;
    printf("%f\n", s.f);

    // Via struct pointer: sp->f += double
    struct { float f; } s2;
    s2.f = 12.34;
    struct { float f; } *sp = &s2;
    sp->f += 56.78;
    printf("%f\n", s2.f);

    return 0;
}
