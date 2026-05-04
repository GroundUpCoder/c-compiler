#include <stdio.h>

__struct Point { int x; int y; };

int main(void) {
  __struct Point *p = __new(__struct Point *, 1, 2);

  // typeof on a GC ref
  typeof(p) p2 = __new(__struct Point *, 3, 4);
  printf("%d %d\n", p2->x, p2->y);

  // typeof on a GC array
  __array(int) arr = __new_array(int, 10, 20, 30);
  typeof(arr) arr2 = __new_array(int, 100, 200);
  printf("%d %d\n", arr2[0], arr2[1]);

  // typeof on a field
  typeof(p->x) fv = 42;
  printf("%d\n", fv);

  // typeof on an array element
  typeof(arr[0]) elem = 999;
  printf("%d\n", elem);

  // typeof in a typedef for a complex GC type
  typedef typeof(__new_array(__struct Point *, __new(__struct Point *, 5, 6))) PointArr;
  PointArr pa = __new_array(__struct Point *, __new(__struct Point *, 7, 8));
  printf("%d %d\n", pa[0]->x, pa[0]->y);

  return 0;
}
