// Test: TLSF bucket mapping bug for small sizes
//
// The TLSF implementation maps all block sizes 16-31 to the same
// bucket (fl=0, sl=0). This means a 16-byte free block can be
// returned for a 24-byte request (malloc(9..16)), giving only
// 8 bytes of payload when the caller expects 16.
//
// Scenario:
//   1. malloc(24) x2 -> two 32-byte blocks A, B
//   2. free(A) -> 32-byte free block
//   3. malloc(8) -> splits A into 16(used) + 16(free remainder)
//   4. malloc(16) -> needs 24 bytes, but gets the 16-byte remainder
//   5. Writing 16 bytes overflows 8 bytes into B's block header
//   6. Freeing corrupted blocks crashes
#include <stdio.h>
#include <stdlib.h>

int main() {
  // Create two adjacent 32-byte blocks
  char *p1 = (char *)malloc(24);  // adjusted = 32
  char *p2 = (char *)malloc(24);  // adjusted = 32
  if (!p1 || !p2) { printf("FAIL: initial malloc\n"); return 1; }

  // Fill p2 with known data
  int i = 0;
  while (i < 24) { p2[i] = 'X'; i = i + 1; }

  // Free p1 -> 32-byte free block
  free(p1);

  // malloc(8) splits the 32-byte block into 16(used) + 16(free)
  char *p3 = (char *)malloc(8);
  if (!p3) { printf("FAIL: malloc(8)\n"); return 1; }

  // malloc(16) needs 24 bytes total (16 + 8 overhead).
  // BUG: finds the 16-byte remainder in bucket (0,0), returns it
  // even though it only has 8 bytes of payload.
  char *p4 = (char *)malloc(16);
  if (!p4) { printf("FAIL: malloc(16)\n"); return 1; }

  // Verify p4 has enough space: write 16 bytes
  // If the bug exists, bytes 9-16 overflow into p2's block header
  i = 0;
  while (i < 16) { p4[i] = 'A' + i; i = i + 1; }

  // Verify p2 data integrity
  i = 0;
  while (i < 24) {
    if (p2[i] != 'X') {
      printf("FAIL: p2 data corrupted at byte %d\n", i);
      return 1;
    }
    i = i + 1;
  }

  // Free everything - corrupted headers will crash here
  free(p3);
  free(p4);
  free(p2);

  printf("ALL TESTS PASSED\n");
  return 0;
}
