// Test: qualifiers must not affect usual arithmetic conversions (C99 §6.3.1.8)
// const double op const double → double, not float
#include <stdio.h>

int main(void) {
    const double a = 3.14;
    const double b = 2.72;

    // binary arithmetic
    double r1 = a / b;
    printf("a / b = %f\n", r1);

    // ternary
    int cond = 1;
    double r2 = cond ? a : b;
    printf("ternary = %f\n", r2);

    // comparison (implicit cast annotation)
    if (a > b) printf("a > b\n");

    // compound assignment with const operand
    double x = 1.0;
    const double inc = 0.5;
    x += inc;
    printf("x += inc = %f\n", x);

    // mixed const double and int
    const double d = 10.0;
    int i = 3;
    double r3 = d + i;
    printf("d + i = %f\n", r3);

    // const float + const double ranking
    const float f = 1.5f;
    const double g = 2.5;
    double r4 = f + g;
    printf("f + g = %f\n", r4);

    return 0;
}
