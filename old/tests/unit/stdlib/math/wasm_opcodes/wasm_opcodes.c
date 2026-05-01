#include <math.h>
#include <stdio.h>

int main() {
  // fabs / fabsf
  printf("fabs(-3.5) = %f\n", fabs(-3.5));
  printf("fabs(2.0) = %f\n", fabs(2.0));
  printf("fabsf(-1.5) = %f\n", (double)fabsf(-1.5f));

  // ceil / ceilf
  printf("ceil(2.3) = %f\n", ceil(2.3));
  printf("ceil(-2.7) = %f\n", ceil(-2.7));
  printf("ceilf(2.3) = %f\n", (double)ceilf(2.3f));

  // floor / floorf
  printf("floor(2.7) = %f\n", floor(2.7));
  printf("floor(-2.3) = %f\n", floor(-2.3));
  printf("floorf(2.7) = %f\n", (double)floorf(2.7f));

  // trunc / truncf
  printf("trunc(2.9) = %f\n", trunc(2.9));
  printf("trunc(-2.9) = %f\n", trunc(-2.9));
  printf("truncf(2.9) = %f\n", (double)truncf(2.9f));

  // sqrt / sqrtf
  printf("sqrt(4.0) = %f\n", sqrt(4.0));
  printf("sqrt(2.0) = %f\n", sqrt(2.0));
  printf("sqrtf(9.0) = %f\n", (double)sqrtf(9.0f));

  // nearbyint / rint
  printf("nearbyint(2.5) = %f\n", nearbyint(2.5));
  printf("nearbyint(3.5) = %f\n", nearbyint(3.5));
  printf("rint(2.3) = %f\n", rint(2.3));

  // fmin / fmax
  printf("fmin(3.0, 5.0) = %f\n", fmin(3.0, 5.0));
  printf("fmax(3.0, 5.0) = %f\n", fmax(3.0, 5.0));
  printf("fminf(1.0, 2.0) = %f\n", (double)fminf(1.0f, 2.0f));
  printf("fmaxf(1.0, 2.0) = %f\n", (double)fmaxf(1.0f, 2.0f));

  // copysign / copysignf
  printf("copysign(5.0, -1.0) = %f\n", copysign(5.0, -1.0));
  printf("copysign(-5.0, 1.0) = %f\n", copysign(-5.0, 1.0));
  printf("copysignf(5.0, -1.0) = %f\n", (double)copysignf(5.0f, -1.0f));

  // Constants
  printf("M_PI = %f\n", M_PI);
  printf("M_E = %f\n", M_E);
  printf("INFINITY = %f\n", (double)INFINITY);

  return 0;
}
