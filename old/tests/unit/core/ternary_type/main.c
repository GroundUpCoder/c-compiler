// Test ternary operator result type (Usual Arithmetic Conversions)
// Bug: compiler uses then-branch type, ignoring else-branch

#include <stdio.h>

int main() {
  // Test 1: int vs double - should use double as result type
  // Standard C: 0 ? 1 : 2.5 has type double, result is 2.5
  // Bug: result type is int (from '1'), 2.5 converted to 2
  double x = 0 ? 1 : 2.5;
  printf("test1: %f (expect 2.500000)\n", x);

  // Test 2: Same but with true condition
  // Should still be double type, result is 1.0
  double y = 1 ? 1 : 2.5;
  printf("test2: %f (expect 1.000000)\n", y);

  // Test 3: double in then-branch, int in else
  // Standard C: result type is double
  double z = 0 ? 2.5 : 1;
  printf("test3: %f (expect 1.000000)\n", z);

  // Test 4: float vs double
  float f = 1.5f;
  double d = 2.5;
  double w = 0 ? f : d;
  printf("test4: %f (expect 2.500000)\n", w);

  // Test 5: char vs int (should promote to int)
  char c = 100;
  int i = 1000;
  int v = 0 ? c : i;
  printf("test5: %d (expect 1000)\n", v);

  return 0;
}
