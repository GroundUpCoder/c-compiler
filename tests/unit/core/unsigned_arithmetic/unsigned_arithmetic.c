// Tests unsigned integer arithmetic and comparisons.
#include <stdio.h>

int main() {
  unsigned int a = 0;
  unsigned int b = 1;

  // Unsigned subtraction wraps
  unsigned int wrapped = a - b;
  printf("%u\n", wrapped);  // 4294967295 (UINT_MAX)

  // Unsigned comparison
  printf("%d\n", wrapped > 0);  // 1 (large positive, not negative)
  printf("%d\n", a < b);        // 1

  // Unsigned division (no sign issues)
  unsigned int big = 3000000000u;
  unsigned int divisor = 1000000000u;
  printf("%u\n", big / divisor);  // 3
  printf("%u\n", big % divisor);  // 0

  // Unsigned right shift (logical, not arithmetic)
  unsigned int val = 0x80000000u;
  printf("%u\n", val >> 1);  // 1073741824 (0x40000000)

  // Signed right shift (arithmetic)
  int sval = -1;
  printf("%d\n", sval >> 1);  // -1 (sign-extended)

  // Mixed signed/unsigned comparison
  unsigned int u = 1;
  int s = -1;
  // In C, -1 gets converted to unsigned, becoming UINT_MAX
  printf("%d\n", u < (unsigned int)s);  // 1

  return 0;
}
