#include <stdio.h>

// Basic switch with break
int day_kind(int day) {
  switch (day) {
    case 0: return 0; // sunday
    case 6: return 0; // saturday
    case 1: case 2: case 3: case 4: case 5:
      return 1; // weekday
    default:
      return -1;
  }
}

// Fall-through behavior
void test_fallthrough() {
  printf("=== Fall-through ===\n");
  for (int i = 0; i < 5; i++) {
    int count = 0;
    switch (i) {
      case 0: count++;
      case 1: count++;
      case 2: count++;
      default: count++;
    }
    printf("i=%d count=%d\n", i, count);
  }
}

// Switch with break
void test_break() {
  printf("=== Break ===\n");
  for (int i = 0; i < 5; i++) {
    switch (i) {
      case 0: printf("zero\n"); break;
      case 1: printf("one\n"); break;
      case 2: printf("two\n"); break;
      default: printf("other\n"); break;
    }
  }
}

// Nested switch
void test_nested_switch() {
  printf("=== Nested switch ===\n");
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      switch (i) {
        case 0:
          switch (j) {
            case 0: printf("(0,0)\n"); break;
            case 1: printf("(0,1)\n"); break;
            default: printf("(0,?)\n"); break;
          }
          break;
        case 1: printf("(1,%d)\n", j); break;
        default: printf("(?,%d)\n", j); break;
      }
    }
  }
}

// Switch on expressions and negative values
void test_expressions() {
  printf("=== Expressions ===\n");
  int x = 10;
  switch (x - 8) {
    case 1: printf("wrong\n"); break;
    case 2: printf("correct\n"); break;
    case 3: printf("wrong\n"); break;
    default: printf("wrong\n"); break;
  }

  switch (-1) {
    case -1: printf("neg one\n"); break;
    case 0: printf("zero\n"); break;
    default: printf("other\n"); break;
  }
}

// Switch returning values
int classify(int x) {
  switch (x) {
    case 0: return 0;
    case 1: case 2: case 3: return 1;
    case 4: case 5: case 6: return 2;
    default: return 3;
  }
}

void test_classify() {
  printf("=== Classify ===\n");
  for (int i = 0; i < 8; i++) {
    printf("classify(%d)=%d\n", i, classify(i));
  }
}

// Default in the middle
void test_default_middle() {
  printf("=== Default in middle ===\n");
  for (int i = 0; i < 4; i++) {
    switch (i) {
      case 0: printf("zero\n"); break;
      default: printf("default\n"); break;
      case 2: printf("two\n"); break;
      case 3: printf("three\n"); break;
    }
  }
}

// Empty switch body / no matching case
void test_no_match() {
  printf("=== No match ===\n");
  int x = 99;
  int reached = 0;
  switch (x) {
    case 0: reached = 1; break;
    case 1: reached = 2; break;
  }
  printf("reached=%d\n", reached); // 0 - no default
}

// Factorial using switch (from original test)
int factorial(int n) {
  switch (n) {
    case 0:
    case 1:
      return 1;
    default:
      return n * factorial(n - 1);
  }
}

int main() {
  printf("=== Day kind ===\n");
  printf("%d\n", day_kind(0));  // 0
  printf("%d\n", day_kind(3));  // 1
  printf("%d\n", day_kind(6));  // 0
  printf("%d\n", day_kind(9));  // -1

  test_fallthrough();
  test_break();
  test_nested_switch();
  test_expressions();
  test_classify();
  test_default_middle();
  test_no_match();

  printf("=== Factorial ===\n");
  printf("%d\n", factorial(0));  // 1
  printf("%d\n", factorial(1));  // 1
  printf("%d\n", factorial(6));  // 720

  return 0;
}
