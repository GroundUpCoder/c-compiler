#include <stdio.h>

int main(void) {
  int x = 42;

  // typeof(expr)
  typeof(x) y = x + 1;
  printf("%d\n", y);

  // typeof(type)
  typeof(double) d = 3.14;
  printf("%g\n", d);

  // typeof preserves array type (no decay)
  int arr[5] = {1, 2, 3, 4, 5};
  typeof(arr) arr2;
  for (int i = 0; i < 5; i++) arr2[i] = arr[i] * 10;
  printf("%d %d\n", arr2[0], arr2[4]);

  // typeof_unqual strips top-level qualifiers
  const int cx = 7;
  typeof_unqual(cx) mx = cx;
  mx = mx + 1;
  printf("%d\n", mx);

  // typeof preserves qualifiers
  typeof(cx) cy = 99;
  printf("%d\n", cy);
  // (would error to write cy = ... since it's const)

  // typeof in pointer context
  int n = 5;
  typeof(n) *pn = &n;
  printf("%d\n", *pn);

  // GCC __typeof__ alias works
  __typeof__(x) z = x * 2;
  printf("%d\n", z);
  __typeof(x) w = x * 3;
  printf("%d\n", w);

  // typeof(expr) doesn't evaluate the expression
  int counter = 0;
  typeof(counter++) tx = 100;
  printf("counter=%d, tx=%d\n", counter, tx);

  // typeof in function return position via typedef
  typedef typeof(3.14) my_double;
  my_double md = 2.71;
  printf("%g\n", md);

  return 0;
}
