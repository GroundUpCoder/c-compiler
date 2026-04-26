#include <stdio.h>

// _Pragma in a macro is the main use case
#define INCLUDE_ONCE _Pragma("once")

// Test that _Pragma("once") works (this file should compile without issues)
_Pragma("once")

int main(void) {
  printf("_Pragma ok\n");
  return 0;
}
