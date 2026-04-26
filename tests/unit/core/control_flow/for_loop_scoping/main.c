// Regression test: for-loop init declarations get their own scope.
//
// In C99+, `for (int i = 0; ...)` scopes `i` to the loop. After the
// loop ends, `i` goes out of scope. A second `for (int i = 0; ...)`
// creates a fresh variable.

#include <stdio.h>

// Two consecutive for-loops with the same loop variable name.
void test_consecutive() {
  int sum1 = 0;
  for (int i = 0; i < 3; i++) {
    sum1 += i;
  }
  int sum2 = 0;
  for (int i = 0; i < 3; i++) {
    sum2 += i;
  }
  printf("consecutive: sum1=%d sum2=%d\n", sum1, sum2);
}

// Nested for-loops with the same variable name.
// Inner loop's variable should not affect the outer loop.
void test_nested() {
  int outer_sum = 0;
  for (int i = 0; i < 3; i++) {
    for (int i = 0; i < 2; i++) {
      // inner loop
    }
    outer_sum += i;
  }
  printf("nested: outer_sum=%d\n", outer_sum);
}

// Three consecutive for-loops.
void test_three_consecutive() {
  int a = 0, b = 0, c = 0;
  for (int i = 0; i < 5; i++) a += i;
  for (int i = 0; i < 5; i++) b += i;
  for (int i = 0; i < 5; i++) c += i;
  printf("three: a=%d b=%d c=%d\n", a, b, c);
}

int main() {
  test_consecutive();
  test_nested();
  test_three_consecutive();
  return 0;
}
