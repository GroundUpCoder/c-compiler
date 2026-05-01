// Test various integer promotion scenarios
#include <stdio.h>

int main() {
  // Test 1: Ternary with char types - should promote to int
  char c1 = 100;
  short s1 = 200;
  // Both branches undergo usual arithmetic conversions
  // char and short both promote to int
  // So (1 ? c1 : s1) has type int, value 100
  // And (0 ? c1 : s1) has type int, value 200
  // Sum = 300
  int ternary_sum = (1 ? c1 : s1) + (0 ? c1 : s1);
  if (ternary_sum == 300) {
    printf("PASS: ternary promotes char/short to int\n");
  } else {
    printf("FAIL: ternary_sum should be 300, got %d\n", ternary_sum);
  }

  // Test 2: Compound assignment with overflow
  // char x = 100; x += 100; should be: x = (char)((int)x + (int)100)
  // (int)100 + (int)100 = 200, then truncated to signed char = -56
  signed char sc = 100;
  sc += 100;
  if (sc == -56) {
    printf("PASS: compound assignment truncates to char\n");
  } else {
    printf("FAIL: sc should be -56, got %d\n", (int)sc);
  }

  // Test 3: Bitwise operations with mixed char types
  unsigned char uc = 0xFF;
  signed char sc2 = -1;
  // Both promote to int: (int)255 & (int)(-1) = 255
  int bitand_result = uc & sc2;
  if (bitand_result == 255) {
    printf("PASS: bitwise AND with promotion\n");
  } else {
    printf("FAIL: bitwise AND should be 255, got %d\n", bitand_result);
  }

  // Test 4: Shift with char
  unsigned char uc2 = 1;
  int shifted = uc2 << 24;
  if (shifted == 16777216) {
    printf("PASS: shift promotes char to int\n");
  } else {
    printf("FAIL: shift should be 16777216, got %d\n", shifted);
  }

  // Test 5: Float to double promotion in variadic args
  float f = 1.5f;
  printf("float printf: %f\n", f);

  return 0;
}
