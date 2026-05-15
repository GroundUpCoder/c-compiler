// Float-to-int conversion in C is undefined when the value won't fit
// (C99 §6.3.1.4) — real compilers don't crash on this. We use WASM's
// saturating opcodes by default: NaN → 0, value > max → IMAX, value
// < min → IMIN.
//
// (To opt in to the trapping behavior, compile with
//  --trapping-float-conversions; see float_to_int_trapping.)
#include <stdio.h>
#include <math.h>

int main(void) {
    // ---- in-range conversions ----
    printf("in_range_i32_s: %d\n", (int)3.7);          //  3
    printf("in_range_i32_s_neg: %d\n", (int)-3.7);     // -3
    printf("in_range_i32_u: %u\n", (unsigned)3.7);     //  3
    printf("in_range_i64_s: %lld\n", (long long)3.7);  //  3

    // ---- positive overflow (i32_s) ----
    printf("f64_to_i32_overflow: %d\n", (int)1e16);            // INT32_MAX
    printf("f32_to_i32_overflow: %d\n", (int)(float)1e16);     // INT32_MAX
    printf("f64_to_i32_inf: %d\n", (int)(1.0/0.0));            // INT32_MAX

    // ---- negative overflow (i32_s) ----
    printf("f64_to_i32_under: %d\n", (int)-1e16);              // INT32_MIN
    printf("f64_to_i32_ninf: %d\n", (int)(-1.0/0.0));          // INT32_MIN

    // ---- NaN (any signedness) ----
    double nan_v = 0.0/0.0;
    printf("f64_to_i32_nan: %d\n", (int)nan_v);                // 0
    printf("f64_to_i64_nan: %lld\n", (long long)nan_v);        // 0
    printf("f64_to_u32_nan: %u\n", (unsigned)nan_v);           // 0

    // ---- unsigned: negative float saturates to 0 ----
    printf("f64_to_u32_neg: %u\n", (unsigned)-3.7);            // 0
    printf("f64_to_u32_huge: %u\n", (unsigned)1e16);           // UINT32_MAX

    // ---- i64 destinations ----
    printf("f64_to_i64_overflow: %lld\n", (long long)1e30);    // INT64_MAX
    printf("f64_to_i64_under: %lld\n", (long long)-1e30);      // INT64_MIN
    printf("f64_to_u64_huge: %llu\n", (unsigned long long)1e30);

    // ---- f32 source variants ----
    float f_huge = 1e20f;
    printf("f32_to_i32_overflow: %d\n", (int)f_huge);          // INT32_MAX
    printf("f32_to_i32_neg_huge: %d\n", (int)-f_huge);         // INT32_MIN

    return 0;
}
