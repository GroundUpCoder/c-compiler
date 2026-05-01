#include <math.h>
#include <stdio.h>

int main() {
  // === round: ties away from zero ===
  printf("round(0.5) = %.1f\n", round(0.5));
  printf("round(-0.5) = %.1f\n", round(-0.5));
  printf("round(1.5) = %.1f\n", round(1.5));
  printf("round(2.5) = %.1f\n", round(2.5));
  printf("round(-2.5) = %.1f\n", round(-2.5));
  printf("round(0.0) = %.1f\n", round(0.0));
  printf("round(3.7) = %.1f\n", round(3.7));
  printf("round(-3.2) = %.1f\n", round(-3.2));

  // Critical: naive floor(x+0.5) gives 1.0 here, correct answer is 0.0
  // Use nextafter to get the largest double below 0.5
  double below_half = nextafter(0.5, 0.0);
  printf("below_half < 0.5: %d\n", below_half < 0.5);
  printf("round(below_half) = %.1f\n", round(below_half));

  // round vs rint: round ties away from zero, rint ties to even
  printf("round(0.5)=%.0f rint(0.5)=%.0f\n", round(0.5), rint(0.5));
  printf("round(1.5)=%.0f rint(1.5)=%.0f\n", round(1.5), rint(1.5));
  printf("round(2.5)=%.0f rint(2.5)=%.0f\n", round(2.5), rint(2.5));
  printf("round(3.5)=%.0f rint(3.5)=%.0f\n", round(3.5), rint(3.5));

  // roundf
  printf("roundf(0.5f) = %.1f\n", (double)roundf(0.5f));
  printf("roundf(-0.5f) = %.1f\n", (double)roundf(-0.5f));

  // === fdim ===
  printf("fdim(5, 3) = %.1f\n", fdim(5.0, 3.0));
  printf("fdim(3, 5) = %.1f\n", fdim(3.0, 5.0));
  printf("fdim(-3, -5) = %.1f\n", fdim(-3.0, -5.0));
  printf("fdimf(5, 3) = %.1f\n", (double)fdimf(5.0f, 3.0f));

  // === lround: ties away from zero ===
  printf("lround(2.7) = %d\n", (int)lround(2.7));
  printf("lround(-2.7) = %d\n", (int)lround(-2.7));
  printf("lround(0.5) = %d\n", (int)lround(0.5));
  printf("lround(-0.5) = %d\n", (int)lround(-0.5));

  // === lrint: ties to even ===
  printf("lrint(0.5) = %d\n", (int)lrint(0.5));
  printf("lrint(1.5) = %d\n", (int)lrint(1.5));
  printf("lrint(2.5) = %d\n", (int)lrint(2.5));
  printf("lrint(3.5) = %d\n", (int)lrint(3.5));
  printf("lrint(-0.5) = %d\n", (int)lrint(-0.5));
  printf("lrint(-1.5) = %d\n", (int)lrint(-1.5));

  // === nextafter ===
  // Basic direction
  printf("nextafter(1,2) > 1: %d\n", nextafter(1.0, 2.0) > 1.0);
  printf("nextafter(1,0) < 1: %d\n", nextafter(1.0, 0.0) < 1.0);

  // From zero: should give smallest subnormal
  printf("nextafter(0,1) > 0: %d\n", nextafter(0.0, 1.0) > 0.0);
  printf("nextafter(0,-1) < 0: %d\n", nextafter(0.0, -1.0) < 0.0);

  // Equal: returns y
  printf("nextafter(1,1) == 1: %d\n", nextafter(1.0, 1.0) == 1.0);

  // Negative values
  printf("nextafter(-1,0) > -1: %d\n", nextafter(-1.0, 0.0) > -1.0);
  printf("nextafter(-1,-2) < -1: %d\n", nextafter(-1.0, -2.0) < -1.0);

  // Round-trip: nextafter up then down returns original
  double up = nextafter(1.0, 2.0);
  double back = nextafter(up, 0.0);
  printf("nextafter round-trip: %d\n", back == 1.0);

  // ULP at 1.0 is 2^-52
  double ulp1 = nextafter(1.0, 2.0) - 1.0;
  printf("ULP at 1.0 = %.17g\n", ulp1);

  // ULP doubles at each power of 2
  double ulp2 = nextafter(2.0, 3.0) - 2.0;
  printf("ULP at 2.0 = 2*ULP at 1.0: %d\n", ulp2 == 2.0 * ulp1);

  // nextafterf
  printf("nextafterf(1,2) > 1: %d\n", nextafterf(1.0f, 2.0f) > 1.0f);
  printf("nextafterf(0,1) > 0: %d\n", nextafterf(0.0f, 1.0f) > 0.0f);
  float fup = nextafterf(1.0f, 2.0f);
  float fback = nextafterf(fup, 0.0f);
  printf("nextafterf round-trip: %d\n", fback == 1.0f);

  // Float ULP at 1.0 is 2^-23 (much larger than double)
  float fulp = nextafterf(1.0f, 2.0f) - 1.0f;
  double dulp = nextafter(1.0, 2.0) - 1.0;
  printf("float ULP > double ULP: %d\n", fulp > dulp);

  return 0;
}
