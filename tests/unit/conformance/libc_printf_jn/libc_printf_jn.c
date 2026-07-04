// BUG: %jn only writes the low 32 bits of the count into the intmax_t — the high bytes keep their old value (-1 stays in the upper half).
// C11: 7.21.6.1p7 (j length with n) — the argument is a pointer to intmax_t and the full intmax_t object receives the number of characters written.
// EXPECT: "abc3\n" — after "abc" the count is 3, and the whole 64-bit object must read back as 3 (verified against native clang; intmax_t is 64-bit on both targets).
#include <stdio.h>
#include <stdint.h>

int main(void) {
  intmax_t n = -1;
  printf("abc%jn", &n);
  printf("%jd\n", n);
  return 0;
}
