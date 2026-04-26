#include <float.h>
#include <stdio.h>

int main() {
  // FLT_RADIX: base of the floating-point representation
  printf("FLT_RADIX=%d\n", FLT_RADIX);

  // FLT_ROUNDS: rounding mode (1 = round to nearest)
  printf("FLT_ROUNDS=%d\n", FLT_ROUNDS);

  // FLT_EVAL_METHOD: evaluation method (0 = evaluate to type)
  printf("FLT_EVAL_METHOD=%d\n", FLT_EVAL_METHOD);

  // DECIMAL_DIG: decimal digits needed to distinguish all values
  printf("DECIMAL_DIG=%d\n", DECIMAL_DIG);

  // float properties
  printf("FLT_DIG=%d\n", FLT_DIG);
  printf("FLT_MANT_DIG=%d\n", FLT_MANT_DIG);
  printf("FLT_MIN_EXP=%d\n", FLT_MIN_EXP);
  printf("FLT_MAX_EXP=%d\n", FLT_MAX_EXP);
  printf("FLT_MIN_10_EXP=%d\n", FLT_MIN_10_EXP);
  printf("FLT_MAX_10_EXP=%d\n", FLT_MAX_10_EXP);

  // FLT_MIN: smallest normalized positive float
  printf("FLT_MIN>0: %d\n", (double)FLT_MIN > 0.0);
  printf("FLT_MIN<1: %d\n", (double)FLT_MIN < 1.0);

  // FLT_MAX: largest finite float
  printf("FLT_MAX>1000: %d\n", (double)FLT_MAX > 1000.0);

  // FLT_EPSILON: difference between 1.0f and next representable float
  printf("1+FLT_EPS>1: %d\n", (double)(1.0f + FLT_EPSILON) > 1.0);
  printf("FLT_EPS<1: %d\n", (double)FLT_EPSILON < 1.0);

  // FLT_TRUE_MIN: smallest positive float (subnormal)
  printf("FLT_TRUE_MIN>0: %d\n", (double)FLT_TRUE_MIN > 0.0);
  printf("FLT_TRUE_MIN<=FLT_MIN: %d\n", (double)FLT_TRUE_MIN <= (double)FLT_MIN);

  // double properties
  printf("DBL_DIG=%d\n", DBL_DIG);
  printf("DBL_MANT_DIG=%d\n", DBL_MANT_DIG);
  printf("DBL_MIN_EXP=%d\n", DBL_MIN_EXP);
  printf("DBL_MAX_EXP=%d\n", DBL_MAX_EXP);
  printf("DBL_MIN_10_EXP=%d\n", DBL_MIN_10_EXP);
  printf("DBL_MAX_10_EXP=%d\n", DBL_MAX_10_EXP);

  // DBL_MIN: smallest normalized positive double
  printf("DBL_MIN>0: %d\n", DBL_MIN > 0.0);
  printf("DBL_MIN<1: %d\n", DBL_MIN < 1.0);

  // DBL_MAX: largest finite double
  printf("DBL_MAX>1000: %d\n", DBL_MAX > 1000.0);

  // DBL_EPSILON: difference between 1.0 and next representable double
  printf("1+DBL_EPS>1: %d\n", (1.0 + DBL_EPSILON) > 1.0);
  printf("DBL_EPS<1: %d\n", DBL_EPSILON < 1.0);

  // DBL_TRUE_MIN: smallest positive double (subnormal)
  printf("DBL_TRUE_MIN>0: %d\n", DBL_TRUE_MIN > 0.0);
  printf("DBL_TRUE_MIN<=DBL_MIN: %d\n", DBL_TRUE_MIN <= DBL_MIN);

  // long double aliases (same as double on wasm)
  printf("LDBL_DIG=%d\n", LDBL_DIG);
  printf("LDBL_MANT_DIG=%d\n", LDBL_MANT_DIG);
  printf("LDBL_MIN_EXP=%d\n", LDBL_MIN_EXP);
  printf("LDBL_MAX_EXP=%d\n", LDBL_MAX_EXP);
  printf("LDBL_MIN_10_EXP=%d\n", LDBL_MIN_10_EXP);
  printf("LDBL_MAX_10_EXP=%d\n", LDBL_MAX_10_EXP);

  printf("LDBL_MIN>0: %d\n", LDBL_MIN > 0.0);
  printf("LDBL_MAX>1000: %d\n", LDBL_MAX > 1000.0);
  printf("LDBL_EPS<1: %d\n", LDBL_EPSILON < 1.0);
  printf("LDBL_TRUE_MIN>0: %d\n", LDBL_TRUE_MIN > 0.0);

  return 0;
}
