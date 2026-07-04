// BUG: sscanf %u rejects a leading minus sign (returns 0 matches) instead of accepting it with strtoul wraparound.
// C11: 7.21.6.2p12 — the u conversion matches an optionally signed decimal integer with the same subject sequence as strtoul; strtoul ("-5") negates in unsigned arithmetic giving UINT_MAX-4.
// EXPECT: "1 4294967291\n" (verified against native clang).
#include <stdio.h>

int main(void) {
  unsigned u = 99;
  int r = sscanf("-5", "%u", &u);
  printf("%d %u\n", r, u);
  return 0;
}
