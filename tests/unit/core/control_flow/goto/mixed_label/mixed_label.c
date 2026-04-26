// A label can be both a forward and backward goto target
#include <stdio.h>
int main() {
  int x = 0;
  goto target;
target:
  x++;
  if (x < 3)
    goto target;
  printf("%d\n", x);
  return 0;
}
