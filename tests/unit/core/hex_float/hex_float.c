#include <stdio.h>

int main() {
    // Basic hex float
    printf("%f\n", 0x1.0p0);
    // Hex digit after dot
    printf("%f\n", 0x1.8p0);
    // Negative exponent
    printf("%f\n", 0x1.0p-1);
    // Positive exponent
    printf("%f\n", 0x1.0p10);
    // Explicit + in exponent
    printf("%f\n", 0x1.0p+10);
    // Uppercase P
    printf("%f\n", 0x1.0P10);
    // No fractional part
    printf("%f\n", 0x1p10);
    printf("%f\n", 0x1p-1);
    // Hex digits in significand
    printf("%f\n", 0xA.0p0);
    printf("%f\n", 0xFF.0p0);
    // Float suffix
    printf("%f\n", (double)0x1.0p0f);
    printf("%f\n", (double)0xA.0p0f);
    return 0;
}
