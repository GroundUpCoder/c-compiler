#include <tgmath.h>
#include <stdio.h>

// Use sizeof to verify return type: float=4, double=8 on wasm32
#define CHECK_TYPE(expr, expected_size) \
    printf("%s: size=%d %s\n", #expr, (int)sizeof(expr), \
           (int)sizeof(expr) == expected_size ? "OK" : "FAIL")

int main(void) {
    float f = 2.0f;
    double d = 2.0;
    int i = 2;

    // === Unary: float arg -> float result ===
    CHECK_TYPE(sqrt(f), 4);
    CHECK_TYPE(fabs(f), 4);
    CHECK_TYPE(ceil(f), 4);
    CHECK_TYPE(floor(f), 4);
    CHECK_TYPE(sin(f), 4);
    CHECK_TYPE(exp(f), 4);
    CHECK_TYPE(log(f), 4);
    CHECK_TYPE(round(f), 4);

    // === Unary: double arg -> double result ===
    CHECK_TYPE(sqrt(d), 8);
    CHECK_TYPE(fabs(d), 8);
    CHECK_TYPE(ceil(d), 8);
    CHECK_TYPE(floor(d), 8);
    CHECK_TYPE(sin(d), 8);
    CHECK_TYPE(exp(d), 8);
    CHECK_TYPE(log(d), 8);
    CHECK_TYPE(round(d), 8);

    // === Unary: int arg -> double result (default) ===
    CHECK_TYPE(sqrt(i), 8);
    CHECK_TYPE(fabs(i), 8);

    // === Binary: both float -> float result ===
    CHECK_TYPE(pow(f, f), 4);
    CHECK_TYPE(fmin(f, f), 4);
    CHECK_TYPE(fmax(f, f), 4);
    CHECK_TYPE(fmod(f, f), 4);
    CHECK_TYPE(atan2(f, f), 4);
    CHECK_TYPE(hypot(f, f), 4);
    CHECK_TYPE(copysign(f, f), 4);
    CHECK_TYPE(nextafter(f, f), 4);
    CHECK_TYPE(fdim(f, f), 4);

    // === Binary: both double -> double result ===
    CHECK_TYPE(pow(d, d), 8);
    CHECK_TYPE(fmin(d, d), 8);
    CHECK_TYPE(fmax(d, d), 8);
    CHECK_TYPE(fmod(d, d), 8);

    // === Binary: mixed float/double -> double result ===
    // This is the critical test: if either arg is double, must use double variant
    CHECK_TYPE(pow(f, d), 8);
    CHECK_TYPE(pow(d, f), 8);
    CHECK_TYPE(fmin(f, d), 8);
    CHECK_TYPE(fmin(d, f), 8);
    CHECK_TYPE(fmax(f, d), 8);
    CHECK_TYPE(atan2(f, d), 8);
    CHECK_TYPE(atan2(d, f), 8);
    CHECK_TYPE(hypot(f, d), 8);
    CHECK_TYPE(copysign(f, d), 8);
    CHECK_TYPE(fdim(f, d), 8);

    // === Binary: int args -> double result (default) ===
    CHECK_TYPE(pow(i, i), 8);
    CHECK_TYPE(fmin(i, i), 8);

    // === ldexp: dispatch on first arg only (second is always int) ===
    CHECK_TYPE(ldexp(f, 2), 4);
    CHECK_TYPE(ldexp(d, 2), 8);

    // === Spot-check values ===
    printf("sqrt(2.0f) = %.6f\n", (double)sqrt(f));
    printf("sqrt(2.0)  = %.15f\n", sqrt(d));
    printf("pow(2.0f, 3.0f) = %.1f\n", (double)pow(f, 3.0f));
    printf("fmin(3.0f, 4.0) = %.1f\n", fmin(3.0f, 4.0));
    printf("floor(2.7f) = %.1f\n", (double)floor(2.7f));
    printf("ceil(2.3) = %.1f\n", ceil(2.3));

    return 0;
}
