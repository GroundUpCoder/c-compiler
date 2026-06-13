/* Float math primitives for bare-metal — no libm dependency.
   All implementations are in fmath.c and validated against libm in
   fmath_test.c (compiled natively with Apple clang). */
#ifndef FMATH_H
#define FMATH_H

float fm_fabsf(float x);
float fm_fminf(float a, float b);
float fm_fmaxf(float a, float b);
float fm_floorf(float x);
float fm_ceilf(float x);
float fm_sqrtf(float x);
float fm_sinf(float x);
float fm_cosf(float x);

#endif
