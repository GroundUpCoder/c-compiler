#include <stdio.h>

void test_for() {
  printf("=== For loops ===\n");
  // Basic for
  for (int i = 0; i < 5; i++) {
    printf("%d ", i);
  }
  printf("\n");

  // Counting sum
  int sum = 0;
  for (int i = 1; i <= 10; i++) {
    sum += i;
  }
  printf("sum 1..10 = %d\n", sum);

  // Nested for
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      printf("%d", i * 3 + j);
    }
  }
  printf("\n");

  // No init, no increment
  int x = 0;
  for (; x < 3;) {
    printf("%d ", x);
    x++;
  }
  printf("\n");

  // Converging counters
  int a = 0;
  int b = 10;
  while (a < b) {
    printf("%d:%d ", a, b);
    a++;
    b--;
  }
  printf("\n");
}

void test_while() {
  printf("=== While loops ===\n");
  // Basic while
  int i = 0;
  while (i < 5) {
    printf("%d ", i);
    i++;
  }
  printf("\n");

  // Condition false from start
  int entered = 0;
  while (0) {
    entered = 1;
  }
  printf("entered=%d\n", entered); // 0
}

void test_do_while() {
  printf("=== Do-while loops ===\n");
  // Basic do-while
  int i = 0;
  do {
    printf("%d ", i);
    i++;
  } while (i < 5);
  printf("\n");

  // Executes at least once even if condition is false
  int count = 0;
  do {
    count++;
  } while (0);
  printf("count=%d\n", count); // 1
}

void test_break_continue() {
  printf("=== Break and continue ===\n");
  // Break from for
  for (int i = 0; i < 100; i++) {
    if (i == 5) break;
    printf("%d ", i);
  }
  printf("\n");

  // Continue in for
  for (int i = 0; i < 10; i++) {
    if (i % 2 != 0) continue;
    printf("%d ", i);
  }
  printf("\n");

  // Break from while
  int i = 0;
  while (1) {
    if (i >= 3) break;
    printf("%d ", i);
    i++;
  }
  printf("\n");

  // Continue in while
  i = 0;
  while (i < 10) {
    i++;
    if (i % 3 != 0) continue;
    printf("%d ", i);
  }
  printf("\n");

  // Break from do-while
  i = 0;
  do {
    if (i == 4) break;
    printf("%d ", i);
    i++;
  } while (1);
  printf("\n");

  // Nested break (inner only)
  for (int a = 0; a < 3; a++) {
    for (int b = 0; b < 3; b++) {
      if (b == 1) break;
      printf("(%d,%d) ", a, b);
    }
  }
  printf("\n");

  // Nested continue (inner only)
  for (int a = 0; a < 3; a++) {
    for (int b = 0; b < 3; b++) {
      if (b == 1) continue;
      printf("(%d,%d) ", a, b);
    }
  }
  printf("\n");
}

int main() {
  test_for();
  test_while();
  test_do_while();
  test_break_continue();
  return 0;
}
