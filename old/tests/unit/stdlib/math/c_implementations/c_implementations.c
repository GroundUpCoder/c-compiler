#include <stdio.h>
#include <math.h>

int main() {
  int e;
  double m;

  // === round ===
  printf("round(2.3) = %f\n", round(2.3));
  printf("round(2.7) = %f\n", round(2.7));
  printf("round(-2.3) = %f\n", round(-2.3));
  printf("round(-2.7) = %f\n", round(-2.7));
  // Ties away from zero
  printf("round(0.5) = %f\n", round(0.5));
  printf("round(-0.5) = %f\n", round(-0.5));
  printf("round(2.5) = %f\n", round(2.5));
  printf("round(-2.5) = %f\n", round(-2.5));
  // The critical case: largest double below 0.5 must NOT round up
  // (naive floor(x+0.5) gets this wrong)
  printf("round(0.5-1e-16)==0: %d\n", round(0.5 - 1e-16) == 0.0);
  printf("round(-0.5+1e-16)==0: %d\n", round(-0.5 + 1e-16) == 0.0);
  // Already-integer values
  printf("round(3.0) = %f\n", round(3.0));
  printf("round(0.0) = %f\n", round(0.0));
  // roundf
  printf("roundf(2.5) = %f\n", (double)roundf(2.5f));
  printf("roundf(-2.5) = %f\n", (double)roundf(-2.5f));

  // === fdim ===
  printf("fdim(5.0,3.0) = %f\n", fdim(5.0, 3.0));
  printf("fdim(3.0,5.0) = %f\n", fdim(3.0, 5.0));
  printf("fdim(-3.0,-5.0) = %f\n", fdim(-3.0, -5.0));
  printf("fdim(5.0,5.0) = %f\n", fdim(5.0, 5.0));
  printf("fdimf(5.0,3.0) = %f\n", (double)fdimf(5.0f, 3.0f));

  // === lround / lrint ===
  printf("lround(2.5) = %ld\n", lround(2.5));
  printf("lround(-2.5) = %ld\n", lround(-2.5));
  printf("lrint(2.5) = %ld\n", lrint(2.5));   // round-to-even: 2
  printf("lrint(3.5) = %ld\n", lrint(3.5));   // round-to-even: 4
  printf("lrint(-0.7) = %ld\n", lrint(-0.7));

  // === nextafter ===
  // Basic direction
  printf("nextafter(1,2)>1: %d\n", nextafter(1.0, 2.0) > 1.0);
  printf("nextafter(1,0)<1: %d\n", nextafter(1.0, 0.0) < 1.0);
  // Identity
  printf("nextafter(1,1)==1: %d\n", nextafter(1.0, 1.0) == 1.0);
  // From zero
  printf("nextafter(0,1)>0: %d\n", nextafter(0.0, 1.0) > 0.0);
  printf("nextafter(0,-1)<0: %d\n", nextafter(0.0, -1.0) < 0.0);
  // Crossing zero boundary step by step
  double tiny = nextafter(0.0, 1.0);
  printf("nextafter(tiny,-1)==0: %d\n", nextafter(tiny, -1.0) == 0.0);
  double ntiny = nextafter(0.0, -1.0);
  printf("nextafter(ntiny,1)==0: %d\n", nextafter(ntiny, 1.0) == 0.0);
  // Negative direction
  printf("nextafter(-1,-2)<-1: %d\n", nextafter(-1.0, -2.0) < -1.0);
  printf("nextafter(-1,0)>-1: %d\n", nextafter(-1.0, 0.0) > -1.0);
  // nextafterf
  printf("nextafterf(1,2)>1: %d\n", nextafterf(1.0f, 2.0f) > 1.0f);
  printf("nextafterf(0,1)>0: %d\n", nextafterf(0.0f, 1.0f) > 0.0f);

  // === frexp ===
  // Normal values
  m = frexp(1.0, &e);
  printf("frexp(1.0) = %f * 2^%d\n", m, e);
  m = frexp(3.0, &e);
  printf("frexp(3.0) = %f * 2^%d\n", m, e);
  m = frexp(-6.0, &e);
  printf("frexp(-6.0) = %f * 2^%d\n", m, e);
  m = frexp(0.25, &e);
  printf("frexp(0.25) = %f * 2^%d\n", m, e);
  // Zero
  m = frexp(0.0, &e);
  printf("frexp(0.0) = %f * 2^%d\n", m, e);
  // Subnormal: use nextafter to construct one
  m = frexp(nextafter(0.0, 1.0), &e);
  printf("frexp(subnormal): m=%f exp=%d\n", m, e);
  // Verify roundtrip: m * 2^e should reconstruct the value
  printf("frexp roundtrip 8.0: %d\n", frexp(8.0, &e) * pow(2.0, (double)e) == 8.0);
  printf("frexp roundtrip 0.1: %d\n", frexp(0.1, &e) * pow(2.0, (double)e) == 0.1);
  printf("frexp roundtrip -100: %d\n", frexp(-100.0, &e) * pow(2.0, (double)e) == -100.0);

  // === ilogb ===
  printf("ilogb(1.0) = %d\n", ilogb(1.0));
  printf("ilogb(2.0) = %d\n", ilogb(2.0));
  printf("ilogb(3.0) = %d\n", ilogb(3.0));
  printf("ilogb(0.5) = %d\n", ilogb(0.5));
  printf("ilogb(1024.0) = %d\n", ilogb(1024.0));
  printf("ilogb(-7.0) = %d\n", ilogb(-7.0));
  // Subnormal
  printf("ilogb(subnormal) = %d\n", ilogb(nextafter(0.0, 1.0)));

  // === logb ===
  printf("logb(1.0) = %f\n", logb(1.0));
  printf("logb(2.0) = %f\n", logb(2.0));
  printf("logb(0.5) = %f\n", logb(0.5));
  printf("logb(1024.0) = %f\n", logb(1024.0));
  printf("logb(-7.0) = %f\n", logb(-7.0));
  // Subnormal
  printf("logb(subnormal) = %f\n", logb(nextafter(0.0, 1.0)));

  // === modf ===
  double ipart;
  double fpart;
  fpart = modf(3.75, &ipart);
  printf("modf(3.75) = %f + %f\n", ipart, fpart);
  fpart = modf(-3.75, &ipart);
  printf("modf(-3.75) = %f + %f\n", ipart, fpart);
  fpart = modf(7.0, &ipart);
  printf("modf(7.0) = %f + %f\n", ipart, fpart);
  fpart = modf(0.25, &ipart);
  printf("modf(0.25) = %f + %f\n", ipart, fpart);
  fpart = modf(0.0, &ipart);
  printf("modf(0.0) = %f + %f\n", ipart, fpart);
  // Roundtrip: ipart + fpart == x
  fpart = modf(-123.456, &ipart);
  printf("modf roundtrip: %d\n", ipart + fpart == -123.456);

  return 0;
}
