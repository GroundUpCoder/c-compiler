#include <stdio.h>
#include <math.h>
#include <stdint.h>

// Reinterpret double as its 64-bit IEEE 754 representation
long long bits(double x) {
  return __wasm(long long, (x), op 0xBD);  // i64.reinterpret_f64
}

int main() {
  double inf = 1.0 / 0.0;
  double nan_val = 0.0 / 0.0;
  int e;
  double m;

  // === Basic scaling ===
  printf("ldexp(1.0, 0) = %f\n", ldexp(1.0, 0));
  printf("ldexp(1.0, 1) = %f\n", ldexp(1.0, 1));
  printf("ldexp(1.0, 10) = %f\n", ldexp(1.0, 10));
  printf("ldexp(1.0, -1) = %f\n", ldexp(1.0, -1));
  printf("ldexp(1.0, -3) = %f\n", ldexp(1.0, -3));
  printf("ldexp(3.0, 4) = %f\n", ldexp(3.0, 4));
  printf("ldexp(0.75, 4) = %f\n", ldexp(0.75, 4));

  // === Negative x ===
  printf("ldexp(-1.0, 3) = %f\n", ldexp(-1.0, 3));
  printf("ldexp(-2.5, 2) = %f\n", ldexp(-2.5, 2));

  // === Zero ===
  printf("ldexp(0.0, 5) = %f\n", ldexp(0.0, 5));
  printf("ldexp(0.0, -5) = %f\n", ldexp(0.0, -5));
  printf("ldexp(0.0, 1000) = %f\n", ldexp(0.0, 1000));

  // === Signed zero preservation (bit-exact) ===
  // +0.0 = 0x0000000000000000, -0.0 = 0x8000000000000000
  printf("-0.0 bits (n=0): %lld\n", bits(ldexp(-0.0, 0)));
  printf("-0.0 bits (n=5): %lld\n", bits(ldexp(-0.0, 5)));
  printf("-0.0 bits (n=-5): %lld\n", bits(ldexp(-0.0, -5)));
  printf("-0.0 bits (n=2000): %lld\n", bits(ldexp(-0.0, 2000)));
  printf("-0.0 bits (n=-2000): %lld\n", bits(ldexp(-0.0, -2000)));
  printf("+0.0 bits (n=5): %lld\n", bits(ldexp(0.0, 5)));

  // === Infinity passthrough (bit-exact) ===
  // +inf = 0x7FF0000000000000, -inf = 0xFFF0000000000000
  printf("ldexp(inf, 5): %lld\n", bits(ldexp(inf, 5)));
  printf("ldexp(-inf, 5): %lld\n", bits(ldexp(-inf, 5)));
  printf("ldexp(inf, -5): %lld\n", bits(ldexp(inf, -5)));
  printf("ldexp(inf, -10000): %lld\n", bits(ldexp(inf, -10000)));
  printf("ldexp(-inf, -10000): %lld\n", bits(ldexp(-inf, -10000)));

  // === NaN passthrough ===
  printf("ldexp(nan, 0) is nan: %d\n", ldexp(nan_val, 0) != ldexp(nan_val, 0));
  printf("ldexp(nan, 5) is nan: %d\n", ldexp(nan_val, 5) != ldexp(nan_val, 5));
  printf("ldexp(nan, -5) is nan: %d\n", ldexp(nan_val, -5) != ldexp(nan_val, -5));
  printf("ldexp(nan, 10000) is nan: %d\n", ldexp(nan_val, 10000) != ldexp(nan_val, 10000));

  // === Overflow to infinity ===
  printf("ldexp(1.0, 1024) = %f\n", ldexp(1.0, 1024));
  printf("ldexp(1.0, 2000) = %f\n", ldexp(1.0, 2000));
  printf("ldexp(1.0, 10000) = %f\n", ldexp(1.0, 10000));
  printf("ldexp(-1.0, 1024) = %f\n", ldexp(-1.0, 1024));
  // Just below overflow: 1.999... * 2^1023 = DBL_MAX
  printf("ldexp(1.0, 1023) finite: %d\n", ldexp(1.0, 1023) != inf);
  // Fractional value that overflows
  printf("ldexp(1.5, 1024) = %f\n", ldexp(1.5, 1024));

  // === Underflow to zero ===
  printf("ldexp(1.0, -1075) = %f\n", ldexp(1.0, -1075));
  printf("ldexp(1.0, -2000) = %f\n", ldexp(1.0, -2000));
  printf("ldexp(1.0, -10000) = %f\n", ldexp(1.0, -10000));
  // Sign preserved on underflow to zero (bit-exact)
  printf("underflow -0.0 bits: %lld\n", bits(ldexp(-1.0, -10000)));

  // === Boundary exponents (bit-exact) ===
  // 2^1023 = exponent 1023+1023=2046 in biased form, mantissa 0
  // bits: sign=0, exp=10_0000_0000_10 (2046), frac=0 -> 0x7FE0000000000000
  printf("ldexp(1.0, 1023) bits: %lld\n", bits(ldexp(1.0, 1023)));
  printf("ldexp(1.0, 1023) == 2^1023: %d\n", bits(ldexp(1.0, 1023)) == bits(8.98846567431158e307));
  // 2^-1022 = smallest normal: exponent 1 in biased form
  // bits: sign=0, exp=00_0000_0000_01 (1), frac=0 -> 0x0010000000000000
  printf("ldexp(1.0, -1022) bits: %lld\n", bits(ldexp(1.0, -1022)));
  printf("ldexp(1.0, -1022) == 2^-1022: %d\n", bits(ldexp(1.0, -1022)) == bits(2.2250738585072014e-308));

  // === Subnormal results (bit-exact) ===
  // 2^-1074 is the smallest positive double (subnormal)
  // bits: sign=0, exp=0, frac=1 -> 0x0000000000000001
  printf("ldexp(1.0, -1074) bits: %lld\n", bits(ldexp(1.0, -1074)));
  // 2^-1073: bits should be 0x0000000000000002
  printf("ldexp(1.0, -1073) bits: %lld\n", bits(ldexp(1.0, -1073)));
  // 2^-1064: deeper into subnormal range, bit 10 set
  // bits: sign=0, exp=0, frac=1<<10 -> 0x0000000000000400
  printf("ldexp(1.0, -1064) bits: %lld\n", bits(ldexp(1.0, -1064)));
  // 2^-1023: just below normal, largest subnormal power of 2
  // bits: sign=0, exp=0, frac=1<<51 -> 0x0008000000000000
  printf("ldexp(1.0, -1023) bits: %lld\n", bits(ldexp(1.0, -1023)));

  // === Subnormal inputs ===
  // Scale a subnormal value up into normal range
  double tiny = nextafter(0.0, 1.0);  // smallest subnormal = 2^-1074
  printf("ldexp(subnormal, 1074) == 1.0: %d\n", ldexp(tiny, 1074) == 1.0);
  printf("ldexp(subnormal, 1075) == 2.0: %d\n", ldexp(tiny, 1075) == 2.0);
  printf("ldexp(subnormal, 2000) finite: %d\n", ldexp(tiny, 2000) != inf);
  // Scale subnormal further down (should underflow to 0)
  printf("ldexp(subnormal, -1) == 0: %d\n", ldexp(tiny, -1) == 0.0);
  // Scale a larger subnormal
  double sub2 = ldexp(1.0, -1060);  // subnormal with some mantissa bits
  printf("ldexp(sub, 1060) == 1.0: %d\n", ldexp(sub2, 1060) == 1.0);
  printf("ldexp(sub, 1061) == 2.0: %d\n", ldexp(sub2, 1061) == 2.0);

  // === Roundtrip with frexp ===
  m = frexp(123.456, &e);
  printf("roundtrip 123.456: %d\n", ldexp(m, e) == 123.456);
  m = frexp(-0.001, &e);
  printf("roundtrip -0.001: %d\n", ldexp(m, e) == -0.001);
  m = frexp(1e300, &e);
  printf("roundtrip 1e300: %d\n", ldexp(m, e) == 1e300);
  m = frexp(5e-324, &e);
  printf("roundtrip 5e-324: %d\n", ldexp(m, e) == 5e-324);
  m = frexp(1.7976931348623157e308, &e);  // DBL_MAX
  printf("roundtrip DBL_MAX: %d\n", ldexp(m, e) == 1.7976931348623157e308);

  // === Powers of two ===
  printf("ldexp(1,0)==1: %d\n", ldexp(1.0, 0) == 1.0);
  printf("ldexp(1,1)==2: %d\n", ldexp(1.0, 1) == 2.0);
  printf("ldexp(1,8)==256: %d\n", ldexp(1.0, 8) == 256.0);
  printf("ldexp(1,20)==1048576: %d\n", ldexp(1.0, 20) == 1048576.0);
  printf("ldexp(1,52)==2^52: %d\n", ldexp(1.0, 52) == 4503599627370496.0);

  // === n=0 is identity ===
  printf("ldexp(3.14, 0) == 3.14: %d\n", ldexp(3.14, 0) == 3.14);
  printf("ldexp(-42.0, 0) == -42.0: %d\n", ldexp(-42.0, 0) == -42.0);
  printf("ldexp(DBL_MAX, 0) == DBL_MAX: %d\n", ldexp(1.7976931348623157e308, 0) == 1.7976931348623157e308);

  // === Bit-exact known values ===
  // 1.0 = 0x3FF0000000000000
  // ldexp(1.0, 1) = 2.0 = 0x4000000000000000 (exponent increases by 1)
  printf("1.0 bits: %lld\n", bits(1.0));
  printf("2.0 bits: %lld\n", bits(ldexp(1.0, 1)));
  printf("4.0 bits: %lld\n", bits(ldexp(1.0, 2)));
  printf("0.5 bits: %lld\n", bits(ldexp(1.0, -1)));
  // 3.0 * 2^4 = 48.0 — non-trivial mantissa
  // 3.0 = 0x4008000000000000, 48.0 = 0x4048000000000000
  printf("3.0 bits: %lld\n", bits(3.0));
  printf("48.0 bits: %lld\n", bits(ldexp(3.0, 4)));
  // Verify exponent field shifted by exactly 4
  long long b3 = bits(3.0);
  long long b48 = bits(ldexp(3.0, 4));
  int exp3 = (int)((b3 >> 52) & 0x7FF);
  int exp48 = (int)((b48 >> 52) & 0x7FF);
  printf("exponent diff (48 vs 3): %d\n", exp48 - exp3);
  // Mantissa unchanged by ldexp (pure exponent operation)
  long long mantissa_mask = (1LL << 52) - 1;
  printf("mantissa preserved: %d\n", (b3 & mantissa_mask) == (b48 & mantissa_mask));

  // === ldexpf ===
  printf("ldexpf(1.0, 10) = %f\n", (double)ldexpf(1.0f, 10));
  printf("ldexpf(-2.5, 2) = %f\n", (double)ldexpf(-2.5f, 2));
  printf("ldexpf(0.5, 1) == 1.0: %d\n", ldexpf(0.5f, 1) == 1.0f);

  return 0;
}
