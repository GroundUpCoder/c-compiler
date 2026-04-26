/* Variadic functions with mixed int/double arguments */
#include <stdio.h>
#include <stdarg.h>

double va_sum_double(int count, ...) {
    va_list ap;
    va_start(ap, count);
    double total = 0.0;
    for (int i = 0; i < count; i++) {
        total += va_arg(ap, double);
    }
    va_end(ap);
    return total;
}

/* Alternating int, double, int, double, ... */
int va_mixed(int n, ...) {
    va_list ap;
    va_start(ap, n);
    int isum = 0;
    double dsum = 0.0;
    for (int i = 0; i < n; i++) {
        if (i % 2 == 0) isum += va_arg(ap, int);
        else dsum += va_arg(ap, double);
    }
    va_end(ap);
    return isum + (int)dsum;
}

int main(void) {
    double d = va_sum_double(3, 1.5, 2.5, 3.0);
    if (d != 7.0) { printf("FAIL: va_sum_double = %f\n", d); return 1; }

    /* int, double, int, double */
    int m = va_mixed(4, 10, 1.5, 20, 2.5);
    if (m != 34) { printf("FAIL: va_mixed = %d\n", m); return 1; }

    /* Many doubles */
    double big = va_sum_double(8, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0);
    if (big != 36.0) { printf("FAIL: va_sum_double(8) = %f\n", big); return 1; }

    printf("PASS\n");
    return 0;
}
