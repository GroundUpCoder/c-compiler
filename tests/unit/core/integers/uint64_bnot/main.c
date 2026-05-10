// Regression: ~SIGN_MASK pattern (used in soft-float) must produce a
// well-defined uint64_t value, not an out-of-range BigInt that produces
// malformed wasm i64.const LEB encoding.
#include <stdio.h>

int main(void) {
  unsigned long long sign_mask = 1ULL << 63;          /* 0x8000000000000000 */
  unsigned long long not_sign  = ~sign_mask;          /* 0x7FFFFFFFFFFFFFFF */
  unsigned long long all_ones  = ~0ULL;               /* 0xFFFFFFFFFFFFFFFF */
  unsigned long long not_one   = ~1ULL;               /* 0xFFFFFFFFFFFFFFFE */

  printf("sign_mask: %llx\n", sign_mask);
  printf("~sign_mask: %llx\n", not_sign);
  printf("~0ULL: %llx\n", all_ones);
  printf("~1ULL: %llx\n", not_one);

  /* Sanity: ~sign_mask < sign_mask (both as unsigned). */
  printf("not_sign < sign_mask: %d\n", not_sign < sign_mask);
  /* Sanity: not_sign + 1 == sign_mask. */
  printf("not_sign + 1 == sign_mask: %d\n", not_sign + 1ULL == sign_mask);
  return 0;
}
