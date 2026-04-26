#include <stdio.h>

void test_if_else() {
  printf("=== If/else ===\n");
  // Basic if
  if (1) printf("yes\n");
  if (0) printf("no\n");

  // If-else
  if (1)
    printf("a\n");
  else
    printf("b\n");

  if (0)
    printf("a\n");
  else
    printf("b\n");

  // If-else chain
  int x = 2;
  if (x == 1)
    printf("one\n");
  else if (x == 2)
    printf("two\n");
  else if (x == 3)
    printf("three\n");
  else
    printf("other\n");
}

void test_nested_if() {
  printf("=== Nested if ===\n");
  for (int i = 0; i < 4; i++) {
    if (i < 2) {
      if (i == 0)
        printf("zero\n");
      else
        printf("one\n");
    } else {
      if (i == 2)
        printf("two\n");
      else
        printf("three\n");
    }
  }
}

void test_ternary() {
  printf("=== Ternary ===\n");
  printf("%d\n", 1 ? 10 : 20);  // 10
  printf("%d\n", 0 ? 10 : 20);  // 20

  // Nested ternary
  for (int i = 0; i < 4; i++) {
    printf("%s\n", i == 0 ? "zero" : i == 1 ? "one" : i == 2 ? "two" : "other");
  }

  // Ternary as lvalue argument
  int a = 5;
  int b = 10;
  printf("%d\n", (a > b) ? a : b);  // 10

  // Ternary short circuit: only one branch should be evaluated
  int x = 0;
  int y = 0;
  1 ? (x = 1) : (y = 1);
  printf("x=%d y=%d\n", x, y);  // x=1 y=0

  x = 0;
  y = 0;
  0 ? (x = 1) : (y = 1);
  printf("x=%d y=%d\n", x, y);  // x=0 y=1
}

void test_logical_short_circuit() {
  printf("=== Short circuit ===\n");
  int x = 0;

  // && short circuits on false
  if (0 && (x = 1)) {
  }
  printf("x=%d\n", x);  // 0

  // && evaluates second on true
  if (1 && (x = 2)) {
  }
  printf("x=%d\n", x);  // 2

  // || short circuits on true
  x = 0;
  if (1 || (x = 3)) {
  }
  printf("x=%d\n", x);  // 0

  // || evaluates second on false
  if (0 || (x = 4)) {
  }
  printf("x=%d\n", x);  // 4
}

void test_truthiness() {
  printf("=== Truthiness ===\n");
  // Non-zero integers are truthy
  if (42) printf("42 is truthy\n");
  if (-1) printf("-1 is truthy\n");
  if (0)
    printf("this should not print\n");
  else
    printf("0 is falsy\n");

  // Pointer truthiness
  int x = 5;
  int *p = &x;
  if (p) printf("non-null is truthy\n");

  // Not operator
  printf("!0=%d\n", !0);    // 1
  printf("!1=%d\n", !1);    // 0
  printf("!42=%d\n", !42);  // 0
}

int main() {
  test_if_else();
  test_nested_if();
  test_ternary();
  test_logical_short_circuit();
  test_truthiness();
  return 0;
}
