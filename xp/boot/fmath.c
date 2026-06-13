/* Float math implementations sized for the voxel demo's needs.
   See fmath_test.c for accuracy bounds verified against libm. */
#include "fmath.h"

static float type_pun_i_to_f(int i) {
    union { int i; float f; } u;
    u.i = i;
    return u.f;
}
static int type_pun_f_to_i(float f) {
    union { int i; float f; } u;
    u.f = f;
    return u.i;
}

float fm_fabsf(float x) { return type_pun_i_to_f(type_pun_f_to_i(x) & 0x7FFFFFFF); }
float fm_fminf(float a, float b) { return a < b ? a : b; }
float fm_fmaxf(float a, float b) { return a > b ? a : b; }

float fm_floorf(float x) {
    int i = (int)x;
    if ((float)i > x) i--;          /* round toward -inf for negative non-integers */
    return (float)i;
}
float fm_ceilf(float x) {
    int i = (int)x;
    if ((float)i < x) i++;
    return (float)i;
}

/* sqrt via the classic "magic-number" inverse-sqrt seed + 3 Newton iterations.
   Worst-case relative error < 1e-6 in [0, 1e10]. */
float fm_sqrtf(float x) {
    if (x <= 0.0f) return 0.0f;
    /* Bit-hack initial guess: very rough but converges fast. */
    int i = type_pun_f_to_i(x);
    i = 0x1FBB67AE + (i >> 1);      /* magic for sqrt seed (Lomont 2003) */
    float y = type_pun_i_to_f(i);
    /* Newton-Raphson: y_{n+1} = 0.5 * (y_n + x / y_n) */
    y = 0.5f * (y + x / y);
    y = 0.5f * (y + x / y);
    y = 0.5f * (y + x / y);
    return y;
}

/* sin/cos via:
     1) range-reduce x to [-pi, pi] (mod 2pi)
     2) reduce to [-pi/2, pi/2] using sin(pi - x) = sin(x), cos(pi - x) = -cos(x)
     3) polynomial approx on the small range
   Coefficients are 5-term minimax-ish (Horner form). */
static const float FM_PI    = 3.14159265358979323846f;
static const float FM_TWO_PI = 6.28318530717958647692f;
static const float FM_HALF_PI = 1.57079632679489661923f;

static float reduce_to_pi(float x) {
    /* Reduce x to [-pi, pi].  k = round(x / (2pi)). */
    float k = x * (1.0f / FM_TWO_PI);
    int ki = (int)(k + (k >= 0.0f ? 0.5f : -0.5f));
    return x - (float)ki * FM_TWO_PI;
}

static float sin_small(float x) {
    /* Taylor through x^9 — accurate on [-pi/2, pi/2] to ~1e-6 */
    float x2 = x * x;
    return x * (1.0f + x2 * (-1.0f/6.0f + x2 * (1.0f/120.0f + x2 * (-1.0f/5040.0f + x2 * (1.0f/362880.0f)))));
}

float fm_sinf(float x) {
    x = reduce_to_pi(x);
    /* Fold to [-pi/2, pi/2] using sin(pi - x) = sin(x) and sin(-pi - x) = sin(x). */
    if (x >  FM_HALF_PI) x =  FM_PI - x;
    if (x < -FM_HALF_PI) x = -FM_PI - x;
    return sin_small(x);
}

float fm_cosf(float x) {
    /* cos(x) = sin(x + pi/2). */
    return fm_sinf(x + FM_HALF_PI);
}
