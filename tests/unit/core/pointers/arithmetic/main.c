#include <stdio.h>

void someFunc() {
  int x[128];
  int *start = &x[0];
  int *end = &x[sizeof(x) / sizeof(x[0])];
  /* Assert the pointer-arithmetic relationships, not the absolute stack
   * addresses (those depend on memory layout / argv0 length and aren't
   * reproducible across compiler changes or test runners). */
  printf("%d\n", (int)(sizeof(x) / sizeof(x[0])));    /* element count: 128 */
  printf("%d\n", (int)(end - start));                 /* pointer diff:  128 */
  printf("%d\n", (int)((char *)end - (char *)start)); /* byte span:     512 */
}

int main() {
  someFunc();
  return 0;
}
