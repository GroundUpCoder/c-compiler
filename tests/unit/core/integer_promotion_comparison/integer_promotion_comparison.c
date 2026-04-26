// Test integer promotion rules in comparisons
// According to C standard:
// 1. char/short are promoted to int before comparison
// 2. If one operand is unsigned int and other is signed int,
//    both are converted to unsigned int

#include <stdio.h>

int main() {
  // Test 1: unsigned char vs int
  // unsigned char should be promoted to int (since all uchar values fit in int)
  unsigned char uc = 255;
  int i = -1;

  // 255 promoted to int (still 255), compared with -1
  // 255 > -1 should be true (signed comparison)
  if (uc > i) {
    printf("PASS: uc(255) > i(-1)\n");
  } else {
    printf("FAIL: uc(255) > i(-1) should be true\n");
  }

  // Test with operands swapped
  if (i < uc) {
    printf("PASS: i(-1) < uc(255)\n");
  } else {
    printf("FAIL: i(-1) < uc(255) should be true\n");
  }

  // Test 2: int vs unsigned int
  // Both converted to unsigned int per C standard
  int si = -1;
  unsigned int ui = 1;

  // -1 as unsigned is UINT_MAX, which is > 1
  if (si > ui) {
    printf("PASS: si(-1) > ui(1) when converted to unsigned\n");
  } else {
    printf("FAIL: si(-1) > ui(1) - should be true after unsigned conversion\n");
  }

  // And the reverse
  if (ui < si) {
    printf("PASS: ui(1) < si(-1) when converted to unsigned\n");
  } else {
    printf("FAIL: ui(1) < si(-1) - should be true after unsigned conversion\n");
  }

  // Test 3: signed char vs int (both signed, should work)
  signed char sc = -1;
  int j = 0;
  if (sc < j) {
    printf("PASS: sc(-1) < j(0)\n");
  } else {
    printf("FAIL: sc(-1) < j(0) should be true\n");
  }

  return 0;
}
