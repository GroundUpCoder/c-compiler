#include <math.h>
#include <stdio.h>

int main() {
  // Trig
  printf("sin(M_PI/6) = %.6f\n", sin(M_PI / 6));
  printf("cos(M_PI/3) = %.6f\n", cos(M_PI / 3));
  printf("tan(M_PI/4) = %.6f\n", tan(M_PI / 4));
  printf("asin(0.5) = %.6f\n", asin(0.5));
  printf("acos(0.5) = %.6f\n", acos(0.5));
  printf("atan(1.0) = %.6f\n", atan(1.0));
  printf("atan2(1.0, 1.0) = %.6f\n", atan2(1.0, 1.0));

  // Hyperbolic
  printf("sinh(1.0) = %.6f\n", sinh(1.0));
  printf("cosh(1.0) = %.6f\n", cosh(1.0));
  printf("tanh(1.0) = %.6f\n", tanh(1.0));
  printf("asinh(1.0) = %.6f\n", asinh(1.0));
  printf("acosh(2.0) = %.6f\n", acosh(2.0));
  printf("atanh(0.5) = %.6f\n", atanh(0.5));

  // Exp/Log
  printf("exp(1.0) = %.6f\n", exp(1.0));
  printf("expm1(0.001) = %.9f\n", expm1(0.001));
  printf("log(M_E) = %.6f\n", log(M_E));
  printf("log2(8.0) = %.6f\n", log2(8.0));
  printf("log10(1000.0) = %.6f\n", log10(1000.0));
  printf("log1p(0.001) = %.9f\n", log1p(0.001));

  // Power/Root
  printf("pow(2.0, 10.0) = %.6f\n", pow(2.0, 10.0));
  printf("cbrt(27.0) = %.6f\n", cbrt(27.0));
  printf("hypot(3.0, 4.0) = %.6f\n", hypot(3.0, 4.0));

  // fmod
  printf("fmod(7.5, 2.3) = %.6f\n", fmod(7.5, 2.3));
  printf("fmod(-7.5, 2.3) = %.6f\n", fmod(-7.5, 2.3));

  // Float variants
  printf("sinf(1.0) = %.6f\n", (double)sinf(1.0f));
  printf("expf(1.0) = %.6f\n", (double)expf(1.0f));
  printf("cbrtf(8.0) = %.6f\n", (double)cbrtf(8.0f));
  printf("fmodf(7.5, 2.3) = %.6f\n", (double)fmodf(7.5f, 2.3f));
  printf("atan2f(1.0, 1.0) = %.6f\n", (double)atan2f(1.0f, 1.0f));
  printf("hypotf(3.0, 4.0) = %.6f\n", (double)hypotf(3.0f, 4.0f));

  return 0;
}
