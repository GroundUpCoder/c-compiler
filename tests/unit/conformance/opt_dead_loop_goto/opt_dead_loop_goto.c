// BUG: dead-branch folding deleted labels targeted by goto; the program
// then hung forever in the irreducible dispatch loop.
// C11: 6.8.6.1 -- goto may target any label in the function; a while(0)
// body containing a label is reachable through it.
// EXPECT: prints x=42 (clang-verified). Runner timeout guards regressions.
#include <stdio.h>
int main(void) {
  int x = 0;
  goto in;
  while (0) {
in: x = 42;
  }
  printf("x=%d\n", x);
  return 0;
}
