#include <stdio.h>

__struct Pt { int x; int y; };

int main(void) {
  // Primitives
  __array(int) a = __new_array(int, 10, 20, 30, 40, 50);
  for (int i = 0; i < __array_len(a); i++) printf("%d ", a[i]);
  printf("\n");

  __array(double) d = __new_array(double, 1.5, 2.5, 3.5);
  for (int i = 0; i < __array_len(d); i++) printf("%g ", d[i]);
  printf("\n");

  // Empty
  __array(int) e = __new_array(int);
  printf("empty: %d\n", __array_len(e));   // 0

  // GC ref elements — element type spelled with '*' to match the pointer-form
  // convention. This way ps[i] reads as a __struct Pt * and ps[i]->x reads
  // naturally. Note __new_array's first arg is also the element type, so it
  // gets the '*' too.
  __array(__struct Pt *) ps = __new_array(__struct Pt *,
    __new(__struct Pt *, 1, 2),
    __new(__struct Pt *, 3, 4),
    __new(__struct Pt *, 5, 6));
  for (int i = 0; i < __array_len(ps); i++) printf("(%d,%d) ", ps[i]->x, ps[i]->y);
  printf("\n");

  // Implicit conversions of args
  __array(double) m = __new_array(double, 1, 2, 3);  // ints → doubles
  for (int i = 0; i < __array_len(m); i++) printf("%g ", m[i]);
  printf("\n");

  return 0;
}
