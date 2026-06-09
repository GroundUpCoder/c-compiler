/* Regression: a global array initializer with >~62K elements crashed
 * the compiler with RangeError (argument spread over all children). */
#include <stdio.h>
int big[400000] = { 1, 2, 3 };
short wide[100000];
int main(void) {
  printf("%d %d %d %zu\n", big[0], big[2], big[399999], sizeof big);
  printf("%zu\n", sizeof wide);
  return 0;
}
