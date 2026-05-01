// Test that switch expression is evaluated exactly once
// C standard requires the controlling expression to be evaluated only once

#include <stdio.h>

int call_count = 0;

int get_value(void) {
  call_count++;
  return 2;  // Return a value that matches case 2
}

int main(void) {
  switch (get_value()) {
    case 1:
      printf("case 1\n");
      break;
    case 2:
      printf("case 2\n");
      break;
    case 3:
      printf("case 3\n");
      break;
    default:
      printf("default\n");
      break;
  }

  printf("call_count = %d\n", call_count);

  // Per C standard, get_value() should be called exactly once
  if (call_count != 1) {
    printf("BUG: switch expression evaluated %d times instead of 1\n", call_count);
    return 1;
  }

  return 0;
}
